import { Router, Request, Response } from 'express'
import crypto from 'crypto'
import Razorpay from 'razorpay'
import { supabase } from '../lib/supabase'

const router = Router()

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
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
      console.error('[webhook/agora] AGORA_WEBHOOK_SECRET not configured')
      res.status(500).json({ error: 'Webhook not configured' })
      return
    }

    // ── Verify Agora HMAC signature ───────────────────────────────────────────
    // Agora sends: x-agora-signature-v2 header with HMAC-SHA256 of raw body
    const signature = req.headers['x-agora-signature-v2'] as string
    if (!signature) {
      res.status(401).json({ error: 'Missing webhook signature' })
      return
    }

    const rawBody = JSON.stringify(req.body)
    const expectedSig = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex')

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
      console.warn('[webhook/agora] Invalid signature — possible spoofed request')
      res.status(401).json({ error: 'Invalid signature' })
      return
    }

    // ── Process event ─────────────────────────────────────────────────────────
    const event = req.body
    console.info('[webhook/agora] Event:', event.eventType, event.payload?.channelName)

    // Agora event types:
    // 103 = channel create, 104 = channel destroy (all users left)
    // 111 = broadcaster join, 112 = broadcaster leave
    if (event.eventType !== 104) {
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
      console.warn('[webhook/agora] No consultation found for channel:', channelName)
      res.json({ received: true })
      return
    }

    // ── Idempotency guard ─────────────────────────────────────────────────────
    if (consultation.payment_status === 'paid' || consultation.status === 'completed') {
      console.info('[webhook/agora] Already processed — skip:', consultation.id)
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
        console.info('[webhook/agora] Payment captured:', {
          consultationId: consultation.id,
          paymentId: consultation.razorpay_payment_id,
          totalAmountPaise,
          durationSeconds,
        })
      } catch (rpErr: any) {
        console.error('[webhook/agora] Razorpay capture failed:', rpErr?.error ?? rpErr)
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

    console.info('[webhook/agora] Consultation completed:', {
      consultationId: consultation.id,
      durationSeconds,
      totalAmount,
      paymentCaptured,
    })

    res.json({ received: true, consultationId: consultation.id, durationSeconds, totalAmount, paymentCaptured })
  } catch (err) {
    console.error('[webhook/agora] Unhandled error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
