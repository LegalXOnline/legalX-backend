import { Router, Request, Response } from 'express'
import Razorpay from 'razorpay'
import { RtcTokenBuilder, RtcRole } from 'agora-token'
import crypto from 'crypto'
import { supabase, supabaseAuthValidator } from '../lib/supabase'
import { validateBody } from '../lib/validation'
import { createNotification } from '../lib/notify'
import { z } from 'zod'

const router = Router()

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
})

// ── Auth helper ───────────────────────────────────────────────────────────────
async function getAuthUser(req: Request): Promise<{ id: string; email: string | undefined; role: string } | null> {
  const token =
    req.cookies?.lx_access_token ||
    req.headers.authorization?.replace('Bearer ', '')
  if (!token) return null
  const { data, error } = await supabaseAuthValidator.auth.getUser(token)
  if (error || !data.user) return null

  const { data: account } = await supabase
    .from('accounts')
    .select('role')
    .eq('id', data.user.id)
    .single()

  return {
    id: data.user.id,
    email: data.user.email,
    role: account?.role ?? (data.user.role ?? 'client'),
  }
}

// ── Agora token helpers ───────────────────────────────────────────────────────
// Channel = consultationId (unique per session)
// uid = numeric hash of userId string (Agora requires uint32)
function userIdToUid(userId: string): number {
  // Deterministic numeric UID from UUID string
  const hash = crypto.createHash('md5').update(userId).digest()
  return hash.readUInt32BE(0)
}

function generateAgoraToken(channelName: string, userId: string, role: 'client' | 'host'): string {
  const appId = process.env.AGORA_APP_ID!
  const appCertificate = process.env.AGORA_APP_CERTIFICATE!
  const uid = userIdToUid(userId)
  const agoraRole = role === 'host' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER
  const expirationSecs = 3600 // 1 hour
  const currentTimestamp = Math.floor(Date.now() / 1000)
  const privilegeExpiredTs = currentTimestamp + expirationSecs

  return RtcTokenBuilder.buildTokenWithUid(
    appId,
    appCertificate,
    channelName,
    uid,
    agoraRole,
    privilegeExpiredTs,
    privilegeExpiredTs,
  )
}

// ── Zod schemas ───────────────────────────────────────────────────────────────
const initiateSchema = z.object({
  lawyerId: z.string().uuid(),
  type: z.enum(['chat', 'voice', 'video']),
  maxMinutes: z.number().int().min(5).max(120).default(30),
})

const tokenSchema = z.object({
  consultationId: z.string().uuid(),
  razorpayPaymentId: z.string().min(1),
})

// ── POST /api/consultations/initiate ─────────────────────────────────────────
// Phase 3.1: Creates Razorpay pre-auth order (holds funds) + pending DB row.
router.post('/initiate', validateBody(initiateSchema), async (req: Request, res: Response) => {
  try {
    const user = await getAuthUser(req)
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return }
    if (user.role !== 'client') {
      res.status(403).json({ error: 'Only clients can initiate consultations' }); return
    }

    const { lawyerId, type, maxMinutes } = req.body

    // Verify lawyer exists, is verified + online
    const { data: lawyer, error: lErr } = await supabase
      .from('lawyer_profiles')
      .select('account_id, first_name, last_name, verification_status, is_online, consultation_fee_chat, consultation_fee_voice, consultation_fee_video')
      .eq('account_id', lawyerId)
      .single()

    if (lErr || !lawyer) { res.status(404).json({ error: 'Lawyer not found' }); return }
    if (lawyer.verification_status !== 'verified') { res.status(400).json({ error: 'Lawyer is not verified' }); return }
    if (!lawyer.is_online) { res.status(400).json({ error: 'Lawyer is currently offline' }); return }

    const feeMap: Record<string, number> = {
      chat: Number(lawyer.consultation_fee_chat) || 20,
      voice: Number(lawyer.consultation_fee_voice) || 30,
      video: Number(lawyer.consultation_fee_video) || 40,
    }
    const feePerMinute = feeMap[type]
    const amountPaise = feePerMinute * maxMinutes * 100 // paise

    // Create Razorpay order with manual capture (pre-auth)
    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: 'INR',
      payment_capture: false,
      notes: { clientId: user.id, lawyerId, type, maxMinutes: String(maxMinutes) },
    } as any)

    // Insert pending consultation row
    const { data: consultation, error: dbErr } = await supabase
      .from('consultations')
      .insert({
        client_id: user.id,
        lawyer_id: lawyerId,
        type,
        status: 'pending',
        fee_per_minute: feePerMinute,
        razorpay_order_id: order.id,
        payment_status: 'unpaid',
      })
      .select('id')
      .single()

    if (dbErr || !consultation) { res.status(500).json({ error: 'Failed to create consultation' }); return }

    res.status(201).json({
      consultationId: consultation.id,
      razorpayOrderId: order.id,
      amount: amountPaise,
      currency: 'INR',
      lawyerName: `${lawyer.first_name ?? ''} ${lawyer.last_name ?? ''}`.trim(),
      type,
      feePerMinute,
      maxMinutes,
    })
  } catch (err) {
    console.error('[consultations/initiate]', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST /api/consultations/token ─────────────────────────────────────────────
// Phase 3.2: Verify Razorpay auth → create 100ms room → notify lawyer via Supabase.
router.post('/token', validateBody(tokenSchema), async (req: Request, res: Response) => {
  try {
    const user = await getAuthUser(req)
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return }

    const { consultationId, razorpayPaymentId } = req.body

    const { data: consultation, error: cErr } = await supabase
      .from('consultations')
      .select('*')
      .eq('id', consultationId)
      .single()

    if (cErr || !consultation) { res.status(404).json({ error: 'Consultation not found' }); return }
    if (consultation.client_id !== user.id) { res.status(403).json({ error: 'Not your consultation' }); return }
    if (consultation.status !== 'pending') { res.status(400).json({ error: 'Consultation not in pending state' }); return }

    // ── TEST MODE: bypass Razorpay verification for test_payment_* IDs ────────
    // Remove this block before going to production.
    const isTestPayment = razorpayPaymentId.startsWith('test_payment_')
    if (!isTestPayment) {
      // Verify Razorpay payment is authorized (production flow)
      const payment = await razorpay.payments.fetch(razorpayPaymentId) as any
      if (payment.order_id !== consultation.razorpay_order_id) {
        res.status(400).json({ error: 'Payment does not match consultation' }); return
      }
      if (payment.status !== 'authorized') {
        res.status(400).json({ error: 'Payment not authorized' }); return
      }
    } else {
      console.info('[consultations/token] TEST MODE — skipping Razorpay verification for:', razorpayPaymentId)
    }

    // Agora: channel = consultationId (no server-side room creation needed)
    // The channel is created automatically when the first user joins
    const channelName = consultationId
    const clientToken = generateAgoraToken(channelName, user.id, 'client')

    // Update DB: in_progress + save IDs
    await supabase.from('consultations').update({
      status: 'in_progress',
      razorpay_payment_id: razorpayPaymentId,
      hms_room_id: channelName,        // agora channel name = consultationId
      hms_session_id: channelName,     // used for webhook matching
      payment_status: isTestPayment ? 'test_mode' : 'authorized',
    }).eq('id', consultationId)

    // Notify lawyer via Supabase Realtime (insert to consultation_notifications)
    await supabase.from('consultation_notifications').insert({
      consultation_id: consultationId,
      lawyer_id: consultation.lawyer_id,
      client_id: user.id,
      type: consultation.type,
      expires_at: new Date(Date.now() + 20_000).toISOString(),
    })

    res.json({
      consultationId,
      channelName,
      agoraAppId: process.env.AGORA_APP_ID!,
      authToken: clientToken,
      uid: userIdToUid(user.id),
    })
  } catch (err) {
    console.error('[consultations/token]', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── PATCH /api/consultations/:id/accept ──────────────────────────────────────
// Phase 3.3: Lawyer accepts → gets their room token, marks started_at.
router.patch('/:id/accept', async (req: Request, res: Response) => {
  try {
    const user = await getAuthUser(req)
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return }
    if (user.role !== 'lawyer') { res.status(403).json({ error: 'Only lawyers can accept' }); return }

    const { data: consultation, error } = await supabase
      .from('consultations').select('*').eq('id', req.params.id).single()

    if (error || !consultation) { res.status(404).json({ error: 'Consultation not found' }); return }
    if (consultation.lawyer_id !== user.id) { res.status(403).json({ error: 'Not your consultation' }); return }
    if (!consultation.hms_room_id) { res.status(400).json({ error: 'Room not ready' }); return }

    const channelName = consultation.hms_room_id // stored as consultationId
    const lawyerToken = generateAgoraToken(channelName, user.id, 'host')

    await supabase.from('consultations').update({ started_at: new Date().toISOString() }).eq('id', req.params.id)

    await createNotification({
      accountId: consultation.client_id,
      title: 'Your lawyer has joined',
      message: 'The consultation is starting now.',
      type: 'consultation',
      link: `/consultation/${req.params.id}`,
    })

    res.json({
      consultationId: req.params.id,
      channelName,
      agoraAppId: process.env.AGORA_APP_ID!,
      authToken: lawyerToken,
      uid: userIdToUid(user.id),
    })
  } catch (err) {
    console.error('[consultations/accept]', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /api/consultations/:id/agora-token ───────────────────────────────────
// Issues a fresh RTC token for a session already in progress. This exists so
// the call page can fetch its own credentials instead of receiving them in the
// URL, where they would leak through history, Referer headers and server logs.
//
// The App Certificate never leaves the server; only the derived token is sent,
// and only to the two accounts attached to this consultation.
router.get('/:id/agora-token', async (req: Request, res: Response) => {
  try {
    const user = await getAuthUser(req)
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return }

    const consultationId = String(req.params.id)
    const { data: consultation, error } = await supabase
      .from('consultations')
      .select('id, client_id, lawyer_id, status, type, hms_room_id')
      .eq('id', consultationId)
      .single()

    if (error || !consultation) { res.status(404).json({ error: 'Consultation not found' }); return }

    const isClient = consultation.client_id === user.id
    const isLawyer = consultation.lawyer_id === user.id
    if (!isClient && !isLawyer) {
      res.status(403).json({ error: 'You are not a participant in this consultation' })
      return
    }

    if (consultation.status === 'cancelled' || consultation.status === 'completed') {
      res.status(400).json({ error: 'This consultation has ended.' })
      return
    }

    // The lawyer is the host; the client joins as an audience-capable publisher.
    const channelName = consultation.hms_room_id || consultation.id
    const token = generateAgoraToken(channelName, user.id, isLawyer ? 'host' : 'client')

    res.json({
      consultationId,
      channelName,
      agoraAppId: process.env.AGORA_APP_ID!,
      token,
      uid: userIdToUid(user.id),
      role: isLawyer ? 'lawyer' : 'client',
      type: consultation.type,
      status: consultation.status,
      counterpartId: isLawyer ? consultation.client_id : consultation.lawyer_id,
    })
  } catch (err) {
    console.error('[consultations/agora-token]', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── PATCH /api/consultations/:id/cancel ──────────────────────────────────────
// Phase 3.4: Lawyer declines / 20s timeout. Voids Razorpay pre-auth.
router.patch('/:id/cancel', async (req: Request, res: Response) => {
  try {
    const user = await getAuthUser(req)
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return }

    const { data: consultation, error } = await supabase
      .from('consultations').select('*').eq('id', req.params.id).single()

    if (error || !consultation) { res.status(404).json({ error: 'Consultation not found' }); return }

    const isParticipant = consultation.lawyer_id === user.id || consultation.client_id === user.id
    if (!isParticipant) { res.status(403).json({ error: 'Not authorized to cancel' }); return }

    // Void Razorpay pre-auth hold if payment was authorized
    if (consultation.razorpay_payment_id && consultation.payment_status === 'authorized') {
      try { await (razorpay.payments as any).cancel(consultation.razorpay_payment_id) } catch (e) {
        console.warn('[Razorpay void]', e)
      }
    }

    await supabase.from('consultations').update({
      status: 'cancelled',
      payment_status: consultation.payment_status === 'authorized' ? 'refunded' : 'unpaid',
      ended_at: new Date().toISOString(),
    }).eq('id', req.params.id)

    res.json({ message: 'Consultation cancelled', consultationId: req.params.id })
  } catch (err) {
    console.error('[consultations/cancel]', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST /api/consultations/review ───────────────────────────────────────────
// Post-call rating. Only a client who actually held a consultation with this
// lawyer may review them, so ratings cannot be manufactured by outsiders.
const reviewSchema = z.object({
  targetId: z.string().uuid(),
  rating: z.coerce.number().int().min(1).max(5),
  comment: z.string().max(2000).trim().optional().default(''),
  targetType: z.enum(['lawyer', 'consultation']).default('lawyer'),
})

router.post('/review', validateBody(reviewSchema), async (req: Request, res: Response) => {
  try {
    const user = await getAuthUser(req)
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return }

    const { targetId, rating, comment, targetType } = req.body

    // The lawyer being rated: either the target itself, or the lawyer on the
    // consultation being rated.
    let lawyerId = targetId
    if (targetType === 'consultation') {
      const { data: consult } = await supabase
        .from('consultations').select('lawyer_id, client_id').eq('id', targetId).maybeSingle()
      if (!consult) { res.status(404).json({ error: 'Consultation not found' }); return }
      if (consult.client_id !== user.id) { res.status(403).json({ error: 'Not your consultation' }); return }
      lawyerId = consult.lawyer_id
    } else {
      const { count } = await supabase
        .from('consultations')
        .select('id', { count: 'exact', head: true })
        .eq('lawyer_id', targetId)
        .eq('client_id', user.id)
      if (!count) {
        res.status(403).json({ error: 'You can only review a lawyer you have consulted.' })
        return
      }
    }

    const { error: insertErr } = await supabase.from('reviews').insert({
      account_id: user.id,
      target_type: targetType,
      target_id: targetId,
      rating,
      comment: comment || null,
    })
    if (insertErr) throw insertErr

    // Recompute the lawyer's rating from all their reviews rather than nudging
    // a running average, so a bad write can't skew it permanently.
    if (lawyerId) {
      const { data: all } = await supabase
        .from('reviews').select('rating').eq('target_type', 'lawyer').eq('target_id', lawyerId)
      const ratings = (all ?? []).map(r => Number(r.rating)).filter(Number.isFinite)
      if (ratings.length) {
        const avg = ratings.reduce((a, b) => a + b, 0) / ratings.length
        await supabase.from('lawyer_profiles').update({
          avg_rating: +avg.toFixed(2),
          total_reviews: ratings.length,
        }).eq('account_id', lawyerId)
      }
    }

    res.status(201).json({ message: 'Thanks for your feedback' })
  } catch (err) {
    console.error('[consultations/review]', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /api/consultations/my ─────────────────────────────────────────────────
// Phase 3.5: Paginated history for the authenticated user (client or lawyer).
router.get('/my', async (req: Request, res: Response) => {
  try {
    const user = await getAuthUser(req)
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return }

    const page = Math.max(1, Number(req.query.page) || 1)
    const limit = 20
    const offset = (page - 1) * limit
    const filterCol = user.role === 'lawyer' ? 'lawyer_id' : 'client_id'

    const { data, error, count } = await supabase
      .from('consultations')
      .select('*', { count: 'exact' })
      .eq(filterCol, user.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) { res.status(500).json({ error: 'Failed to fetch consultations' }); return }

    res.json({ consultations: data ?? [], pagination: { page, limit, total: count ?? 0 } })
  } catch (err) {
    console.error('[consultations/my]', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
