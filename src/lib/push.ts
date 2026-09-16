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


// ── Native push ──────────────────────────────────────────────────────────────
// Web Push does not exist on a phone: Android goes through FCM and iOS through
// APNs. Expo fronts both with one HTTP endpoint and one opaque token, so the
// app needs no Firebase credentials on the server and no APNs key in the repo.

const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send'

interface ExpoTicket {
  status: 'ok' | 'error'
  id?: string
  details?: { error?: string }
}

/**
 * Sends to every installed app for an account.
 *
 * Never throws, for the same reason the web path does not: a notification
 * failing must not fail the call it accompanies. A DeviceNotRegistered ticket
 * is Expo saying the install is gone — that row is deleted rather than retried
 * forever against a token that will never answer.
 */
export async function sendDevicePushToAccount(
  accountId: string,
  payload: PushPayload,
): Promise<number> {
  const { data: rows, error } = await supabase
    .from('device_push_tokens')
    .select('id, token')
    .eq('account_id', accountId)

  if (error || !rows?.length) return 0

  const messages = rows.map(row => ({
    to: row.token as string,
    title: payload.title,
    body: payload.body,
    data: { url: payload.url ?? null, kind: payload.kind ?? 'info' },
    // A ring has to cut through a silent phone; an update does not.
    priority: payload.kind === 'call' ? 'high' : 'normal',
    sound: payload.kind === 'call' ? 'default' : null,
    channelId: payload.kind === 'call' ? 'calls' : 'default',
  }))

  try {
    const res = await fetch(EXPO_PUSH_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
    })

    if (!res.ok) {
      logger.warn({ status: res.status }, '[push] expo send failed')
      return 0
    }

    const body = (await res.json()) as { data?: ExpoTicket[] }
    const tickets = body.data ?? []

    const dead = tickets
      .map((t, i) => (t.details?.error === 'DeviceNotRegistered' ? rows[i].id : null))
      .filter((id): id is string => Boolean(id))

    if (dead.length) {
      await supabase.from('device_push_tokens').delete().in('id', dead)
    }

    return tickets.filter(t => t.status === 'ok').length
  } catch (err) {
    logger.warn({ err }, '[push] expo send threw')
    return 0
  }
}

/**
 * Reaches an account wherever it is registered — browsers and phones.
 *
 * Callers should use this rather than either half: a lawyer with a laptop and
 * a phone should ring on both, and neither caller should have to know which
 * kinds of device exist.
 */
export async function notifyAllDevices(accountId: string, payload: PushPayload): Promise<number> {
  const [web, native] = await Promise.all([
    sendPushToAccount(accountId, payload),
    sendDevicePushToAccount(accountId, payload),
  ])
  return web + native
}
