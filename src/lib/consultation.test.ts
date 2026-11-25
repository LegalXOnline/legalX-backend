import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  decidePresence,
  durationSeconds,
  clientChargeRupees,
  lawyerEarningsRupees,
  isPaidForLawyer,
  fundingOf,
  unpaidMinutesRemaining,
  FREE_CREDIT_PAISE,
  LAWYER_UNPAID_MINUTES,
  type ClockRow,
} from './consultation'

const LAWYER = '11111111-1111-1111-1111-111111111111'
const CLIENT = '22222222-2222-2222-2222-222222222222'
const NOW = '2026-11-25T10:00:00.000Z'

function room(over: Partial<ClockRow> = {}): ClockRow {
  return {
    type: 'chat',
    client_id: CLIENT,
    lawyer_id: LAWYER,
    status: 'pending',
    started_at: null,
    lawyer_joined_at: null,
    client_joined_at: null,
    ...over,
  }
}

// ── Chat ─────────────────────────────────────────────────────────────────────
// A chat has no media session. Both sides having opened the room is the whole
// signal, which is the bug that left "Waiting for the client" on screen while
// messages were flowing.

describe('chat: the clock starts when both have opened the room', () => {
  test('lawyer alone does not start it', () => {
    const d = decidePresence(room(), LAWYER, NOW)
    assert.equal(d.lawyer_joined_at, NOW)
    assert.equal(d.client_joined_at, undefined)
    assert.equal(d.started_at, undefined, 'one side present must not start billing')
  })

  test('client alone does not start it', () => {
    const d = decidePresence(room(), CLIENT, NOW)
    assert.equal(d.client_joined_at, NOW)
    assert.equal(d.started_at, undefined)
  })

  test('the second arrival starts it', () => {
    const d = decidePresence(room({ lawyer_joined_at: '2026-11-25T09:59:00.000Z' }), CLIENT, NOW)
    assert.equal(d.client_joined_at, NOW)
    assert.equal(d.started_at, NOW)
    assert.equal(d.status, 'in_progress')
  })

  test('an already-running clock is never restarted', () => {
    const started = '2026-11-25T09:50:00.000Z'
    const d = decidePresence(
      room({ started_at: started, lawyer_joined_at: started, client_joined_at: started, status: 'in_progress' }),
      CLIENT, NOW,
    )
    assert.equal(d.started_at, undefined, 'restarting would reset the bill')
  })

  test('re-opening the room does not re-stamp presence', () => {
    const d = decidePresence(room({ lawyer_joined_at: '2026-11-25T09:00:00.000Z' }), LAWYER, NOW)
    assert.equal(d.lawyer_joined_at, undefined)
  })
})

// ── Voice and video ──────────────────────────────────────────────────────────
// Opening the room is not being in the call. A caller stuck on "Connecting…"
// must not be billed for the attempt.

for (const type of ['voice', 'video'] as const) {
  describe(`${type}: the clock waits for media, not for the room`, () => {
    test('both present but no media does NOT start the clock', () => {
      const d = decidePresence(
        room({ type, lawyer_joined_at: '2026-11-25T09:59:00.000Z' }),
        CLIENT, NOW,
      )
      assert.equal(d.client_joined_at, NOW, 'presence is still recorded')
      assert.equal(d.started_at, undefined, 'nobody is billed for connecting')
    })

    test('media connected starts it and settles both sides', () => {
      const d = decidePresence(room({ type }), CLIENT, NOW, { mediaConnected: true })
      assert.equal(d.lawyer_joined_at, NOW)
      assert.equal(d.client_joined_at, NOW)
      assert.equal(d.started_at, NOW)
      assert.equal(d.status, 'in_progress')
    })

    test('a second media report is a no-op', () => {
      const d = decidePresence(
        room({ type, started_at: NOW, lawyer_joined_at: NOW, client_joined_at: NOW, status: 'in_progress' }),
        LAWYER, '2026-11-25T10:00:05.000Z', { mediaConnected: true },
      )
      assert.deepEqual(d, {}, 'the webhook and the client both report; the second must change nothing')
    })
  })
}

// ── Finished consultations ───────────────────────────────────────────────────

describe('a settled consultation is immutable', () => {
  for (const status of ['completed', 'cancelled'] as const) {
    test(`${status}: nothing is written`, () => {
      assert.deepEqual(decidePresence(room({ status }), CLIENT, NOW), {})
      assert.deepEqual(decidePresence(room({ status, type: 'video' }), CLIENT, NOW, { mediaConnected: true }), {})
    })
  }
})

// ── Duration ─────────────────────────────────────────────────────────────────

describe('duration', () => {
  test('counts whole seconds', () => {
    assert.equal(durationSeconds('2026-11-25T10:00:00Z', '2026-11-25T10:01:30Z'), 90)
  })

  test('a clock that runs backwards yields zero, never a negative bill', () => {
    assert.equal(durationSeconds('2026-11-25T10:01:00Z', '2026-11-25T10:00:00Z'), 0)
  })

  test('an unparseable timestamp yields zero', () => {
    assert.equal(durationSeconds('not-a-date', NOW), 0)
  })
})

// ── What the client pays ─────────────────────────────────────────────────────

describe('client charge: by the minute, rounded up, one-minute floor', () => {
  test('a nine-second call still bills one minute', () => {
    assert.equal(clientChargeRupees(9, 40), 40)
  })

  test('exactly one minute bills one minute', () => {
    assert.equal(clientChargeRupees(60, 40), 40)
  })

  // Per second, rounded up to the rupee — NOT per whole minute. 61s at ₹40/min
  // is ₹41, not ₹80. This is what settleConsultation has always done; the test
  // records it so a future "round up to the minute" change is a deliberate
  // decision rather than an accident.
  test('billing is per second, rounded up to the rupee', () => {
    assert.equal(clientChargeRupees(61, 40), 41)
    assert.equal(clientChargeRupees(90, 40), 60)
    assert.equal(clientChargeRupees(120, 40), 80)
  })

  test('ten minutes at ₹40 is ₹400', () => {
    assert.equal(clientChargeRupees(600, 40), 400)
  })

  test('a call that never connected is free', () => {
    assert.equal(clientChargeRupees(0, 40), 0)
  })
})

// ── What the advocate earns ──────────────────────────────────────────────────

describe('advocate earnings', () => {
  test('a free-credit consultation earns nothing, however long', () => {
    assert.equal(lawyerEarningsRupees(60 * 60, 40, 'credits'), 0)
  })

  test(`the first ${LAWYER_UNPAID_MINUTES} minutes of a paid consultation earn nothing`, () => {
    assert.equal(lawyerEarningsRupees(LAWYER_UNPAID_MINUTES * 60, 40, 'paid'), 0)
    assert.equal(lawyerEarningsRupees(LAWYER_UNPAID_MINUTES * 60 - 1, 40, 'paid'), 0)
  })

  test('earning starts only after the unpaid period', () => {
    // 6 minutes paid → 1 minute earned
    assert.equal(lawyerEarningsRupees(6 * 60, 40, 'paid'), 40)
    // 10 minutes paid → 5 minutes earned
    assert.equal(lawyerEarningsRupees(10 * 60, 40, 'paid'), 200)
  })

  test('the client is still billed for the unpaid minutes', () => {
    const seconds = 10 * 60
    assert.equal(clientChargeRupees(seconds, 40), 400)
    assert.equal(lawyerEarningsRupees(seconds, 40, 'paid'), 200)
    // The difference is the platform's, and is never shown as a client discount.
  })

  test('earnings never exceed what the client paid', () => {
    for (const seconds of [1, 59, 60, 301, 600, 3600]) {
      const paid = clientChargeRupees(seconds, 40)
      const earned = lawyerEarningsRupees(seconds, 40, 'paid')
      assert.ok(earned <= paid, `${seconds}s: advocate ${earned} > client ${paid}`)
    }
  })

  test('a missing or nonsense rate earns nothing rather than NaN', () => {
    assert.equal(lawyerEarningsRupees(600, 0, 'paid'), 0)
    assert.equal(lawyerEarningsRupees(600, Number.NaN, 'paid'), 0)
    assert.equal(clientChargeRupees(600, Number.NaN), 0)
  })
})

// ── Told up front ────────────────────────────────────────────────────────────

describe('the advocate is told before accepting', () => {
  test('free credit reads as unpaid', () => {
    assert.equal(fundingOf('credits'), 'credits')
    assert.equal(isPaidForLawyer(fundingOf('credits')), false)
  })

  test('anything else reads as paid', () => {
    for (const s of ['captured', 'authorized', 'paid', 'test_mode', null, undefined]) {
      assert.equal(isPaidForLawyer(fundingOf(s)), true, `payment_status=${s}`)
    }
  })

  test('the unpaid countdown reaches zero and stays there', () => {
    assert.equal(unpaidMinutesRemaining(0), LAWYER_UNPAID_MINUTES)
    assert.equal(unpaidMinutesRemaining(60), LAWYER_UNPAID_MINUTES - 1)
    assert.equal(unpaidMinutesRemaining(LAWYER_UNPAID_MINUTES * 60), 0)
    assert.equal(unpaidMinutesRemaining(9999), 0)
  })
})

// ── The grant ────────────────────────────────────────────────────────────────

describe('the free grant', () => {
  test('is ₹100', () => {
    assert.equal(FREE_CREDIT_PAISE, 10_000)
    assert.equal(FREE_CREDIT_PAISE / 100, 100)
  })

  test('covers two minutes of video at ₹40 and no more than it should', () => {
    const feePerMinute = 40
    const affordable = Math.floor(FREE_CREDIT_PAISE / (feePerMinute * 100))
    assert.equal(affordable, 2)
  })
})
