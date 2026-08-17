/**
 * Keep-Alive Cron Job
 *
 * Render's free tier spins down after 15 minutes of inactivity.
 * This module pings our own /health endpoint every 13 minutes so the
 * server stays warm 24/7 without needing an external ping service.
 *
 * Only runs when NODE_ENV === 'production'.
 */

import { logger } from './logger'

const INTERVAL_MS = 13 * 60 * 1000 // 13 minutes — just under Render's 15-min timeout

export function startKeepAlive(publicUrl: string): void {
  if (process.env.NODE_ENV !== 'production') {
    logger.info('[keepAlive] Skipped — not in production mode')
    return
  }

  if (!publicUrl) {
    logger.warn('[keepAlive] RENDER_EXTERNAL_URL not set — keep-alive disabled')
    return
  }

  const healthUrl = `${publicUrl}/health`
  logger.info({ healthUrl, intervalMs: INTERVAL_MS }, '[keepAlive] Self-ping cron started')

  setInterval(async () => {
    try {
      const start = Date.now()
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(10_000) })
      const latency = Date.now() - start
      const body = await res.json() as { database?: { status: string } }

      if (res.ok) {
        logger.info({ latency: `${latency}ms`, db: body?.database?.status }, '[keepAlive] Ping OK')
      } else {
        logger.warn({ status: res.status, latency: `${latency}ms` }, '[keepAlive] Ping returned non-200')
      }
    } catch (err) {
      logger.error({ err }, '[keepAlive] Ping failed')
    }
  }, INTERVAL_MS)
}
