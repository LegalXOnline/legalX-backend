/**
 * The rules a consultation is governed by: when the clock starts, what the
 * client pays, and what the advocate earns.
 *
 * These lived inline across a 1,300-line route file, which is how the clock
 * came to work on Android and not on the web — the same rule written twice,
 * and only one copy updated. Everything here is pure: no database, no network,
 * no clock of its own. The routes decide what to persist; this decides what is
 * true.
 */

export type ConsultationType = 'chat' | 'voice' | 'video'

/** How a consultation is funded. Decided when it is placed, not at settlement. */
export type Funding = 'credits' | 'paid'

/** The promotional grant every account starts with. Not money: never refundable. */
export const FREE_CREDIT_PAISE = 10_000

/**
 * Minutes at the start of a consultation that earn the advocate nothing.
 *
 * The client is still billed for them — this is a platform margin rule, not a
 * discount — so the two sides of a consultation are deliberately not symmetric.
 */
export const LAWYER_UNPAID_MINUTES = 5

// ── Presence and the billing clock ───────────────────────────────────────────

export interface ClockRow {
  type: string
  client_id: string
  lawyer_id: string
  status: string
  started_at: string | null
  lawyer_joined_at: string | null
  client_joined_at: string | null
}

export interface PresenceDecision {
  lawyer_joined_at?: string
  client_joined_at?: string
  started_at?: string
  status?: string
}

/**
 * What to write when someone reaches the room, and whether that starts the clock.
 *
 * "Both are here" means different things per type, and getting it wrong costs
 * money either way. A chat has no media session to wait for, so both sides
 * having opened the room is the whole signal. Voice and video wait for media
 * to connect, because a caller sitting on "Connecting…" must not be billed for
 * an attempt that never joined anyone.
 */
export function decidePresence(
  row: ClockRow,
  userId: string,
  now: string,
  opts: { mediaConnected?: boolean } = {},
): PresenceDecision {
  if (row.status === 'completed' || row.status === 'cancelled') return {}

  const decision: PresenceDecision = {}

  // Media connecting proves both sides are in the channel together, so one
  // report settles both. Opening a room only proves the one who opened it.
  if (opts.mediaConnected) {
    if (!row.lawyer_joined_at) decision.lawyer_joined_at = now
    if (!row.client_joined_at) decision.client_joined_at = now
  } else {
    if (row.lawyer_id === userId && !row.lawyer_joined_at) decision.lawyer_joined_at = now
    if (row.client_id === userId && !row.client_joined_at) decision.client_joined_at = now
  }

  const lawyerIn = Boolean(row.lawyer_joined_at || decision.lawyer_joined_at)
  const clientIn = Boolean(row.client_joined_at || decision.client_joined_at)
  const connected = row.type === 'chat' ? lawyerIn && clientIn : Boolean(opts.mediaConnected)

  if (!row.started_at && connected && lawyerIn && clientIn) {
    decision.started_at = now
    decision.status = 'in_progress'
  }

  return decision
}

// ── Money ────────────────────────────────────────────────────────────────────

/** Whole seconds between two instants, never negative. */
export function durationSeconds(startedAt: string | Date, endedAt: string | Date): number {
  const start = startedAt instanceof Date ? startedAt.getTime() : Date.parse(startedAt)
  const end = endedAt instanceof Date ? endedAt.getTime() : Date.parse(endedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0
  return Math.max(0, Math.floor((end - start) / 1000))
}

/**
 * What the client pays, in rupees.
 *
 * Billed by the minute, rounded up, with a one-minute floor: a consultation
 * that connected at all bills its first minute even if it lasted nine seconds.
 */
export function clientChargeRupees(seconds: number, feePerMinute: number): number {
  if (!Number.isFinite(feePerMinute) || feePerMinute <= 0) return 0
  if (seconds <= 0) return 0
  return Math.max(Math.ceil((seconds / 60) * feePerMinute), feePerMinute)
}

/**
 * What the advocate earns, in rupees.
 *
 * Two rules, both deliberate:
 *
 *   - A consultation funded by the free grant earns nothing. The ₹100 is the
 *     platform's promotion, and the advocate is giving that time pro bono.
 *   - The first LAWYER_UNPAID_MINUTES of a paid consultation earn nothing.
 *
 * The client is charged normally in both cases, so this is never a discount
 * they see — it is how the platform funds the free tier.
 */
export function lawyerEarningsRupees(
  seconds: number,
  feePerMinute: number,
  funding: Funding,
): number {
  if (funding === 'credits') return 0
  if (!Number.isFinite(feePerMinute) || feePerMinute <= 0) return 0

  const paidSeconds = seconds - LAWYER_UNPAID_MINUTES * 60
  if (paidSeconds <= 0) return 0

  return Math.ceil((paidSeconds / 60) * feePerMinute)
}

/**
 * Whether this consultation will earn the advocate anything, known before it
 * starts. Shown on the incoming call so nobody accepts a free one believing
 * otherwise.
 */
export function isPaidForLawyer(funding: Funding): boolean {
  return funding === 'paid'
}

/** How a consultation's payment_status maps onto who is funding it. */
export function fundingOf(paymentStatus: string | null | undefined): Funding {
  return paymentStatus === 'credits' ? 'credits' : 'paid'
}

/**
 * The minutes an advocate is told about up front: how long before they start
 * earning. Zero once the unpaid period is behind them.
 */
export function unpaidMinutesRemaining(seconds: number): number {
  return Math.max(0, Math.ceil((LAWYER_UNPAID_MINUTES * 60 - seconds) / 60))
}

// ── Running out ──────────────────────────────────────────────────────────────

/** How long before the money runs out that we start saying so. */
export const LOW_BALANCE_SECONDS = 60

/** How many seconds the credit authorised at the start actually buys. */
export function fundedSeconds(heldPaise: number, feePerMinute: number): number {
  if (!Number.isFinite(heldPaise) || heldPaise <= 0) return 0
  if (!Number.isFinite(feePerMinute) || feePerMinute <= 0) return 0
  return Math.floor((heldPaise / (feePerMinute * 100)) * 60)
}

export interface BalanceState {
  /** Seconds of talking left. 0 once the credit is gone. */
  secondsRemaining: number
  /** True inside the final minute, so the room can say "top up to continue". */
  lowBalance: boolean
  /** True once there is nothing left to spend. */
  exhausted: boolean
}

/**
 * What is left of the authorised credit, given how long they have been
 * talking. The ceiling is what was held when the consultation was placed, so
 * this can never promise more than the client agreed to spend.
 */
export function balanceState(
  heldPaise: number,
  feePerMinute: number,
  elapsedSeconds: number,
): BalanceState {
  const funded = fundedSeconds(heldPaise, feePerMinute)
  const secondsRemaining = Math.max(0, funded - Math.max(0, elapsedSeconds))

  return {
    secondsRemaining,
    // Unfunded from the outset is not a warning, it is the exhausted case.
    lowBalance: funded > 0 && secondsRemaining > 0 && secondsRemaining <= LOW_BALANCE_SECONDS,
    exhausted: funded > 0 && secondsRemaining === 0,
  }
}

// ── Account state ────────────────────────────────────────────────────────────

/**
 * Whether an account may still use the API. [SEC-05]
 *
 * A suspended account kept full access for the life of its token: login and
 * refresh checked status, no route did. Null is allowed — rows predating the
 * column have none, and locking those out is a worse bug than the one fixed.
 */
export function isUsableAccount(status: string | null | undefined): boolean {
  return status == null || status === 'active'
}
