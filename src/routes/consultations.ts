import { Router, Request, Response } from 'express'
import Razorpay from 'razorpay'
import jwt from 'jsonwebtoken'
import { v4 as uuidv4 } from 'uuid'
import { supabase } from '../lib/supabase'
import { validateBody } from '../lib/validation'
import { z } from 'zod'

const router = Router()

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
})

// ── Auth helper ───────────────────────────────────────────────────────────────
async function getAuthUser(req: Request) {
  const token =
    req.cookies?.lx_access_token ||
    req.headers.authorization?.replace('Bearer ', '')
  if (!token) return null
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return null
  return data.user
}

// ── 100ms JWT helpers ─────────────────────────────────────────────────────────
function generateHmsManagementToken(): string {
  return jwt.sign(
    { access_key: process.env.HMS_APP_ID!, type: 'management', version: 2 },
    process.env.HMS_APP_SECRET!,
    { algorithm: 'HS256', expiresIn: '30s', jwtid: uuidv4() }
  )
}

function generateHmsRoomToken(roomId: string, userId: string, role: 'client' | 'host'): string {
  return jwt.sign(
    { access_key: process.env.HMS_APP_ID!, room_id: roomId, user_id: userId, role, type: 'app', version: 2 },
    process.env.HMS_APP_SECRET!,
    { algorithm: 'HS256', expiresIn: '1h', jwtid: uuidv4() }
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
    if (user.user_metadata?.role !== 'client') {
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

    // Verify Razorpay payment is authorized
    const payment = await razorpay.payments.fetch(razorpayPaymentId) as any
    if (payment.order_id !== consultation.razorpay_order_id) {
      res.status(400).json({ error: 'Payment does not match consultation' }); return
    }
    if (payment.status !== 'authorized') {
      res.status(400).json({ error: 'Payment not authorized' }); return
    }

    // Create 100ms room (server-side, APP_SECRET never leaves backend)
    const mgmtToken = generateHmsManagementToken()
    const roomRes = await fetch('https://api.100ms.live/v2/rooms', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${mgmtToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `legalx-${consultationId}`,
        description: `LegalX ${consultation.type} consultation`,
        template_id: process.env.HMS_TEMPLATE_ID,
      }),
    })

    if (!roomRes.ok) {
      // Room creation failed — void pre-auth and return error
      try { await (razorpay.payments as any).cancel(razorpayPaymentId) } catch {}
      res.status(500).json({ error: 'Failed to create consultation room. Payment voided.' }); return
    }

    const room = await roomRes.json() as any
    const clientToken = generateHmsRoomToken(room.id, user.id, 'client')

    // Update DB: in_progress + save IDs
    await supabase.from('consultations').update({
      status: 'in_progress',
      razorpay_payment_id: razorpayPaymentId,
      hms_room_id: room.id,
      hms_session_id: room.id, // 100ms session ID comes from webhook; use room ID as temp
      payment_status: 'authorized',
    }).eq('id', consultationId)

    // Notify lawyer via Supabase Realtime (insert to consultation_notifications)
    await supabase.from('consultation_notifications').insert({
      consultation_id: consultationId,
      lawyer_id: consultation.lawyer_id,
      client_id: user.id,
      type: consultation.type,
      expires_at: new Date(Date.now() + 20_000).toISOString(),
    })

    res.json({ consultationId, roomId: room.id, authToken: clientToken })
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
    if (user.user_metadata?.role !== 'lawyer') { res.status(403).json({ error: 'Only lawyers can accept' }); return }

    const { data: consultation, error } = await supabase
      .from('consultations').select('*').eq('id', req.params.id).single()

    if (error || !consultation) { res.status(404).json({ error: 'Consultation not found' }); return }
    if (consultation.lawyer_id !== user.id) { res.status(403).json({ error: 'Not your consultation' }); return }
    if (!consultation.hms_room_id) { res.status(400).json({ error: 'Room not ready' }); return }

    const lawyerToken = generateHmsRoomToken(consultation.hms_room_id, user.id, 'host')

    await supabase.from('consultations').update({ started_at: new Date().toISOString() }).eq('id', req.params.id)

    res.json({ consultationId: req.params.id, roomId: consultation.hms_room_id, authToken: lawyerToken })
  } catch (err) {
    console.error('[consultations/accept]', err)
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

// ── GET /api/consultations/my ─────────────────────────────────────────────────
// Phase 3.5: Paginated history for the authenticated user (client or lawyer).
router.get('/my', async (req: Request, res: Response) => {
  try {
    const user = await getAuthUser(req)
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return }

    const page = Math.max(1, Number(req.query.page) || 1)
    const limit = 20
    const offset = (page - 1) * limit
    const filterCol = user.user_metadata?.role === 'lawyer' ? 'lawyer_id' : 'client_id'

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
