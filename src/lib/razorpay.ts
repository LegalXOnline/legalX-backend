import crypto from 'crypto'

/**
 * Razorpay signature checking, in one place.
 *
 * The same HMAC was written out twice — once for service payments, once for
 * wallet top-ups — and the two had already drifted: one compared with `!==`
 * on a hex string, which leaks byte by byte how much of a forged signature
 * was correct.
 *
 * Pure: no network, no clock, no database. The secret is passed in rather
 * than read from the environment so this can be tested with a known key.
 */

/**
 * Checkout handler signature: HMAC-SHA256 over `order_id|payment_id`.
 *
 * Constant time, and it never throws on a malformed input — a caller feeding
 * in whatever arrived in the request body should get `false`, not a 500.
 */
export function isValidPaymentSignature(
  orderId: string,
  paymentId: string,
  signature: string,
  secret: string,
): boolean {
  if (!orderId || !paymentId || !signature || !secret) return false

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${orderId}|${paymentId}`)
    .digest()

  let given: Buffer
  try {
    given = Buffer.from(signature, 'hex')
  } catch {
    return false
  }

  // A hex string of the wrong length cannot be the signature, and
  // timingSafeEqual throws on mismatched buffers rather than returning false.
  if (given.length !== expected.length) return false

  return crypto.timingSafeEqual(given, expected)
}

/**
 * Webhook signature: the same HMAC, but over the raw request body.
 *
 * The bytes matter. Re-serialising the parsed JSON changes key order and
 * whitespace, and the digest never matches — which is why the body is kept
 * verbatim on the request.
 */
export function isValidWebhookSignature(
  rawBody: string | Buffer,
  signature: string,
  secret: string,
): boolean {
  if (!rawBody || !signature || !secret) return false

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest()

  let given: Buffer
  try {
    given = Buffer.from(signature, 'hex')
  } catch {
    return false
  }
  if (given.length !== expected.length) return false

  return crypto.timingSafeEqual(given, expected)
}

/** True while the configured key is a test key, so the UI can say so. */
export function isTestKey(keyId: string | undefined): boolean {
  return (keyId ?? '').startsWith('rzp_test')
}

/**
 * Whether an order we opened may be settled against this account and purpose.
 *
 * A top-up accepted any order whose notes lacked an accountId — and a service
 * order carries `userId`, not `accountId`, so it had none. One ₹1,499 service
 * payment could be replayed into the wallet as ₹1,499 of credit.
 */
export function orderMatches(
  notes: Record<string, unknown> | undefined,
  expect: { purpose: string; accountId: string },
): boolean {
  if (!notes) return false
  return notes.purpose === expect.purpose && notes.accountId === expect.accountId
}
