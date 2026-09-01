import { Router, Request, Response } from 'express'
import crypto from 'crypto'
import Razorpay from 'razorpay'
import { supabase } from '../lib/supabase'
import { logger } from '../lib/logger'
import { createNotification } from '../lib/notify'

const router = Router()

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
})

// ── POST /api/webhooks/razorpay ───────────────────────────────────────────────
// Razorpay signs every delivery with HMAC-SHA256 over the *raw* request body
// using RAZORPAY_WEBHOOK_SECRET. index.ts stashes those bytes on req.rawBody,
// because re-serialising the parsed object would change key order and
// whitespace and break the signature.
//
// IMPORTANT: No CSRF / auth middleware — secured by HMAC signature only.
router.post('/razorpay', async (req: Request, res: Response) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET
    if (!secret) {
      logger.error({}, '[webhook/razorpay] RAZORPAY_WEBHOOK_SECRET not configured')
      // 500, not 200: Razorpay should retry once the secret is set rather than
      // treat an unverifiable delivery as successfully processed.
      res.status(500).json({ error: 'Webhook not configured' })
      return
    }

    const signature = req.headers['x-razorpay-signature'] as string | undefined
    const raw: Buffer | undefined = (req as any).rawBody
    if (!signature || !raw) {
      res.status(400).json({ error: 'Missing signature or body' })
      return
    }

    const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex')
    const sigBuf = Buffer.from(signature)
    const expBuf = Buffer.from(expected)
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      logger.warn({ reqId: req.id }, '[webhook/razorpay] signature mismatch')
      res.status(401).json({ error: 'Invalid signature' })
      return
    }

    const event = req.body?.event as string | undefined
    const payment = req.body?.payload?.payment?.entity
    logger.info({ reqId: req.id, event, paymentId: payment?.id }, '[webhook/razorpay] received')

    // Acknowledge anything we don't act on, so Razorpay stops retrying it.
    if (!payment || (event !== 'payment.captured' && event !== 'payment.failed')) {
      res.json({ ok: true, ignored: event })
      return
    }

    // Idempotency: Razorpay retries until it gets a 2xx, so the same payment
    // can arrive several times. The unique gateway_transaction_id is the guard.
    const { data: seen } = await supabase
      .from('transactions').select('id').eq('gateway_transaction_id', payment.id).maybeSingle()
    if (seen) {
      res.json({ ok: true, duplicate: true })
      return
    }

    // Prefer the explicit column; fall back to Razorpay `notes`, which is where
    // the checkout can stash our own order id if the column was not populated.
    let order: any = null
    if (payment.order_id) {
      const { data } = await supabase
        .from('orders')
        .select('id, account_id, order_type, reference_id, amount, status')
        .eq('gateway_order_id', payment.order_id)
        .maybeSingle()
      order = data
    }
    if (!order && payment.notes?.order_id) {
      const { data } = await supabase
        .from('orders')
        .select('id, account_id, order_type, reference_id, amount, status')
        .eq('id', payment.notes.order_id)
        .maybeSingle()
      order = data
    }

    const failed = event === 'payment.failed'
    // Razorpay amounts are in paise.
    const rupees = Number(payment.amount ?? 0) / 100

    if (order) {
      // Insert first: the unique index on gateway_transaction_id is the real
      // idempotency guard, closing the race where two retries arrive together
      // and both pass the SELECT above.
      const { error: txnErr } = await supabase.from('transactions').insert({
        order_id: order.id,
        gateway: 'razorpay',
        gateway_transaction_id: payment.id,
        amount: rupees,
        status: failed ? 'failed' : 'captured',
        payment_method: payment.method ?? null,
        paid_at: failed ? null : new Date().toISOString(),
      })

      if (txnErr) {
        // 23505 = unique violation → a concurrent delivery already handled this.
        if ((txnErr as any).code === '23505') {
          res.json({ ok: true, duplicate: true })
          return
        }
        throw txnErr
      }

      const { error: orderErr } = await supabase.from('orders')
        .update({ status: failed ? 'failed' : 'captured', updated_at: new Date().toISOString() })
        .eq('id', order.id)
      if (orderErr) {
        // Never silent: the money has moved, so an order left in the wrong
        // state has to be visible in the logs to be reconciled by hand.
        logger.error({ reqId: req.id, orderId: order.id, err: orderErr.message },
          '[webhook/razorpay] order status update FAILED')
      }
    } else {
      logger.warn({ reqId: req.id, orderId: payment.order_id, paymentId: payment.id },
        '[webhook/razorpay] no matching order row — payment recorded nowhere')
    }

    if (failed) {
      if (order?.account_id) {
        await createNotification({
          accountId: order.account_id,
          title: 'Payment failed',
          message: `Your payment of ₹${rupees.toLocaleString('en-IN')} could not be completed. No amount has been deducted.`,
          type: 'payment',
          link: '/',
        })
      }
      res.json({ ok: true, handled: 'payment.failed' })
      return
    }

    // ── payment.captured ──────────────────────────────────────────────────────
    switch (order?.order_type) {
      case 'wallet_topup': {
        // Credit XCoins and write the ledger entry in the same pass.
        let { data: wallet } = await supabase
          .from('wallets').select('id, balance').eq('account_id', order.account_id).maybeSingle()
        if (!wallet) {
          const { data: created } = await supabase
            .from('wallets').insert({ account_id: order.account_id, balance: 0 }).select('id, balance').single()
          wallet = created
        }
        if (wallet) {
          const next = Number(wallet.balance ?? 0) + rupees
          await supabase.from('wallets')
            .update({ balance: next, updated_at: new Date().toISOString() }).eq('id', wallet.id)
          await supabase.from('wallet_transactions').insert({
            wallet_id: wallet.id,
            type: 'credit',
            amount: rupees,
            balance_after: next,
            reference_type: 'razorpay_payment',
            reference_id: order.id,
            note: `Wallet top-up · ${payment.id}`,
          })
        }
        await createNotification({
          accountId: order.account_id,
          title: 'Wallet topped up',
          message: `₹${rupees.toLocaleString('en-IN')} has been added to your XCoins balance.`,
          type: 'wallet',
          link: '/',
        })
        break
      }

      case 'service': {
        if (order.reference_id) {
          await supabase.from('service_orders')
            .update({ status: 'in_progress', updated_at: new Date().toISOString() })
            .eq('id', order.reference_id)
        }
        await createNotification({
          accountId: order.account_id,
          title: 'Payment successful',
          message: `We've received ₹${rupees.toLocaleString('en-IN')}. Our team has started work on your document.`,
          type: 'payment',
          link: '/',
        })
        break
      }

      case 'consultation': {
        if (order.reference_id) {
          await supabase.from('consultations')
            .update({ payment_status: 'paid', updated_at: new Date().toISOString() })
            .eq('id', order.reference_id)
        }
        await createNotification({
          accountId: order.account_id,
          title: 'Payment successful',
          message: `Your consultation payment of ₹${rupees.toLocaleString('en-IN')} was received.`,
          type: 'payment',
          link: '/',
        })
        break
      }

      default: {
        // Unlinked payment — recorded above where possible, but a human should
        // look at it rather than it silently disappearing.
        logger.warn({ reqId: req.id, paymentId: payment.id, orderType: order?.order_type },
          '[webhook/razorpay] captured payment with no recognised order type')
      }
    }

    res.json({ ok: true, handled: 'payment.captured' })
  } catch (err) {
    logger.error({ reqId: req.id, err }, '[webhook/razorpay] handler failed')
    // 500 so Razorpay retries rather than dropping a real payment.
    res.status(500).json({ error: 'Webhook processing failed' })
  }
})

// ── GET /api/webhooks/agora ───────────────────────────────────────────────────
// Agora Health Check — sends GET to verify endpoint is alive. Must return 200.
router.get('/agora', (_req: Request, res: Response) => {
  res.json({ ok: true, service: 'legalx-agora-webhook' })
})

// ── POST /api/webhooks/agora ──────────────────────────────────────────────────
// Called by Agora Message Notification Service when a channel event fires.
// Security: Agora signs the payload with HMAC-SHA256 using AGORA_WEBHOOK_SECRET.
// We listen for 'channel destroy' event (all users left = session ended).
//
// IMPORTANT: No CSRF / auth middleware — secured by HMAC signature only.
router.post('/agora', async (req: Request, res: Response) => {
  try {
    const webhookSecret = process.env.AGORA_WEBHOOK_SECRET
    if (!webhookSecret) {
      logger.error({}, '[webhook/agora] AGORA_WEBHOOK_SECRET not configured')
      res.status(500).json({ error: 'Webhook not configured' })
      return
    }

    // ── Verify Agora HMAC signature ───────────────────────────────────────────
    // Agora v2: header 'agora-signature-v2', HMAC-SHA256
    // Agora v1: header 'agora-signature',    HMAC-SHA1 (legacy fallback)
    const sigV2 = req.headers['agora-signature-v2'] as string
    const sigV1 = req.headers['agora-signature'] as string

    // Raw body for HMAC — must stringify consistently
    const rawBody = JSON.stringify(req.body)

    if (sigV2) {
      // V2: HMAC-SHA256
      const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex')
      const sigBuf = Buffer.from(sigV2.padEnd(expected.length, '\x00'))
      const expBuf = Buffer.from(expected)
      if (sigV2.length !== expected.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        logger.warn({},  '[webhook/agora] Invalid v2 signature')
        res.status(401).json({ error: 'Invalid signature' }); return
      }
    } else if (sigV1) {
      // V1: HMAC-SHA1
      const expected = crypto.createHmac('sha1', webhookSecret).update(rawBody).digest('hex')
      const sigBuf = Buffer.from(sigV1.padEnd(expected.length, '\x00'))
      const expBuf = Buffer.from(expected)
      if (sigV1.length !== expected.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        logger.warn({},  '[webhook/agora] Invalid v1 signature')
        res.status(401).json({ error: 'Invalid signature' }); return
      }
    } else {
      // No signature — health check ping or unknown request
      // Agora health check POST has no signature body; return 200 to pass the check
      logger.info({},  '[webhook/agora] No signature — treating as health check ping')
      res.json({ ok: true }); return
    }

    // ── Process event ─────────────────────────────────────────────────────────
    const event = req.body
    logger.info({},  '[webhook/agora] Event:', event.eventType, event.payload?.channelName)

    // Agora RTC Channel event types:
    // 101 = channel create, 102 = channel destroy (all users left)
    // 103 = broadcaster join, 104 = broadcaster leave
    if (event.eventType !== 102) { // 102 = channel destroy (all users left)
      // Not a channel destroy event — acknowledge and ignore
      res.json({ received: true })
      return
    }

    const channelName: string = event.payload?.channelName
    if (!channelName) {
      res.status(400).json({ error: 'Missing channelName in webhook payload' })
      return
    }

    // Agora doesn't report duration directly in the channel destroy event.
    // We compute it from started_at in our DB.
    // Channel name = consultationId (set during initiate flow).
    const { data: consultation, error: findErr } = await supabase
      .from('consultations')
      .select('*')
      .or(`hms_room_id.eq.${channelName},id.eq.${channelName}`)
      .single()

    if (findErr || !consultation) {
      logger.warn({},  '[webhook/agora] No consultation found for channel:', channelName)
      res.json({ received: true })
      return
    }

    // ── Idempotency guard ─────────────────────────────────────────────────────
    if (consultation.payment_status === 'paid' || consultation.status === 'completed') {
      logger.info({},  '[webhook/agora] Already processed — skip:', consultation.id)
      res.json({ received: true, skipped: true })
      return
    }

    // ── Compute duration from DB timestamps ───────────────────────────────────
    const startedAt = consultation.started_at ? new Date(consultation.started_at) : null
    const endedAt = new Date()
    const durationSeconds = startedAt
      ? Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000)
      : 0

    // ── Compute exact capture amount ──────────────────────────────────────────
    const feePerMinute = Number(consultation.fee_per_minute)
    const durationMinutes = durationSeconds / 60
    const totalAmount = Math.max(
      Math.ceil(durationMinutes * feePerMinute),
      feePerMinute, // minimum 1 minute charge
    )
    const totalAmountPaise = totalAmount * 100

    // ── Capture Razorpay payment ──────────────────────────────────────────────
    let paymentCaptured = false

    if (consultation.razorpay_payment_id && consultation.payment_status === 'authorized') {
      try {
        await razorpay.payments.capture(
          consultation.razorpay_payment_id,
          totalAmountPaise,
          'INR',
        )
        paymentCaptured = true
        logger.info({},  '[webhook/agora] Payment captured:', {
          consultationId: consultation.id,
          paymentId: consultation.razorpay_payment_id,
          totalAmountPaise,
          durationSeconds,
        })
      } catch (rpErr: any) {
        logger.error({}, '[webhook/agora] Razorpay capture failed:', rpErr?.error ?? rpErr)
        await supabase.from('consultations').update({
          status: 'completed',
          payment_status: 'failed',
          ended_at: endedAt.toISOString(),
          duration_seconds: durationSeconds,
          total_amount: totalAmount,
        }).eq('id', consultation.id)
        res.status(500).json({ error: 'Payment capture failed' })
        return
      }
    }

    // ── Mark consultation complete ────────────────────────────────────────────
    await supabase.from('consultations').update({
      status: 'completed',
      payment_status: paymentCaptured ? 'paid' : consultation.payment_status,
      ended_at: endedAt.toISOString(),
      duration_seconds: durationSeconds,
      total_amount: totalAmount,
    }).eq('id', consultation.id)

    logger.info({},  '[webhook/agora] Consultation completed:', {
      consultationId: consultation.id,
      durationSeconds,
      totalAmount,
      paymentCaptured,
    })

    res.json({ received: true, consultationId: consultation.id, durationSeconds, totalAmount, paymentCaptured })
  } catch (err) {
    logger.error({}, '[webhook/agora] Unhandled error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
