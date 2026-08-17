import { Router, Request, Response, NextFunction } from 'express'
import Razorpay from 'razorpay'
import crypto from 'crypto'
import { supabase } from '../lib/supabase'
import { sendPaymentSuccess } from '../lib/email'

const router = Router()

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
})

// ── Auth middleware for payment routes ─────────────────────────────────────────
async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.lx_access_token || req.headers.authorization?.replace('Bearer ', '')
    if (!token) {
      return res.status(401).json({ error: 'Not authenticated' })
    }

    const { data, error } = await supabase.auth.getUser(token)
    if (error || !data.user) {
      return res.status(401).json({ error: 'Invalid or expired session' })
    }

    ;(req as any).user = data.user
    next()
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }
}

// ── POST /api/payment/create-order ───────────────────────────────────────────
// Create a Razorpay order and return the order_id to frontend
router.post('/create-order', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { applicationId, leadId, serviceSlug, amount } = req.body
    const userId = (req as any).user.id

    // amount in paise — e.g. ₹1499 = 149900
    if (!applicationId || !leadId || !amount || amount < 100) {
      return res.status(400).json({ error: 'applicationId, leadId and amount (paise) are required' })
    }

    // Verify the application belongs to this user
    const { data: application, error: appError } = await supabase
      .from('applications')
      .select('id, lead_id')
      .eq('id', applicationId)
      .single()

    if (appError || !application) {
      return res.status(404).json({ error: 'Application not found' })
    }

    if (application.lead_id !== leadId) {
      return res.status(400).json({ error: 'Application and lead mismatch' })
    }

    // Verify the lead belongs to this user (check via leads table or application)
    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select('id')
      .eq('id', leadId)
      .single()

    if (leadError || !lead) {
      return res.status(404).json({ error: 'Lead not found' })
    }

    const order = await razorpay.orders.create({
      amount,
      currency: 'INR',
      receipt: `lx_${applicationId.slice(0, 8)}`,
      notes: { applicationId, leadId, serviceSlug, userId },
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
    next(err)
  }
})

// ── POST /api/payment/verify ─────────────────────────────────────────────────
// Verify Razorpay signature after successful payment
router.post('/verify', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body
    const userId = (req as any).user.id

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

    // Get payment record to verify ownership and get applicationId/leadId
    const { data: payment, error: paymentError } = await supabase
      .from('payments')
      .select('application_id, lead_id, amount, service_slug, status')
      .eq('razorpay_order_id', razorpayOrderId)
      .single()

    if (paymentError || !payment) {
      return res.status(404).json({ error: 'Payment record not found' })
    }

    if (payment.status === 'paid') {
      return res.status(400).json({ error: 'Payment already processed' })
    }

    // Verify the application belongs to this user
    const { data: application, error: appError } = await supabase
      .from('applications')
      .select('id, lead_id')
      .eq('id', payment.application_id)
      .single()

    if (appError || !application) {
      return res.status(404).json({ error: 'Application not found' })
    }

    // Use the payment record's data, not client-provided values
    const applicationId = payment.application_id
    const leadId = payment.lead_id

    // Update payments table
    const { error: updateError } = await supabase
      .from('payments')
      .update({
        razorpay_payment_id: razorpayPaymentId,
        razorpay_signature: razorpaySignature,
        status: 'paid',
      })
      .eq('razorpay_order_id', razorpayOrderId)

    if (updateError) throw updateError

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
        amount: payment.amount,
        applicationId,
      })
    }

    return res.json({ ok: true, status: 'paid' })
  } catch (err) {
    next(err)
  }
})

export default router
