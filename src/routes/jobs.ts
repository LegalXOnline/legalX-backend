import { Router, Request, Response, NextFunction } from 'express'
import crypto from 'crypto'
import { logger } from '../lib/logger'
import { runAutoIngest } from '../lib/shortsPipeline'
import { FEEDS } from '../lib/sources/indiankanoon'

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
// Run by the scheduled workflow once a day. Walks the configured feeds until it
// has produced the day's target number of draft cards, then stops.
//
// Cards are created unpublished. Nothing reaches the public feed without a
// human approving it in the admin portal.
router.post('/shorts-daily', requireJobSecret, async (req: Request, res: Response) => {
  const target = Math.min(Math.max(Number(req.body?.target) || 5, 1), 15)

  // Rotate through feeds so the daily mix isn't five Supreme Court cases in a
  // row — a couple of judgments plus practical citizen-rights topics.
  const order: string[] = Array.isArray(req.body?.feeds) && req.body.feeds.length
    ? req.body.feeds.filter((f: string) => f in FEEDS)
    : ['supreme_court', 'high_courts', 'consumer', 'traffic', 'employment', 'tenancy', 'bns']

  const results: any[] = []
  let created = 0

  for (const feed of order) {
    if (created >= target) break
    try {
      const remaining = target - created
      // At most 2 per feed until the target is nearly met, so one noisy feed
      // cannot fill the whole day.
      const result = await runAutoIngest(feed, Math.min(remaining, 2))
      created += result.created
      results.push(result)
    } catch (err: any) {
      const message = err?.message ?? 'unknown'
      logger.warn({ feed, err: message }, '[jobs] feed failed')
      results.push({ feed, created: 0, failed: 0, error: message })
      // Configuration and quota problems apply to every remaining feed too.
      if (/not configured|rejected the API key|rate limit/i.test(message)) break
    }
  }

  logger.info({ created, target, feeds: results.length }, '[jobs] shorts-daily complete')
  res.json({ created, target, results })
})

// ── GET /api/jobs/health ─────────────────────────────────────────────────────
// Lets the scheduled workflow confirm credentials and configuration before it
// tries a real run — a 200 here means the secret is right.
router.get('/health', requireJobSecret, (_req: Request, res: Response) => {
  res.json({
    ok: true,
    indiankanoon: !!process.env.INDIANKANOON_API_KEY,
    summariser: !!(process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY),
    provider: process.env.SHORTS_LLM_PROVIDER ?? 'groq',
    feeds: Object.keys(FEEDS),
  })
})

export default router
