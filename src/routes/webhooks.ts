import { Router, Request, Response } from 'express'
import crypto from 'crypto'
import Razorpay from 'razorpay'
import { supabase } from '../lib/supabase'

const router = Router()

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
})

// ── POST /api/webhooks/100ms ──────────────────────────────────────────────────
// Phase 4.1: Called by 100ms when a session ends.
// Signs HMAC-SHA256, finds consultation, captures exact Razorpay amount.
//
// IMPORTANT: This route has NO auth middleware — 100ms calls it as an
// anonymous POST. Security is enforced by the HMAC signature check only.
router.post('/100ms', async (req: Request, res: Response) => {
  try {
    // ── Phase 4.1: Verify 100ms webhook signature ─────────────────────────────
    const signature = req.headers['x-100ms-signature'] as string
    const webhookSecret = process.env.HMS_WEBHOOK_SECRET

    if (!webhookSecret) {
      console.error('[webhook/100ms] HMS_WEBHOOK_SECRET not configured')
      res.status(500).json({ error: 'Webhook not configured' })
      return
    }

    if (!signature) {
      res.status(401).json({ error: 'Missing webhook signature' })
      return
    }

    // 100ms signs the raw body with HMAC-SHA256
    const rawBody = JSON.stringify(req.body)
    const expectedSig = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex')

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
      console.warn('[webhook/100ms] Invalid signature — possible spoofed request')
      res.status(401).json({ error: 'Invalid signature' })
      return
    }

    // ── Process event ─────────────────────────────────────────────────────────
    const event = req.body
    console.info('[webhook/100ms] Event received:', event.type, event.data?.session_id)

    if (event.type !== 'session.close.success') {
      // Acknowledge unknown events without doing anything
      res.json({ received: true })
      return
    }

    const sessionData = event.data
    const hmsSessionId: string = sessionData?.session_id

    if (!hmsSessionId) {
      res.status(400).json({ error: 'Missing session_id in webhook payload' })
      return
    }

    // duration_seconds from 100ms payload (peer-level data)
    // 100ms reports duration per peer; take the max (lawyer + client) as session duration
    const peers: any[] = sessionData?.peers ?? []
    const durationSeconds = peers.length > 0
      ? Math.max(...peers.map((p: any) => p.duration ?? 0))
      : (sessionData?.duration ?? 0)

    // ── Find consultation by hms_session_id ───────────────────────────────────
    // We match on hms_room_id as fallback since hms_session_id is updated by webhook
    const roomId: string = sessionData?.room_id ?? hmsSessionId

    const { data: consultation, error: findErr } = await supabase
      .from('consultations')
      .select('*')
      .or(`hms_session_id.eq.${hmsSessionId},hms_room_id.eq.${roomId}`)
      .single()

    if (findErr || !consultation) {
      // Could be a non-LegalX session — acknowledge and ignore
      console.warn('[webhook/100ms] No consultation found for session:', hmsSessionId)
      res.json({ received: true })
      return
    }

    // ── Phase 4.2: Idempotency guard — skip if already paid ──────────────────
    if (consultation.payment_status === 'paid') {
      console.info('[webhook/100ms] Already processed — idempotency skip:', consultation.id)
      res.json({ received: true, skipped: true })
      return
    }

    if (consultation.status === 'completed') {
      res.json({ received: true, skipped: true })
      return
    }

    // ── Compute exact amount to capture ───────────────────────────────────────
    const feePerMinute = Number(consultation.fee_per_minute)
    const durationMinutes = durationSeconds / 60
    const totalAmount = Math.ceil(durationMinutes * feePerMinute) // round up to nearest rupee
    const totalAmountPaise = totalAmount * 100

    // Minimum charge: 1 minute (don't charge ₹0 for accidental joins)
    const captureAmount = Math.max(totalAmountPaise, feePerMinute * 100)

    // ── Capture Razorpay payment (exact amount) ───────────────────────────────
    let paymentCaptured = false

    if (consultation.razorpay_payment_id && consultation.payment_status === 'authorized') {
      try {
        await razorpay.payments.capture(
          consultation.razorpay_payment_id,
          captureAmount,
          'INR'
        )
        paymentCaptured = true
        console.info('[webhook/100ms] Payment captured:', {
          consultationId: consultation.id,
          paymentId: consultation.razorpay_payment_id,
          captureAmount,
          durationSeconds,
        })
      } catch (rpErr: any) {
        console.error('[webhook/100ms] Razorpay capture failed:', rpErr?.error ?? rpErr)
        // Mark as payment_failed so we can retry manually
        await supabase.from('consultations').update({
          status: 'completed',
          payment_status: 'failed',
          ended_at: new Date().toISOString(),
          duration_seconds: durationSeconds,
          total_amount: totalAmount,
          hms_session_id: hmsSessionId,
        }).eq('id', consultation.id)

        res.status(500).json({ error: 'Payment capture failed' })
        return
      }
    }

    // ── Update consultation as completed ──────────────────────────────────────
    await supabase.from('consultations').update({
      status: 'completed',
      payment_status: paymentCaptured ? 'paid' : consultation.payment_status,
      ended_at: new Date().toISOString(),
      duration_seconds: durationSeconds,
      total_amount: totalAmount,
      hms_session_id: hmsSessionId,
    }).eq('id', consultation.id)

    console.info('[webhook/100ms] Consultation completed:', {
      consultationId: consultation.id,
      durationSeconds,
      totalAmount,
      paymentCaptured,
    })

    // 100ms expects a 200 OK within 10 seconds or it will retry
    res.json({
      received: true,
      consultationId: consultation.id,
      durationSeconds,
      totalAmount,
      paymentCaptured,
    })
  } catch (err) {
    console.error('[webhook/100ms] Unhandled error:', err)
    // Return 500 so 100ms retries the webhook
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
