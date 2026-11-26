import { Router, Request, Response, NextFunction } from 'express'
import Razorpay from 'razorpay'
import crypto from 'crypto'
import { supabase } from '../lib/supabase'
import { sendPaymentSuccess } from '../lib/email'
import { logger } from '../lib/logger'
import { requireAuth, ownsOrAdmin, type AuthedRequest } from '../lib/auth'
import { servicePriceInPaise, assertChargeable, govtDutyNote } from '../lib/pricing'
import { isValidPaymentSignature, isTestKey } from '../lib/razorpay'

const router = Router()

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
})

/** True while the configured key is a test key. Surfaced so the UI can say so. */
const isTestMode = isTestKey(process.env.RAZORPAY_KEY_ID)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ── POST /api/payment/create-order ───────────────────────────────────────────
// The client says which application to pay for. It does not say the price —
// that comes from the server's catalogue. See lib/pricing.ts.
router.post('/create-order', requireAuth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const caller = req.user!
    const { applicationId } = req.body

    if (typeof applicationId !== 'string' || !UUID_RE.test(applicationId)) {
      return res.status(400).json({ error: 'A valid applicationId is required' })
    }

    // serviceSlug comes from the stored row, not the request — letting the
    // client restate it is how you pay the ₹299 affidavit price for a
    // ₹1,499 trademark.
    const { data: application, error: appError } = await supabase
      .from('applications')
      .select('id, lead_id, service_slug, status, leads(account_id, service_title)')
      .eq('id', applicationId)
      .single()

    if (appError || !application) {
      return res.status(404).json({ error: 'Application not found' })
    }

    const lead = Array.isArray(application.leads) ? application.leads[0] : application.leads
    const ownerId: string | null = lead?.account_id ?? null

    // A guest who has now signed in to pay is the normal path, so claim it.
    // Anything already owned by someone else is not payable here.
    if (ownerId === null) {
      if (caller.role !== 'client') {
        return res.status(403).json({ error: 'Only a client can pay for an application' })
      }
      await supabase.from('leads').update({ account_id: caller.id }).eq('id', application.lead_id)
    } else if (!ownsOrAdmin(caller, ownerId)) {
      // 404, not 403 — a 403 confirms the id is real.
      return res.status(404).json({ error: 'Application not found' })
    }

    const priced = assertChargeable(servicePriceInPaise(application.service_slug))
    if (!priced.ok) {
      logger.error(
        { applicationId, serviceSlug: application.service_slug, reason: priced.reason },
        'Refusing to create a Razorpay order',
      )
      return res.status(409).json({ error: 'This service is not available for online payment' })
    }
    const amount = priced.paise

    // The unique index stops a duplicate settlement, not a duplicate order —
    // and two open orders on one application is how someone pays twice.
    const { data: settled } = await supabase
      .from('payments')
      .select('id')
      .eq('application_id', applicationId)
      .eq('status', 'paid')
      .limit(1)
      .maybeSingle()

    if (settled) {
      return res.status(409).json({ error: 'This application has already been paid for' })
    }

    const order = await razorpay.orders.create({
      amount,
      currency: 'INR',
      receipt: `lx_${applicationId.slice(0, 8)}`,
      notes: {
        applicationId,
        leadId: application.lead_id,
        serviceSlug: application.service_slug,
        userId: caller.id,
      },
    })

    const { error: insertError } = await supabase.from('payments').insert({
      application_id: applicationId,
      lead_id: application.lead_id,
      razorpay_order_id: order.id,
      amount,
      currency: 'INR',
      status: 'created',
      service_slug: application.service_slug,
    })

    // The order exists at Razorpay but we have no record of it. Verify looks
    // it up by id, so staying quiet here would reject a real payment later.
    if (insertError) {
      logger.error(
        { err: insertError, razorpayOrderId: order.id, applicationId },
        'Razorpay order created but payments row insert failed',
      )
      return res.status(500).json({ error: 'Could not start payment. Please try again.' })
    }

    return res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      // So the UI can say "test" instead of leaving someone wondering why no
      // money moved.
      testMode: isTestMode,
      serviceTitle: lead?.service_title ?? null,
      // Not part of `amount` — the client pays the registry direct. Sent so
      // the Android app, which has no local catalogue, can show it too.
      govtDuty: govtDutyNote(application.service_slug),
    })
  } catch (err) {
    next(err)
  }
})

// ── POST /api/payment/verify ─────────────────────────────────────────────────
// Verify Razorpay signature after successful payment
router.post('/verify', requireAuth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const caller = req.user!
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body

    if (
      typeof razorpayOrderId !== 'string' ||
      typeof razorpayPaymentId !== 'string' ||
      typeof razorpaySignature !== 'string' ||
      !razorpayOrderId || !razorpayPaymentId || !razorpaySignature
    ) {
      return res.status(400).json({ error: 'Missing payment fields' })
    }

    if (!isValidPaymentSignature(razorpayOrderId, razorpayPaymentId, razorpaySignature, process.env.RAZORPAY_KEY_SECRET!)) {
      logger.warn({ razorpayOrderId, callerId: caller.id }, '[payment] signature mismatch')
      return res.status(400).json({ error: 'Invalid payment signature' })
    }

    // A top-up order must not settle a service application either. [PAY-03]
    // The payments lookup below already scopes this to orders we opened for an
    // application, so a wallet order simply finds no row — but say so plainly
    // rather than relying on that as the guard.
    //
    // The order row is authoritative. Nothing from the body is trusted past
    // the signature check.
    const { data: payment, error: paymentError } = await supabase
      .from('payments')
      .select('application_id, lead_id, amount, service_slug, status, applications(leads(account_id))')
      .eq('razorpay_order_id', razorpayOrderId)
      .single()

    if (paymentError || !payment) {
      return res.status(404).json({ error: 'Payment record not found' })
    }

    // Ownership — which this route only claimed to check before. It loaded
    // the application and then compared nothing against the caller.
    const application = Array.isArray(payment.applications) ? payment.applications[0] : payment.applications
    const leadRow = Array.isArray(application?.leads) ? application?.leads[0] : application?.leads
    const ownerId: string | null = leadRow?.account_id ?? null

    if (!ownsOrAdmin(caller, ownerId)) {
      logger.warn(
        { razorpayOrderId, callerId: caller.id, ownerId },
        '[payment] verify attempted by a caller who does not own the order',
      )
      return res.status(404).json({ error: 'Payment record not found' })
    }

    const applicationId = payment.application_id
    const leadId = payment.lead_id

    // Razorpay's checkout can fire twice and the webhook races this route.
    // Whichever lands second must be a no-op, not an error shown to someone
    // whose money has already moved.
    if (payment.status === 'paid') {
      return res.json({ ok: true, status: 'paid', alreadyProcessed: true })
    }

    // Guarded on status so two concurrent settlements cannot both send a
    // receipt — the loser updates nothing and returns the same success.
    const { data: claimed, error: updateError } = await supabase
      .from('payments')
      .update({
        razorpay_payment_id: razorpayPaymentId,
        razorpay_signature: razorpaySignature,
        status: 'paid',
      })
      .eq('razorpay_order_id', razorpayOrderId)
      .eq('status', 'created')
      .select('application_id')

    if (updateError) throw updateError

    if (!claimed || claimed.length === 0) {
      return res.json({ ok: true, status: 'paid', alreadyProcessed: true })
    }

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
