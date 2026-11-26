import { Router, Request, Response } from 'express'
import { logger } from '../lib/logger'
import { supabase } from '../lib/supabase'
import { FEED_SOURCES } from '../lib/sources/rss'
import { requireJobSecret } from '../lib/auth'
import { sweepAction } from '../lib/consultation'
import { settleConsultation } from './consultations'

const router = Router()

/**
 * Machine-to-machine endpoints for the scheduled jobs.
 *
 * Mounted OUTSIDE the CSRF-protected routers on purpose. CSRF defends
 * cookie-authenticated browser requests; these are authenticated solely by a
 * shared secret in a custom header, which a cross-origin page cannot set
 * without a CORS preflight the server never approves. Adding a CSRF exemption
 * to the admin router instead would have let an attacker skip CSRF by sending
 * a bogus secret and falling back to cookie auth.
 *
 * requireJobSecret is in lib/auth.ts and reads `x-admin-secret` specifically.
 */

// ── POST /api/jobs/sweep-consultations ───────────────────────────────────────
/**
 * Closes the consultations nobody closed. [PAY-05]
 *
 * A call only settles when someone presses end. Anything else — a killed app,
 * a closed laptop, a ring nobody answered — leaves the row open forever. The
 * live table had six sitting pending for seventy to eighty-five days, one of
 * them still holding credit reserved against a client's balance.
 *
 * settleConsultation already knows both cases: no started_at is a missed call
 * and free, and a started one bills the time actually used. This only decides
 * which rows have waited long enough, and that rule is tested.
 */
router.post('/sweep-consultations', requireJobSecret, async (_req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('consultations')
      .select('id, status, started_at, created_at')
      .in('status', ['pending', 'in_progress'])
      .limit(500)

    if (error) throw error

    const now = Date.now()
    let cancelled = 0
    let settled = 0
    const failures: string[] = []

    for (const row of data ?? []) {
      const action = sweepAction(row, now)
      if (!action) continue
      try {
        // One failure must not abandon the rest of the sweep.
        await settleConsultation(row.id)
        if (action === 'settle') settled++
        else cancelled++
      } catch (err) {
        failures.push(row.id)
        logger.error({ err, consultationId: row.id }, '[sweep] could not settle')
      }
    }

    logger.info({ examined: data?.length ?? 0, cancelled, settled, failed: failures.length }, '[sweep] done')
    res.json({ ok: true, examined: data?.length ?? 0, cancelled, settled, failed: failures.length })
  } catch (err) {
    logger.error({ err }, '[sweep] failed')
    res.status(500).json({ error: 'Sweep failed' })
  }
})

// ── POST /api/jobs/retention ─────────────────────────────────────────────────
// Housekeeping. Supabase's free tier is 500 MB and three tables grow without
// bound: notifications, audit_log, and the short-lived call-ring table. Left
// alone they would quietly consume the allowance the actual content needs.
//
// Deliberately conservative: audit records are a compliance artefact, so they
// are kept for two years, and only *read* notifications are pruned.
router.post('/retention', requireJobSecret, async (_req: Request, res: Response) => {
  const now = Date.now()
  const daysAgo = (n: number) => new Date(now - n * 86_400_000).toISOString()

  const results: Record<string, number | string> = {}

  const prune = async (
    label: string,
    run: () => Promise<{ count: number | null; error: any }>
  ) => {
    try {
      const { count, error } = await run()
      results[label] = error ? `error: ${error.message}` : (count ?? 0)
    } catch (err: any) {
      results[label] = `error: ${err?.message ?? 'unknown'}`
    }
  }

  // Read notifications older than 60 days: the user has seen them.
  await prune('notifications_read', async () =>
    supabase.from('notifications').delete({ count: 'exact' })
      .eq('is_read', true).lt('created_at', daysAgo(60)))

  // Unread ones linger longer — but a year-old unread notice helps nobody.
  await prune('notifications_unread', async () =>
    supabase.from('notifications').delete({ count: 'exact' })
      .eq('is_read', false).lt('created_at', daysAgo(365)))

  // A signup code is good for ten minutes. An hour is generous, and keeps the
  // table from growing on abandoned signups.
  await prune('pending_signups', async () =>
    supabase.from('pending_signups').delete({ count: 'exact' })
      .lt('created_at', new Date(now - 3_600_000).toISOString()))

  // Ring signals expire in seconds; anything from yesterday is dead weight.
  await prune('call_rings', async () =>
    supabase.from('consultation_notifications').delete({ count: 'exact' })
      .lt('created_at', daysAgo(1)))

  // Rejected shorts keep their decision record but not their source text.
  await prune('rejected_source_text', async () =>
    supabase.from('shorts_cards').update({ raw_source: null }, { count: 'exact' })
      .eq('review_status', 'rejected').not('raw_source', 'is', null))

  await prune('audit_log', async () =>
    supabase.from('audit_log').delete({ count: 'exact' }).lt('created_at', daysAgo(730)))

  logger.info({ results }, '[jobs] retention sweep complete')
  res.json({ ok: true, results })
})

// ── GET /api/jobs/health ─────────────────────────────────────────────────────
// Lets the scheduled workflow confirm credentials and configuration before it
// tries a real run — a 200 here means the secret is right.
router.get('/health', requireJobSecret, (_req: Request, res: Response) => {
  res.json({
    ok: true,
    summariser: !!(process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY),
    provider: process.env.SHORTS_LLM_PROVIDER ?? 'groq',
    feeds: FEED_SOURCES.filter(f => f.enabled).map(f => f.id),
  })
})

export default router
