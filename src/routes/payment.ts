import { Router } from 'express'
import Razorpay from 'razorpay'
import crypto from 'crypto'
import { supabase } from '../lib/supabase'
import { sendPaymentSuccess } from '../lib/email'

const router = Router()

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
})

// ── POST /api/payment/create-order ───────────────────────────────────────────
// Create a Razorpay order and return the order_id to frontend
router.post('/create-order', async (req, res) => {
  const { applicationId, leadId, serviceSlug, amount } = req.body
  // amount in paise — e.g. ₹1499 = 149900

  if (!applicationId || !leadId || !amount || amount < 100) {
    return res.status(400).json({ error: 'applicationId, leadId and amount (paise) are required' })
  }

  try {
    const order = await razorpay.orders.create({
      amount,
      currency: 'INR',
      receipt: `lx_${applicationId.slice(0, 8)}`,
      notes: { applicationId, leadId, serviceSlug },
    })

    // Persist order in payments table
    await supabase.from('payments').insert({
      application_id: applicationId,
      lead_id: leadId,
      razorpay_order_id: order.id,
      amount,
      currency: 'INR',
      status: 'created',
      service_slug: serviceSlug,
    })

    return res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
    })
  } catch (err) {
    console.error('[payment] create-order error:', err)
    return res.status(500).json({ error: 'Could not create payment order' })
  }
})

// ── POST /api/payment/verify ─────────────────────────────────────────────────
// Verify Razorpay signature after successful payment
router.post('/verify', async (req, res) => {
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature, applicationId, leadId } = req.body

  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    return res.status(400).json({ error: 'Missing payment fields' })
  }

  // Verify HMAC signature
  const expectedSig = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET!)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex')

  if (expectedSig !== razorpaySignature) {
    console.warn('[payment] signature mismatch', { razorpayOrderId })
    return res.status(400).json({ error: 'Invalid payment signature' })
  }

  // Update payments table
  const { data: payment } = await supabase
    .from('payments')
    .update({
      razorpay_payment_id: razorpayPaymentId,
      razorpay_signature: razorpaySignature,
      status: 'paid',
    })
    .eq('razorpay_order_id', razorpayOrderId)
    .select('amount, service_slug')
    .single()

  // Update application status
  await supabase
    .from('applications')
    .update({ status: 'processing' })
    .eq('id', applicationId)

  // Update lead status
  await supabase
    .from('leads')
    .update({ status: 'converted' })
    .eq('id', leadId)

  // Fetch lead details for email
  const { data: lead } = await supabase
    .from('leads')
    .select('name, email, service_title')
    .eq('id', leadId)
    .single()

  if (lead) {
    sendPaymentSuccess({
      toEmail: lead.email,
      name: lead.name,
      serviceTitle: lead.service_title,
      amount: payment?.amount || 0,
      applicationId,
    })
  }

  return res.json({ ok: true, status: 'paid' })
})

export default router
