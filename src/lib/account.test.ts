import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  applicationStatus, consultationStatus, paymentMethodLabel, byNewest,
  ticketCategoryLabel, ticketStatusLabel, toStoredCategory, ticketAcceptsReplies,
  type Order,
} from './account'

// ── Order history ────────────────────────────────────────────────────────────

describe('a document request reads back in the right state', () => {
  test('in flight is Pending', () => {
    assert.equal(applicationStatus('submitted'), 'Pending')
    assert.equal(applicationStatus('processing'), 'Pending')
  })

  test('finished and abandoned read as themselves', () => {
    assert.equal(applicationStatus('completed'), 'Completed')
    assert.equal(applicationStatus('cancelled'), 'Cancelled')
  })

  test('an unknown or missing status never reads as finished', () => {
    assert.equal(applicationStatus('something_new'), 'Pending')
    assert.equal(applicationStatus(null), 'Pending')
    assert.equal(applicationStatus(undefined), 'Pending')
  })
})

describe('a consultation reads back in the right state', () => {
  test('refunded beats whatever the status says', () => {
    assert.equal(consultationStatus('completed', 'refunded'), 'Refunded')
    assert.equal(consultationStatus('cancelled', 'refunded'), 'Refunded')
  })

  test('a call in progress is still Pending, not Completed', () => {
    assert.equal(consultationStatus('in_progress', 'credits'), 'Pending')
  })

  test('a completed call that cost nothing still happened', () => {
    assert.equal(consultationStatus('completed', 'credits'), 'Completed')
    assert.equal(consultationStatus('completed', 'unpaid'), 'Completed')
  })

  test('unanswered reads as Cancelled', () => {
    assert.equal(consultationStatus('cancelled', 'credits'), 'Cancelled')
  })
})

describe('how it was paid for, in words a client recognises', () => {
  test('free credit is named as such', () => {
    assert.equal(paymentMethodLabel('credits'), 'LX Coins')
  })

  test('test transactions are not passed off as real ones', () => {
    assert.equal(paymentMethodLabel('test_mode'), 'Test payment')
  })

  test('anything else is an online payment', () => {
    assert.equal(paymentMethodLabel('captured'), 'Online payment')
    assert.equal(paymentMethodLabel(null), 'Online payment')
  })
})

describe('the three sources merge into one list', () => {
  const o = (id: string, date: string): Order =>
    ({ id, date, orderType: 'LX Coins', serviceTitle: 't', amount: 0, status: 'Completed' })

  test('newest first across every type', () => {
    const list = [
      o('old', '2026-01-01T00:00:00Z'),
      o('new', '2026-11-01T00:00:00Z'),
      o('mid', '2026-06-01T00:00:00Z'),
    ].sort(byNewest)
    assert.deepEqual(list.map(x => x.id), ['new', 'mid', 'old'])
  })
})

// ── Support ──────────────────────────────────────────────────────────────────

describe('ticket labels round-trip', () => {
  test('stored lowercase, shown in words', () => {
    assert.equal(ticketCategoryLabel('payments'), 'Payments')
    assert.equal(ticketCategoryLabel('consultation'), 'Consultation')
    assert.equal(ticketStatusLabel('in_progress'), 'In Progress')
  })

  test('every shown label converts back to something storable', () => {
    for (const label of ['Payments', 'Documents', 'Verification', 'Consultation', 'Account', 'Other']) {
      const stored = toStoredCategory(label)
      assert.ok(stored, `${label} must map to a stored value`)
      assert.equal(ticketCategoryLabel(stored!), label, `${label} must survive the round trip`)
    }
  })

  test('case and whitespace from a client are tolerated', () => {
    assert.equal(toStoredCategory('  payments '), 'payments')
    assert.equal(toStoredCategory('ACCOUNT'), 'account')
  })

  test('an invented category is refused, not silently filed as Other', () => {
    assert.equal(toStoredCategory('Refunds'), null)
    assert.equal(toStoredCategory(''), null)
  })

  test('an unknown stored value still renders rather than crashing', () => {
    assert.equal(ticketCategoryLabel('legacy_value'), 'Other')
    assert.equal(ticketStatusLabel(null), 'Open')
  })
})

describe('a closed ticket takes no more replies', () => {
  test('open, in progress and resolved all accept', () => {
    for (const s of ['open', 'in_progress', 'resolved']) {
      assert.equal(ticketAcceptsReplies(s), true, s)
    }
  })

  test('closed does not', () => {
    assert.equal(ticketAcceptsReplies('closed'), false)
  })
})
