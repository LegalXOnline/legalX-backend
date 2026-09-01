import { Router, Request, Response, NextFunction } from 'express'
import crypto from 'crypto'
import { logger } from '../lib/logger'
import { runIngest } from '../lib/shortsPipeline'
import { FEED_SOURCES } from '../lib/sources/rss'

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
 */
function requireJobSecret(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.ADMIN_SECRET
  if (!expected) {
    logger.error({}, '[jobs] ADMIN_SECRET is not set — job endpoints disabled')
    return res.status(503).json({ error: 'Job endpoints are not configured' })
  }

  const provided = req.headers['x-admin-secret']
  if (typeof provided !== 'string') {
    return res.status(401).json({ error: 'Missing job credentials' })
  }

  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    logger.warn({ reqId: req.id, ip: req.ip }, '[jobs] bad secret')
    return res.status(401).json({ error: 'Invalid job credentials' })
  }

  next()
}

// ── POST /api/jobs/shorts-daily ──────────────────────────────────────────────
// Run by the scheduled workflow once a day. Proposes a batch of suggestions
// from the enabled feeds for an editor to curate.
//
// Cards are created pending. Nothing reaches the public feed without a human
// approving it in the admin portal.
router.post('/shorts-daily', requireJobSecret, async (req: Request, res: Response) => {
  // Propose more than will be published — the editor keeps the best few.
  const target = Math.min(Math.max(Number(req.body?.target) || 8, 1), 20)

  try {
    const report = await runIngest({ target, feeds: req.body?.feeds })
    logger.info(
      { proposed: report.proposed, skipped: report.skipped.length, failed: report.failed.length },
      '[jobs] shorts-daily complete'
    )
    res.json(report)
  } catch (err: any) {
    const message = err?.message ?? 'unknown'
    logger.error({ err: message }, '[jobs] shorts-daily failed')
    // 5xx so the scheduled run is marked failed and someone notices, rather
    // than the feed quietly going stale for a week.
    res.status(500).json({ error: message })
  }
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
