/**
 * A client's own history, assembled from what is already recorded.
 *
 * There is no orders table and there should not be one: a document request
 * lives in `applications`, a consultation in `consultations`, a top-up in
 * `wallet_transactions`. Writing a fourth row every time one of those happens
 * would be a second copy of the truth to keep in step, and it would drift.
 * This maps the three onto one shape instead.
 */

export type OrderType = 'Documentation' | 'Verification' | 'Lawyer Consultation' | 'LX Coins'
export type OrderStatus = 'Completed' | 'Pending' | 'Cancelled' | 'Refunded'

export interface Order {
  id: string
  orderType: OrderType
  serviceTitle: string
  date: string
  amount: number
  status: OrderStatus
  lawyerName?: string
  planName?: string
  paymentMethod?: string
}

/** A document request's own status, in the words the client's screen uses. */
export function applicationStatus(status: string | null | undefined): OrderStatus {
  switch (status) {
    case 'completed': return 'Completed'
    case 'cancelled': return 'Cancelled'
    // submitted, processing, and anything new: still in flight.
    default:          return 'Pending'
  }
}

/**
 * A consultation's status.
 *
 * `cancelled` covers two different things in this table — a call nobody
 * answered, and one a participant ended before it started — and both are
 * correctly "Cancelled" to the client. A completed consultation that was
 * never charged is still Completed; it happened.
 */
export function consultationStatus(
  status: string | null | undefined,
  paymentStatus?: string | null,
): OrderStatus {
  if (paymentStatus === 'refunded') return 'Refunded'
  switch (status) {
    case 'completed':   return 'Completed'
    case 'cancelled':   return 'Cancelled'
    case 'in_progress': return 'Pending'
    default:            return 'Pending'
  }
}

/** How the consultation was paid for, in words a client recognises. */
export function paymentMethodLabel(paymentStatus: string | null | undefined): string {
  switch (paymentStatus) {
    case 'credits':   return 'LX Coins'
    case 'test_mode': return 'Test payment'
    case 'refunded':  return 'Refunded'
    case 'unpaid':    return 'Unpaid'
    default:          return 'Online payment'
  }
}

/** Newest first. The three sources are merged, so they need one ordering. */
export function byNewest(a: Order, b: Order): number {
  return Date.parse(b.date) - Date.parse(a.date)
}

// ── Support ──────────────────────────────────────────────────────────────────

export type TicketCategory = 'Payments' | 'Documents' | 'Verification' | 'Consultation' | 'Account' | 'Other'
export type TicketStatus = 'Open' | 'In Progress' | 'Resolved' | 'Closed'

const CATEGORIES: Record<string, TicketCategory> = {
  payments: 'Payments', documents: 'Documents', verification: 'Verification',
  consultation: 'Consultation', account: 'Account', other: 'Other',
}

const STATUSES: Record<string, TicketStatus> = {
  open: 'Open', in_progress: 'In Progress', resolved: 'Resolved', closed: 'Closed',
}

/** Stored lowercase, shown in the client's words. Unknown values read as Other. */
export function ticketCategoryLabel(stored: string | null | undefined): TicketCategory {
  return CATEGORIES[String(stored)] ?? 'Other'
}

export function ticketStatusLabel(stored: string | null | undefined): TicketStatus {
  return STATUSES[String(stored)] ?? 'Open'
}

/** The reverse, for accepting what a client's screen sends. Null if unknown. */
export function toStoredCategory(label: string): string | null {
  const found = Object.entries(CATEGORIES).find(([, v]) => v.toLowerCase() === label.trim().toLowerCase())
  return found ? found[0] : null
}

/** A closed ticket takes no further replies. */
export function ticketAcceptsReplies(stored: string | null | undefined): boolean {
  return stored !== 'closed'
}
