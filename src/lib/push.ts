import webpush from 'web-push'
import { supabase } from './supabase'
import { logger } from './logger'

/**
 * Web push, driven directly rather than through a vendor SDK.
 *
 * Three specs working together: RFC 8030 is the delivery protocol, RFC 8291 is
 * the payload encryption, RFC 8292 is VAPID — the scheme that identifies this
 * server to the push service. The `web-push` package implements the crypto;
 * what is here is the part that is ours.
 *
 * This exists because every other channel needs a live tab. SSE and the poll
 * both die with the page, so a lawyer whose phone is in their pocket cannot be
 * rung — which is most of the time. A push wakes a service worker with no page
 * in existence, and is the only thing that does.
 */

const publicKey = process.env.VAPID_PUBLIC_KEY
const privateKey = process.env.VAPID_PRIVATE_KEY
const subject = process.env.VAPID_SUBJECT || 'mailto:contact@legalxonline.com'

/** False when the keys are unset, so callers can degrade instead of throwing. */
export const pushConfigured = Boolean(publicKey && privateKey)

if (pushConfigured) {
  webpush.setVapidDetails(subject, publicKey!, privateKey!)
} else {
  logger.warn({}, '[push] VAPID keys not set — push notifications disabled')
}

export function vapidPublicKey(): string | null {
  return publicKey ?? null
}

export interface PushPayload {
  title: string
  body: string
  /** Opened when the notification is clicked. */
  url?: string
  /** Groups replacements: a second ring for one call replaces the first. */
  tag?: string
  /** Set for a call so the worker can present it as urgent rather than routine. */
  kind?: 'call' | 'info'
}

/**
 * Sends to every device registered for an account.
 *
 * Never throws: a notification failing must not fail the call it accompanies.
 * A 404 or 410 is the push service saying the subscription is dead — that is
 * the documented way it tells you, and the row is deleted rather than retried
 * forever against an endpoint that will never answer again.
 */
export async function sendPushToAccount(accountId: string, payload: PushPayload): Promise<number> {
  if (!pushConfigured) return 0

  const { data: subs, error } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('account_id', accountId)

  if (error) {
    logger.error({ err: error.message, accountId }, '[push] could not read subscriptions')
    return 0
  }
  if (!subs?.length) return 0

  const body = JSON.stringify(payload)
  let delivered = 0
  const dead: string[] = []

  await Promise.all(subs.map(async sub => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body,
        {
          // A ring is worthless once the twenty-second window has passed, so it
          // is not worth queueing on a device that is offline right now.
          TTL: payload.kind === 'call' ? 25 : 3600,
          urgency: payload.kind === 'call' ? 'high' : 'normal',
        }
      )
      delivered += 1
    } catch (err: unknown) {
      const status = (err as { statusCode?: number })?.statusCode
      if (status === 404 || status === 410) {
        dead.push(sub.id)
      } else {
        logger.warn({ status, accountId }, '[push] send failed')
      }
    }
  }))

  if (dead.length) {
    await supabase.from('push_subscriptions').delete().in('id', dead)
    logger.info({ count: dead.length }, '[push] removed dead subscriptions')
  }

  return delivered
}
