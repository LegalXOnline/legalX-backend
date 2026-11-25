/**
 * Presence is a lease, not a flag:
 *
 *   online == is_online AND last_seen_at within the window
 *
 * is_online alone stayed true for months after a lawyer stopped opening the
 * dashboard, so clients called advocates who were not there and sat on
 * "Connecting…" forever. The portal renews while it is open; stop renewing and
 * the lease lapses on its own, with no disconnect hook to miss.
 */

/** Three heartbeats of tolerance, so one dropped request is survivable. */
export const PRESENCE_WINDOW_MS = 90_000

/** Derived, so the cadence and the window cannot drift apart. */
export const HEARTBEAT_INTERVAL_MS = PRESENCE_WINDOW_MS / 3

/** The same rule as a timestamp, for filtering in the database. */
export function presenceCutoffIso(now: number = Date.now()): string {
  return new Date(now - PRESENCE_WINDOW_MS).toISOString()
}

/** The lease rule. Every "is this advocate online" goes through here. */
export function isLive(isOnline: unknown, lastSeenAt: unknown, now: number = Date.now()): boolean {
  if (isOnline !== true) return false

  // Seeded rows have never renewed anything. Null means not reachable.
  if (typeof lastSeenAt !== 'string' || lastSeenAt.length === 0) return false

  const seen = Date.parse(lastSeenAt)
  if (!Number.isFinite(seen)) return false

  // Future timestamps are fine — small clock skew should not read as offline.
  return now - seen <= PRESENCE_WINDOW_MS
}

/** Seconds until the lease lapses, 0 if it already has. */
export function secondsRemaining(lastSeenAt: unknown, now: number = Date.now()): number {
  if (typeof lastSeenAt !== 'string') return 0
  const seen = Date.parse(lastSeenAt)
  if (!Number.isFinite(seen)) return 0
  return Math.max(0, Math.ceil((seen + PRESENCE_WINDOW_MS - now) / 1000))
}
