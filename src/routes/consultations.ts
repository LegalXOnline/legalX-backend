import { Router, Request, Response } from 'express'
import Razorpay from 'razorpay'
import { RtcTokenBuilder, RtcRole } from 'agora-token'
import crypto from 'crypto'
import { supabase, supabaseAuthValidator } from '../lib/supabase'
import { validateBody, messageSendSchema } from '../lib/validation'
import { createNotification } from '../lib/notify'
import { logger } from '../lib/logger'
import { sendPushToAccount } from '../lib/push'
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

/**
 * Both parties are issued a PUBLISHER token.
 *
 * A consultation is two-way: the client speaks as much as the lawyer, so a
 * SUBSCRIBER token — which cannot publish audio or video — is wrong for either
 * of them. It happens to work today only because the room joins with
 * `mode: 'rtc'`, where Agora ignores the role; switching the client to
 * `mode: 'live'` for any reason would silently mute every client with no error
 * to trace. The `role` argument is kept because the caller uses it to say who
 * is who, and it still decides nothing else.
 */
function generateAgoraToken(channelName: string, userId: string, _role: 'client' | 'host'): string {
  const appId = process.env.AGORA_APP_ID!
  const appCertificate = process.env.AGORA_APP_CERTIFICATE!
  const uid = userIdToUid(userId)
  const agoraRole = RtcRole.PUBLISHER
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

/**
 * A switch for taking paid consultations offline, off by default.
 *
 * Kept because a payment provider having a bad afternoon should be one
 * variable rather than a deploy. Set RAZORPAY_MAINTENANCE=true to stop opening
 * pre-authorisations; anyone with a balance can still consult.
 */
const RAZORPAY_MAINTENANCE = process.env.RAZORPAY_MAINTENANCE === 'true'

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
    const lawyerName = `${lawyer.first_name ?? ''} ${lawyer.last_name ?? ''}`.trim()

    // ── Free credits ─────────────────────────────────────────────────────────
    // Checked before any gateway is touched. A call the client's credit covers
    // needs no payment at all, which is what makes the call flow testable
    // without a live payment switch sitting in the middle of it.
    const [{ data: account }, { data: wallet }] = await Promise.all([
      supabase.from('accounts').select('free_credit_paise').eq('id', user.id).maybeSingle(),
      supabase.from('wallets').select('balance').eq('account_id', user.id).maybeSingle(),
    ])

    // Both sources, because settlement spends both — free credit first, then
    // the wallet. Checking only the grant would refuse a client who had just
    // topped up.
    const freePaise = Number(account?.free_credit_paise ?? 0)
    const walletPaise = Math.round(Number(wallet?.balance ?? 0) * 100)
    const creditPaise = freePaise + walletPaise
    const perMinutePaise = feePerMinute * 100
    // Credit buys whole minutes only: a call that can't fund its first minute
    // would be cut off before anyone spoke.
    const affordableMinutes = Math.floor(creditPaise / perMinutePaise)

    if (affordableMinutes >= 1) {
      const grantedMinutes = Math.min(maxMinutes, affordableMinutes)
      const heldPaise = grantedMinutes * perMinutePaise

      const { data: consultation, error: dbErr } = await supabase
        .from('consultations')
        .insert({
          client_id: user.id,
          lawyer_id: lawyerId,
          type,
          status: 'pending',
          fee_per_minute: feePerMinute,
          payment_status: 'credits',
          credits_held_paise: heldPaise,
          hms_room_id: null,
        })
        .select('id')
        .single()

      if (dbErr || !consultation) {
        console.error('[consultations/initiate] credits insert failed', dbErr)
        res.status(500).json({ error: 'Failed to create consultation' }); return
      }

      // The Agora channel is the consultation id. Nothing is created server
      // side — the channel exists as soon as the first participant joins.
      //
      // Checked rather than fired and forgotten: /accept refuses a consultation
      // with no room id, so a silent failure here surfaces later as the lawyer
      // being told "Room not ready" for a call that looks fine to the client.
      const { error: roomErr } = await supabase.from('consultations').update({
        hms_room_id: consultation.id,
        hms_session_id: consultation.id,
      }).eq('id', consultation.id)

      if (roomErr) {
        console.error('[consultations/initiate] could not set channel', roomErr)
        await supabase.from('consultations')
          .update({ status: 'cancelled', payment_status: 'unpaid' })
          .eq('id', consultation.id)
        res.status(500).json({ error: 'Could not open the call room. Please try again.' })
        return
      }

      // Ring the lawyer. The insert is what Supabase Realtime picks up and the
      // SSE stream relays to their dashboard; 20 seconds is the window they
      // have to answer before it lapses.
      await supabase.from('consultation_notifications').insert({
        consultation_id: consultation.id,
        lawyer_id: lawyerId,
        client_id: user.id,
        type,
        expires_at: new Date(Date.now() + 20_000).toISOString(),
      })

      // And push it to their devices. The row above only reaches a lawyer with
      // a tab open; this is what reaches a phone in a pocket. Deliberately not
      // awaited — a push that is slow, or a device that has gone away, must not
      // delay the response the caller is waiting on.
      void sendPushToAccount(lawyerId, {
        title: `Incoming ${type} consultation`,
        body: 'A client is calling now. Tap to answer.',
        url: `/consultation/${consultation.id}`,
        tag: `call-${consultation.id}`,
        kind: 'call',
      }).catch(err => logger.warn({ err }, '[initiate] call push failed'))

      res.status(201).json({
        consultationId: consultation.id,
        fundedBy: 'balance',
        channelName: consultation.id,
        agoraAppId: process.env.AGORA_APP_ID!,
        authToken: generateAgoraToken(consultation.id, user.id, 'client'),
        uid: userIdToUid(user.id),
        creditHeldPaise: heldPaise,
        creditBalancePaise: creditPaise,
        lawyerName,
        type,
        feePerMinute,
        maxMinutes: grantedMinutes,
      })
      return
    }

    // ── Paid ─────────────────────────────────────────────────────────────────
    // Not enough balance for a single minute. Topping up the wallet is the
    // route rather than a per-call charge: it is one payment for many
    // consultations, and it keeps the gateway out of the path of a ringing
    // phone.
    //
    // 402, not 503: the client maps 5xx to "Service temporarily unavailable",
    // which told the caller their connection had failed when in fact their free
    // credit had simply run out — two very different things, and only one of
    // them is worth retrying.
    if (RAZORPAY_MAINTENANCE) {
      const rupees = (creditPaise / 100).toFixed(2).replace(/\.00$/, '')
      res.status(402).json({
        error: creditPaise > 0
          ? `Your balance is ₹${rupees}, which is less than one minute at ₹${feePerMinute}/min. Top up your wallet to continue.`
          : 'Your balance is empty. Top up your wallet to start a consultation.',
        code: 'OUT_OF_CREDIT',
        creditBalancePaise: creditPaise,
        feePerMinute,
      })
      return
    }

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
      fundedBy: 'razorpay',
      razorpayOrderId: order.id,
      amount: amountPaise,
      currency: 'INR',
      lawyerName,
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

    const payment = await razorpay.payments.fetch(razorpayPaymentId) as { order_id: string; status: string }
    if (payment.order_id !== consultation.razorpay_order_id) {
      res.status(400).json({ error: 'Payment does not match consultation' }); return
    }
    if (payment.status !== 'authorized' && payment.status !== 'captured') {
      res.status(400).json({ error: 'Payment not authorized' }); return
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

/**
 * Settles a consultation: measures it, charges it, closes it.
 *
 * One implementation, two callers: the call room hanging up and the portal's
 * Mark complete button. Billing that lives in several places is billing that
 * disagrees with itself, and a consultation ended one way should cost exactly
 * what it costs ended another.
 *
 * Agora's channel-destroy webhook keeps its own copy for now, because it also
 * captures a Razorpay pre-authorisation — a path this does not cover and which
 * should not be quietly deleted while the gateway is only paused.
 *
 * Safe to call twice: an already-settled consultation is returned untouched,
 * and the credit debit refuses to charge the same consultation again.
 */
export async function settleConsultation(id: string): Promise<{
  ok: boolean
  answered: boolean
  durationSeconds: number
  totalAmount: number
  creditsChargedPaise: number | null
  alreadySettled?: boolean
}> {
  const { data: consultation, error } = await supabase
    .from('consultations').select('*').eq('id', id).maybeSingle()

  if (error) throw error
  if (!consultation) throw new Error('Consultation not found')

  // Whoever finishes second finds it done.
  if (consultation.status === 'completed' || consultation.credits_charged_paise !== null) {
    return {
      ok: true,
      alreadySettled: true,
      answered: Boolean(consultation.started_at),
      durationSeconds: consultation.duration_seconds ?? 0,
      totalAmount: Number(consultation.total_amount ?? 0),
      creditsChargedPaise: consultation.credits_charged_paise ?? null,
    }
  }

  const endedAt = new Date()
  const startedAt = consultation.started_at ? new Date(consultation.started_at) : null

  // started_at is stamped when the lawyer joins. Without it nobody ever did, so
  // this is a missed call: recorded, and free.
  if (!startedAt) {
    await supabase.from('consultations').update({
      status: 'cancelled',
      ended_at: endedAt.toISOString(),
      duration_seconds: 0,
      total_amount: 0,
      credits_charged_paise: consultation.payment_status === 'credits' ? 0 : null,
    }).eq('id', id)

    return { ok: true, answered: false, durationSeconds: 0, totalAmount: 0, creditsChargedPaise: 0 }
  }

  const durationSeconds = Math.max(0, Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000))
  const feePerMinute = Number(consultation.fee_per_minute)
  const totalAmount = Math.max(
    Math.ceil((durationSeconds / 60) * feePerMinute),
    feePerMinute, // a call that connected bills at least its first minute
  )

  let creditsChargedPaise: number | null = null
  if (consultation.payment_status === 'credits') {
    const { data: charged, error: creditErr } = await supabase.rpc('charge_consultation_credits', {
      p_consultation_id: id,
      p_amount_paise: totalAmount * 100,
    })
    if (creditErr) {
      logger.error({ err: creditErr.message, consultationId: id }, '[settle] credit debit failed')
      throw new Error('Could not settle this consultation.')
    }
    creditsChargedPaise = Number(charged ?? 0)
  }

  const { error: updateErr } = await supabase.from('consultations').update({
    status: 'completed',
    ended_at: endedAt.toISOString(),
    duration_seconds: durationSeconds,
    total_amount: totalAmount,
  }).eq('id', id)
  if (updateErr) throw updateErr

  logger.info({ consultationId: id, durationSeconds, totalAmount, creditsChargedPaise }, '[settle] done')

  return { ok: true, answered: true, durationSeconds, totalAmount, creditsChargedPaise }
}

// ── GET /api/consultations/lawyer?status= ────────────────────────────────────
/**
 * The lawyer's own consultations, for the portal list.
 *
 * The portal has been calling this since it was written and it did not exist —
 * apiGetPortalConsultations caught the 404 and returned an empty array, so the
 * Consultations page and "Today's consultations" were permanently empty no
 * matter how many calls had happened.
 *
 * The portal's tabs and the database do not use the same words, and that gap is
 * the whole reason this needs a mapping rather than a passthrough:
 *
 *   pending   → pending      waiting for this lawyer to answer
 *   upcoming  → in_progress  answered and running now
 *   completed → completed
 *   cancelled → cancelled    declined, missed, or hung up before anyone joined
 *
 * MUST be registered before GET /:id-shaped routes.
 */
router.get('/lawyer', async (req: Request, res: Response) => {
  try {
    const user = await getAuthUser(req)
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return }
    if (user.role !== 'lawyer') { res.status(403).json({ error: 'Not a lawyer account' }); return }

    const TAB_TO_STATUS: Record<string, string[]> = {
      pending:   ['pending'],
      upcoming:  ['in_progress'],
      active:    ['in_progress'],
      completed: ['completed'],
      cancelled: ['cancelled'],
    }

    const tab = String(req.query.status ?? '')
    const statuses = TAB_TO_STATUS[tab]

    let query = supabase
      .from('consultations')
      .select('id, type, status, client_id, started_at, ended_at, duration_seconds, fee_per_minute, total_amount, hms_room_id, created_at')
      .eq('lawyer_id', user.id)
      .order('created_at', { ascending: false })
      .limit(100)

    if (statuses) query = query.in('status', statuses)

    const { data, error } = await query
    if (error) throw error
    const rows = data ?? []

    // Client names in one round trip rather than one per row.
    const clientIds = [...new Set(rows.map(r => r.client_id).filter(Boolean))]
    const names = new Map<string, string>()
    if (clientIds.length) {
      const { data: accounts } = await supabase
        .from('accounts')
        .select('id, first_name, last_name')
        .in('id', clientIds)
      for (const a of accounts ?? []) {
        names.set(a.id, [a.first_name, a.last_name].filter(Boolean).join(' ').trim() || 'Client')
      }
    }

    res.json(rows.map(r => ({
      id: r.id,
      type: r.type,
      // Reported in the portal's own vocabulary, so the tab a row arrives in
      // matches the badge printed on it.
      status: r.status === 'in_progress' ? 'active' : r.status,
      scheduledAt: r.started_at ?? r.created_at,
      clientName: names.get(r.client_id) ?? 'Client',
      clientId: r.client_id,
      caseNote: null,
      postCallNote: null,
      durationMin: r.duration_seconds != null ? Math.round(r.duration_seconds / 60) : null,
      fee: Number(r.total_amount ?? 0) || Number(r.fee_per_minute ?? 0),
      agoraChannel: r.hms_room_id ?? r.id,
    })))
  } catch (err) {
    console.error('[consultations/lawyer]', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── PATCH /api/consultations/:id/complete ────────────────────────────────────
/**
 * Marks a consultation finished from the portal list.
 *
 * The button existed and the route did not. Settlement is the same path a
 * hang-up takes, so a call closed from here is billed and recorded identically
 * to one closed from the room — there is no second way to end a consultation,
 * only a second place to press it.
 */
router.patch('/:id/complete', async (req: Request, res: Response) => {
  try {
    const user = await getAuthUser(req)
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return }

    const { data: consultation } = await supabase
      .from('consultations')
      .select('lawyer_id')
      .eq('id', String(req.params.id))
      .maybeSingle()

    if (!consultation) { res.status(404).json({ error: 'Consultation not found' }); return }
    if (consultation.lawyer_id !== user.id) { res.status(403).json({ error: 'Not your consultation' }); return }

    await settleConsultation(String(req.params.id))
    res.json({ ok: true })
  } catch (err) {
    console.error('[consultations/complete]', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /api/consultations/incoming ──────────────────────────────────────────
/**
 * The call ringing for this lawyer right now, if any.
 *
 * A fallback for the Server-Sent Events stream, which has proved fragile in
 * ways that are invisible from the browser: a rewrite that buffers the body, an
 * ad blocker, a proxy that closes idle connections. In every one of those the
 * connection looks healthy and simply never delivers, and a lawyer marked
 * Available silently misses every call.
 *
 * Polling this is unglamorous and cannot fail the same way. SSE stays as the
 * fast path; this is what makes the feature work when it does not arrive.
 *
 * Only unexpired rings, and only ones addressed to the caller.
 */
router.get('/incoming', async (req: Request, res: Response) => {
  try {
    const user = await getAuthUser(req)
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return }
    if (user.role !== 'lawyer') { res.json({ call: null }); return }

    const { data, error } = await supabase
      .from('consultation_notifications')
      .select('consultation_id, client_id, type, expires_at')
      .eq('lawyer_id', user.id)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) throw error
    if (!data) { res.json({ call: null }); return }

    // The ring row outlives the consultation's pending state — a caller who
    // hung up leaves the row behind for its full twenty seconds. Ringing for a
    // call nobody is waiting on is worse than not ringing at all.
    const { data: consultation } = await supabase
      .from('consultations')
      .select('status')
      .eq('id', data.consultation_id)
      .maybeSingle()

    if (!consultation || consultation.status !== 'pending') {
      res.json({ call: null }); return
    }

    res.json({
      call: {
        consultationId: data.consultation_id,
        clientId: data.client_id,
        type: data.type,
        expiresAt: data.expires_at,
      },
    })
  } catch (err) {
    console.error('[consultations/incoming]', err)
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
      .select('id, client_id, lawyer_id, status, type, hms_room_id, started_at, fee_per_minute')
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

    /**
     * The lawyer asking for a token IS the lawyer joining.
     *
     * started_at was only ever stamped by PATCH /:id/accept, and nothing in the
     * frontend has ever called it — the ring banner navigates straight to the
     * room. So started_at stayed null on every consultation, every call was
     * settled as one nobody answered, and the Completed tab stayed empty while
     * two people were talking to each other.
     *
     * Stamping it here also makes it truer than the button would: the moment
     * their browser asks for credentials is the moment they are actually
     * joining, not the moment they clicked.
     */
    if (isLawyer && !consultation.started_at) {
      const startedAt = new Date().toISOString()
      const { error: startErr } = await supabase
        .from('consultations')
        .update({ status: 'in_progress', started_at: startedAt })
        .eq('id', consultationId)

      if (startErr) {
        // Not fatal to the call, but it decides what gets billed, so it is
        // logged loudly rather than swallowed.
        logger.error({ err: startErr.message, consultationId }, '[agora-token] could not stamp started_at')
      } else {
        consultation.started_at = startedAt
        consultation.status = 'in_progress'
        await createNotification({
          accountId: consultation.client_id,
          title: 'Your lawyer has joined',
          message: 'The consultation is starting now.',
          type: 'consultation',
          link: `/consultation/${consultationId}`,
        }).catch(() => { /* the client is already in the room */ })
      }
    }

    // The lawyer is the host; the client joins as an audience-capable publisher.
    const channelName = consultation.hms_room_id || consultation.id
    const token = generateAgoraToken(channelName, user.id, isLawyer ? 'host' : 'client')

    // Who the other person is, so the room can name them instead of saying
    // "Your lawyer" over a real consultation.
    const counterpartId = isLawyer ? consultation.client_id : consultation.lawyer_id
    const { data: counterpart } = await supabase
      .from('accounts')
      .select('first_name, last_name')
      .eq('id', counterpartId)
      .maybeSingle()

    const counterpartName =
      [counterpart?.first_name, counterpart?.last_name].filter(Boolean).join(' ').trim() || null

    res.json({
      consultationId,
      channelName,
      agoraAppId: process.env.AGORA_APP_ID!,
      token,
      uid: userIdToUid(user.id),
      role: isLawyer ? 'lawyer' : 'client',
      type: consultation.type,
      status: consultation.status,
      counterpartId,
      counterpartName,
      feePerMinute: Number(consultation.fee_per_minute) || null,
    })
  } catch (err) {
    console.error('[consultations/agora-token]', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST /api/consultations/:id/end ──────────────────────────────────────────
/**
 * Ends a consultation from the call screen.
 *
 * The room has been calling this since it was written, behind a catch that
 * shrugged if it 404'd — and it did, because the route never existed. Nothing
 * recorded the call: no duration, no completion, no charge, and nothing in the
 * lawyer's Completed tab.
 *
 * Settlement was left entirely to Agora's channel-destroy webhook, which is a
 * poor sole owner of the record. It arrives late, only when the last person
 * leaves, and only if the console is still pointed at us. Hanging up is the
 * moment we actually know about, so it is the moment we write.
 *
 * Both paths are safe together: charge_consultation_credits() refuses to
 * charge a consultation twice, and the guards below skip one already
 * completed, so whichever arrives second changes nothing.
 */
router.post('/:id/end', async (req: Request, res: Response) => {
  try {
    const user = await getAuthUser(req)
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return }

    const id = String(req.params.id)
    const { data: consultation } = await supabase
      .from('consultations').select('client_id, lawyer_id').eq('id', id).maybeSingle()

    if (!consultation) { res.status(404).json({ error: 'Consultation not found' }); return }
    if (consultation.client_id !== user.id && consultation.lawyer_id !== user.id) {
      res.status(403).json({ error: 'You are not a participant in this consultation' }); return
    }

    res.json(await settleConsultation(id))
  } catch (err) {
    console.error('[consultations/end]', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Chat ─────────────────────────────────────────────────────────────────────

/**
 * The conversation for a consultation, created on first use.
 *
 * Lazily rather than at accept time: whoever opens the room first creates it,
 * so a conversation exists only once somebody has looked, and there is no
 * ordering to get wrong between the two participants arriving.
 *
 * Returns an error marker when the caller is not a participant — the check
 * belongs here, once, rather than in each route that reads or writes messages.
 */
async function conversationFor(consultationId: string, userId: string) {
  const { data: consultation } = await supabase
    .from('consultations')
    .select('id, client_id, lawyer_id, status, started_at, ended_at')
    .eq('id', consultationId)
    .maybeSingle()

  if (!consultation) return { error: 'not_found' as const }
  if (consultation.client_id !== userId && consultation.lawyer_id !== userId) {
    return { error: 'forbidden' as const }
  }

  const { data: existing } = await supabase
    .from('conversations')
    .select('id')
    .eq('consultation_id', consultationId)
    .maybeSingle()

  if (existing) return { conversationId: existing.id, consultation }

  const { data: created, error: createErr } = await supabase
    .from('conversations')
    .insert({ type: 'consultation', consultation_id: consultationId })
    .select('id')
    .single()

  if (createErr || !created) {
    // Two participants opening the room at once both insert; the unique index
    // on consultation_id lets exactly one win. The loser reads the winner's row
    // rather than failing, which is the whole point of the index.
    const { data: raced } = await supabase
      .from('conversations')
      .select('id')
      .eq('consultation_id', consultationId)
      .maybeSingle()
    if (raced) return { conversationId: raced.id, consultation }

    logger.error({ err: createErr?.message, consultationId }, '[chat] could not open conversation')
    return { error: 'failed' as const }
  }

  await supabase.from('conversation_participants').insert([
    { conversation_id: created.id, account_id: consultation.client_id },
    { conversation_id: created.id, account_id: consultation.lawyer_id },
  ])

  return { conversationId: created.id, consultation }
}

// ── GET /api/consultations/:id/messages ──────────────────────────────────────
/** Full history, oldest first — a transcript is read in the order it happened. */
router.get('/:id/messages', async (req: Request, res: Response) => {
  try {
    const user = await getAuthUser(req)
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return }

    const found = await conversationFor(String(req.params.id), user.id)
    if ('error' in found) {
      const status = found.error === 'not_found' ? 404 : found.error === 'forbidden' ? 403 : 500
      res.status(status).json({ error: found.error === 'forbidden' ? 'Not your consultation' : 'Conversation unavailable' })
      return
    }

    const { data, error } = await supabase
      .from('messages')
      .select('id, sender_id, content, attachment_url, attachment_name, attachment_size, created_at')
      .eq('conversation_id', found.conversationId)
      .order('created_at', { ascending: true })
      .limit(500)

    if (error) throw error

    res.json({
      conversationId: found.conversationId,
      messages: data ?? [],
      selfId: user.id,
      status: found.consultation.status,
      startedAt: found.consultation.started_at,
      endedAt: found.consultation.ended_at,
    })
  } catch (err) {
    console.error('[consultations/messages GET]', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST /api/consultations/:id/messages ─────────────────────────────────────
/**
 * Persist first, deliver second.
 *
 * The row is the record; realtime delivery is a consequence of it. Written this
 * way round, a message survives a reload, a dropped connection and a browser
 * closing mid-sentence — none of which is true of anything that only ever
 * existed in transit.
 */
router.post('/:id/messages', validateBody(messageSendSchema), async (req: Request, res: Response) => {
  try {
    const user = await getAuthUser(req)
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return }

    const consultationId = String(req.params.id)
    const found = await conversationFor(consultationId, user.id)
    if ('error' in found) {
      const status = found.error === 'not_found' ? 404 : found.error === 'forbidden' ? 403 : 500
      res.status(status).json({ error: found.error === 'forbidden' ? 'Not your consultation' : 'Conversation unavailable' })
      return
    }

    if (found.consultation.status === 'completed' || found.consultation.status === 'cancelled') {
      res.status(409).json({ error: 'This consultation has ended.' })
      return
    }

    const { content, attachmentUrl, attachmentName, attachmentSize } =
      req.body as { content?: string; attachmentUrl?: string; attachmentName?: string; attachmentSize?: number }

    const { data: message, error } = await supabase
      .from('messages')
      .insert({
        conversation_id: found.conversationId,
        sender_id: user.id,
        content: content ?? null,
        attachment_url: attachmentUrl ?? null,
        attachment_name: attachmentName ?? null,
        attachment_size: attachmentSize ?? null,
      })
      .select('id, sender_id, content, attachment_url, attachment_name, attachment_size, created_at')
      .single()

    if (error) throw error

    // Tell the other side, for the case where they are not looking at the room.
    const other = found.consultation.client_id === user.id
      ? found.consultation.lawyer_id
      : found.consultation.client_id

    void sendPushToAccount(other, {
      title: 'New message',
      body: content?.slice(0, 120) || (attachmentName ? `Sent ${attachmentName}` : 'Sent a document'),
      url: `/consultation/${consultationId}`,
      tag: `chat-${consultationId}`,
    }).catch(() => { /* the message is saved either way */ })

    res.status(201).json({ message })
  } catch (err) {
    console.error('[consultations/messages POST]', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /api/consultations/:id/attachment ────────────────────────────────────
/**
 * Redirects to a freshly signed URL for one attachment in this consultation.
 *
 * The bucket is private, so the stored path renders nothing on its own. Signed
 * per request rather than stored, because a signed URL expires and a document
 * attached to a legal matter has to keep opening. The path is checked against
 * the consultation so a participant cannot read another matter's files by
 * editing the query string.
 */
router.get('/:id/attachment', async (req: Request, res: Response) => {
  try {
    const user = await getAuthUser(req)
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return }

    const consultationId = String(req.params.id)
    const path = String(req.query.path ?? '')

    const { data: consultation } = await supabase
      .from('consultations')
      .select('client_id, lawyer_id')
      .eq('id', consultationId)
      .maybeSingle()

    if (!consultation) { res.status(404).json({ error: 'Not found' }); return }
    if (consultation.client_id !== user.id && consultation.lawyer_id !== user.id) {
      res.status(403).json({ error: 'Not your consultation' }); return
    }

    // The prefix is the authorisation: a path outside this consultation's
    // folder is not this consultation's document, whoever is asking.
    if (!path.startsWith(`chat/${consultationId}/`)) {
      res.status(403).json({ error: 'Not a document from this consultation' }); return
    }

    const { data: signed, error } = await supabase.storage
      .from('legalx-lawyer-docs')
      .createSignedUrl(path, 3600)

    if (error || !signed?.signedUrl) { res.status(404).json({ error: 'Not found' }); return }

    res.set('Cache-Control', 'private, max-age=1800')
    res.redirect(302, signed.signedUrl)
  } catch (err) {
    console.error('[consultations/attachment]', err)
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

    // One review per client per target, so a second consultation with the same
    // lawyer updates the existing rating rather than colliding with it. The
    // unique key made that a 500 the client was told to retry.
    const { error: insertErr } = await supabase.from('reviews').upsert({
      account_id: user.id,
      target_type: targetType,
      target_id: targetId,
      rating,
      comment: comment || null,
    }, { onConflict: 'account_id,target_type,target_id' })
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
