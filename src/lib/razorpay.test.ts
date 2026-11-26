import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'

import {
  isValidPaymentSignature,
  isValidWebhookSignature,
  isTestKey,
  orderMatches,
} from './razorpay'

// A throwaway secret. The real one never appears in a test, and these assert
// the algorithm rather than any particular key.
const SECRET = 'test_secret_do_not_use_in_production'
const ORDER = 'order_U4iTVhvFQSPyFU'
const PAYMENT = 'pay_TESTONLY000001'

function sign(payload: string, secret = SECRET): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex')
}

// ── Checkout signature ───────────────────────────────────────────────────────

describe('payment signature: HMAC-SHA256 over order_id|payment_id', () => {
  const valid = sign(`${ORDER}|${PAYMENT}`)

  test('a correctly signed payment is accepted', () => {
    assert.equal(isValidPaymentSignature(ORDER, PAYMENT, valid, SECRET), true)
  })

  test('one flipped character is rejected', () => {
    const tampered = valid.slice(0, -1) + (valid.endsWith('a') ? 'b' : 'a')
    assert.equal(isValidPaymentSignature(ORDER, PAYMENT, tampered, SECRET), false)
  })

  test('a signature for a different order does not transfer', () => {
    const other = sign(`order_SOMETHINGELSE|${PAYMENT}`)
    assert.equal(isValidPaymentSignature(ORDER, PAYMENT, other, SECRET), false)
  })

  test('a signature for a different payment does not transfer', () => {
    const other = sign(`${ORDER}|pay_DIFFERENT`)
    assert.equal(isValidPaymentSignature(ORDER, PAYMENT, other, SECRET), false)
  })

  test('the wrong secret is rejected', () => {
    assert.equal(isValidPaymentSignature(ORDER, PAYMENT, sign(`${ORDER}|${PAYMENT}`, 'wrong'), SECRET), false)
  })

  test('the order matters, not just the pair', () => {
    // Swapping the two ids produces a different payload and must not verify.
    const swapped = sign(`${PAYMENT}|${ORDER}`)
    assert.equal(isValidPaymentSignature(ORDER, PAYMENT, swapped, SECRET), false)
  })

  test('junk input returns false rather than throwing', () => {
    for (const bad of ['', 'zz', 'not-hex-at-all', 'ab', valid + 'ff']) {
      assert.doesNotThrow(() => isValidPaymentSignature(ORDER, PAYMENT, bad, SECRET))
      assert.equal(isValidPaymentSignature(ORDER, PAYMENT, bad, SECRET), false, bad)
    }
  })

  test('a missing field is never a pass', () => {
    assert.equal(isValidPaymentSignature('', PAYMENT, valid, SECRET), false)
    assert.equal(isValidPaymentSignature(ORDER, '', valid, SECRET), false)
    assert.equal(isValidPaymentSignature(ORDER, PAYMENT, '', SECRET), false)
    assert.equal(isValidPaymentSignature(ORDER, PAYMENT, valid, ''), false)
  })
})

// ── Webhook signature ────────────────────────────────────────────────────────

describe('webhook signature is over the raw bytes', () => {
  const body = '{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_x"}}}}'

  test('the exact body verifies', () => {
    assert.equal(isValidWebhookSignature(body, sign(body), SECRET), true)
  })

  test('a Buffer of the same bytes verifies identically', () => {
    assert.equal(isValidWebhookSignature(Buffer.from(body), sign(body), SECRET), true)
  })

  test('re-serialising the same object breaks it', () => {
    // This is why the raw body is kept on the request: JSON.stringify of the
    // parsed object reorders keys and drops whitespace, and the digest moves.
    const reserialised = JSON.stringify(JSON.parse(body) as unknown, ['event'])
    assert.notEqual(reserialised, body)
    assert.equal(isValidWebhookSignature(reserialised, sign(body), SECRET), false)
  })

  test('one added byte is rejected', () => {
    assert.equal(isValidWebhookSignature(body + ' ', sign(body), SECRET), false)
  })

  test('junk returns false rather than throwing', () => {
    assert.doesNotThrow(() => isValidWebhookSignature(body, 'zz', SECRET))
    assert.equal(isValidWebhookSignature(body, 'zz', SECRET), false)
    assert.equal(isValidWebhookSignature('', sign(body), SECRET), false)
  })
})

// ── Which order may be settled where ─────────────────────────────────────────

describe('an order settles only for its own purpose and account', () => {
  const me = '22222222-2222-2222-2222-222222222222'

  test('a top-up order for this account is accepted', () => {
    assert.equal(orderMatches({ purpose: 'wallet_topup', accountId: me }, { purpose: 'wallet_topup', accountId: me }), true)
  })

  test("a service order cannot be replayed into the wallet", () => {
    // The exact shape payment.ts writes: userId, no accountId, no purpose.
    const serviceOrder = { applicationId: 'a', leadId: 'l', serviceSlug: 'gst-registration', userId: me }
    assert.equal(orderMatches(serviceOrder, { purpose: 'wallet_topup', accountId: me }), false)
  })

  test("someone else's top-up is refused", () => {
    assert.equal(orderMatches({ purpose: 'wallet_topup', accountId: 'other' }, { purpose: 'wallet_topup', accountId: me }), false)
  })

  test('notes missing entirely is refused, not treated as unrestricted', () => {
    assert.equal(orderMatches(undefined, { purpose: 'wallet_topup', accountId: me }), false)
    assert.equal(orderMatches({}, { purpose: 'wallet_topup', accountId: me }), false)
  })
})

// ── Mode ─────────────────────────────────────────────────────────────────────

describe('test mode is detected from the key', () => {
  test('a test key reads as test', () => {
    assert.equal(isTestKey('rzp_test_U4iFMhrUUnGGDl'), true)
  })

  test('a live key does not', () => {
    assert.equal(isTestKey('rzp_live_SOMETHING'), false)
  })

  test('an unset key is not treated as live', () => {
    // Defaulting to "live" would hide the test banner on a misconfigured
    // deploy, which is the one case where showing it matters most.
    assert.equal(isTestKey(undefined), false)
    assert.equal(isTestKey(''), false)
  })
})
