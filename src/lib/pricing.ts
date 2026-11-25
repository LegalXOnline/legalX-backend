/**
 * Prices are decided server-side. create-order used to take `amount` from the
 * request body, so a caller could pay ₹1 for a ₹1,499 service and still pass
 * signature verification — the signature proves Razorpay handled the order,
 * never that it was priced right.
 *
 * The rule lives in documents.ts so the displayed and charged price are one
 * line of code. This module adds only what taking payment needs.
 */

import { servicePriceInPaise, servicePriceInRupees, govtDutyNote, formatRupees } from './documents'

export { servicePriceInPaise, servicePriceInRupees, govtDutyNote, formatRupees }

/** Razorpay's floor is ₹1. Below it the gateway rejects the order outright. */
export const MIN_ORDER_PAISE = 100

/**
 * Sanity ceiling. Not about today's catalogue — about a future code path that
 * computes an amount and gets it wrong by three orders of magnitude. A gateway
 * charges whatever it is handed, so the refusal belongs here.
 */
export const MAX_ORDER_PAISE = 50_000_000

/** The amount if it is safe to charge, or a reason it is not. */
export function assertChargeable(paise: number | null): { ok: true; paise: number } | { ok: false; reason: string } {
  if (paise === null) return { ok: false, reason: 'no catalogue price for this service' }
  if (!Number.isInteger(paise)) return { ok: false, reason: `amount is not a whole number of paise: ${paise}` }
  if (paise < MIN_ORDER_PAISE) return { ok: false, reason: `amount below the ₹1 gateway minimum: ${paise}` }
  if (paise > MAX_ORDER_PAISE) return { ok: false, reason: `amount above the sanity ceiling: ${paise}` }
  return { ok: true, paise }
}
