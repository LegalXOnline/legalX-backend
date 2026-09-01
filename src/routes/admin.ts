import { Router, Request, Response, NextFunction } from 'express'
import { supabase, supabaseAuthValidator } from '../lib/supabase'
import { logger } from '../lib/logger'
import {
  validateBody,
  validateParams,
  validateQuery,
  lawyerIdParamSchema,
  accountIdParamSchema,
  adminLawyerRejectBodySchema,
  adminListQuerySchema,
  adminAuditQuerySchema,
  adminSuspendBodySchema,
  adminReinstateBodySchema,
  adminFlagBodySchema,
  adminBulkLawyerSchema,
  adminWalletAdjustSchema,
  adminDisputeUpdateSchema,
  adminPayoutGenerateSchema,
  adminPayoutHoldSchema,
  adminPayoutStatusSchema,
  adminArticleSchema,
  adminArticleUpdateSchema,
  uuidParamSchema,
  shortsIngestSchema,
  shortsUpdateSchema,
  shortsBulkSchema,
  shortsAutoIngestSchema,
} from '../lib/validation'
import { sendLawyerApproved, sendLawyerRejected } from '../lib/email'
import { createNotification } from '../lib/notify'
import { runIngest, draftFromSource } from '../lib/shortsPipeline'
import { FEED_SOURCES } from '../lib/sources/rss'

const router = Router()

// ── Audit trail ───────────────────────────────────────────────────────────────
/**
 * Records an admin mutation. Deliberately best-effort: by the time this runs
 * the mutation has already committed, so failing the response would tell the
 * admin their action didn't happen when it did. A failure is logged at error
 * level with the full entry so it can be reconstructed from the logs.
 */
async function writeAudit(
  req: Request,
  entry: {
    action: string
    entityType: string
    entityId?: string | null
    before?: unknown
    after?: unknown
  }
): Promise<void> {
  const adminId = (req as any).user?.id
  if (!adminId) return

  const row = {
    admin_id: adminId,
    action: entry.action,
    entity_type: entry.entityType,
    entity_id: entry.entityId ?? null,
    before_data: entry.before ?? null,
    after_data: entry.after ?? null,
    ip_address: req.ip ?? null,
  }

  const { error } = await supabase.from('audit_log').insert(row)
  if (error) {
    logger.error({ reqId: req.id, err: error.message, row }, 'AUDIT WRITE FAILED')
  }
}

/** Converts a 1-based page into the inclusive range Supabase expects. */
function pageRange(page: number, pageSize: number): [number, number] {
  const from = (page - 1) * pageSize
  return [from, from + pageSize - 1]
}

/** Escapes PostgREST `or`/`ilike` metacharacters in user-supplied search text. */
function escapeLike(term: string): string {
  return term.replace(/[%_,()]/g, '')
}

// ── Auth middleware — validates the HttpOnly cookie set by /api/auth/login ────
async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.lx_access_token || req.headers.authorization?.replace('Bearer ', '')
    if (!token) {
      return res.status(401).json({ error: 'Not authenticated' })
    }

    const { data, error } = await supabaseAuthValidator.auth.getUser(token)
    if (error || !data.user) {
      return res.status(401).json({ error: 'Invalid or expired session' })
    }

    // Get role from accounts table — source of truth
    const { data: account } = await supabase.from('accounts').select('role').eq('id', data.user.id).single()
    const role = account?.role ?? data.user.user_metadata?.role
    if (role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden — admin access only' })
    }

    // Attach user to request for downstream handlers
    ;(req as any).user = data.user
    next()
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }
}

// ── GET /api/admin/lawyers?status=&search=&page=&pageSize= ───────────────────
// `status=all` returns every lawyer. Omitting status keeps the historical
// default of the verification queue so existing callers don't change behaviour.
router.get('/lawyers', requireAdmin, validateQuery(adminListQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status = 'pending_verification', search, page, pageSize } = req.validatedQuery as any
    const [from, to] = pageRange(page, pageSize)

    let query = supabase
      .from('lawyer_profiles')
      .select(
        'account_id, first_name, last_name, email, phone, bar_council_number, bar_council_state, ' +
        'verification_status, specializations, consultation_types, document_services, avg_rating, ' +
        'total_reviews, consultation_fee_chat, consultation_fee_voice, consultation_fee_video, ' +
        'enrolment_cert_url, bar_id_front_url, bar_id_back_url, govt_id_url, profile_photo_url, ' +
        'rejection_reason, onboarding_complete, created_at',
        { count: 'exact' }
      )

    if (status !== 'all') query = query.eq('verification_status', status)

    if (search) {
      const term = escapeLike(search)
      if (term) {
        query = query.or(
          `first_name.ilike.%${term}%,last_name.ilike.%${term}%,` +
          `email.ilike.%${term}%,bar_council_number.ilike.%${term}%`
        )
      }
    }

    // Oldest first for the queue — the longest-waiting applicant is the most
    // urgent. Other tabs read better newest-first.
    const oldestFirst = status === 'pending_verification'
    const { data, error, count } = await query
      .order('created_at', { ascending: oldestFirst })
      .range(from, to)

    if (error) throw error
    res.json({ lawyers: data ?? [], total: count ?? 0, page, pageSize })
  } catch (err) {
    next(err)
  }
})

// ── GET /api/admin/lawyers/:id ────────────────────────────────────────────────
// Full profile + bank details + disciplinary history + signed document URLs.
router.get('/lawyers/:id', requireAdmin, validateParams(lawyerIdParamSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id)

    const { data: profile, error } = await supabase
      .from('lawyer_profiles')
      .select('*')
      .eq('account_id', id)
      .single()

    if (error || !profile) return res.status(404).json({ error: 'Lawyer not found' })

    const [bankRes, flagsRes, accountRes] = await Promise.all([
      supabase.from('lawyer_bank_details')
        .select('account_holder_name, bank_name, ifsc_code, gst_number, is_verified, updated_at')
        .eq('lawyer_id', id).maybeSingle(),
      supabase.from('disciplinary_flags')
        .select('id, type, reason, flagged_by, created_at')
        .eq('lawyer_id', id).order('created_at', { ascending: false }),
      supabase.from('accounts')
        .select('status, last_login_at, created_at').eq('id', id).maybeSingle(),
    ])

    // Signed URLs are minted per request and expire in 24h, so a leaked admin
    // page doesn't hand out permanent access to identity documents.
    const docFields: Record<string, string | null> = {
      enrolment_cert: profile.enrolment_cert_url,
      bar_id_front:   profile.bar_id_front_url,
      bar_id_back:    profile.bar_id_back_url,
      govt_id:        profile.govt_id_url,
      profile_photo:  profile.profile_photo_url,
    }
    const docs: Record<string, string | null> = {}
    for (const [key, path] of Object.entries(docFields)) {
      if (!path) { docs[key] = null; continue }
      const { data: signed } = await supabase.storage
        .from('legalx-lawyer-docs')
        .createSignedUrl(path, 86400)
      docs[key] = signed?.signedUrl ?? null
    }

    return res.json({
      profile,
      account: accountRes.data ?? null,
      bank: bankRes.data ?? null,
      flags: flagsRes.data ?? [],
      docs,
    })
  } catch (err) {
    next(err)
  }
})

// ── PATCH /api/admin/lawyers/:id/suspend ─────────────────────────────────────
router.patch('/lawyers/:id/suspend', requireAdmin, validateParams(lawyerIdParamSchema), validateBody(adminSuspendBodySchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id)
    const { reason } = req.body

    const { data: prev } = await supabase
      .from('lawyer_profiles').select('verification_status').eq('account_id', id).maybeSingle()
    if (!prev) return res.status(404).json({ error: 'Lawyer not found' })

    const { error } = await supabase
      .from('lawyer_profiles')
      .update({ verification_status: 'suspended', is_online: false, updated_at: new Date().toISOString() })
      .eq('account_id', id)
    if (error) throw error

    await supabase.from('disciplinary_flags').insert({
      lawyer_id: id, type: 'suspension', reason, flagged_by: (req as any).user.id,
    })

    await writeAudit(req, {
      action: 'SUSPEND_LAWYER', entityType: 'lawyer', entityId: id,
      before: { verification_status: prev.verification_status },
      after: { verification_status: 'suspended', reason },
    })

    return res.json({ message: 'Lawyer suspended' })
  } catch (err) {
    next(err)
  }
})

// ── PATCH /api/admin/lawyers/:id/reinstate ───────────────────────────────────
router.patch('/lawyers/:id/reinstate', requireAdmin, validateParams(lawyerIdParamSchema), validateBody(adminReinstateBodySchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id)
    const reason = req.body.reason || 'Reinstated by admin'

    const { data: prev } = await supabase
      .from('lawyer_profiles').select('verification_status').eq('account_id', id).maybeSingle()
    if (!prev) return res.status(404).json({ error: 'Lawyer not found' })

    const { error } = await supabase
      .from('lawyer_profiles')
      .update({ verification_status: 'verified', updated_at: new Date().toISOString() })
      .eq('account_id', id)
    if (error) throw error

    await supabase.from('disciplinary_flags').insert({
      lawyer_id: id, type: 'reinstatement', reason, flagged_by: (req as any).user.id,
    })

    await writeAudit(req, {
      action: 'REINSTATE_LAWYER', entityType: 'lawyer', entityId: id,
      before: { verification_status: prev.verification_status },
      after: { verification_status: 'verified', reason },
    })

    return res.json({ message: 'Lawyer reinstated' })
  } catch (err) {
    next(err)
  }
})

// ── POST /api/admin/lawyers/:id/flag ─────────────────────────────────────────
router.post('/lawyers/:id/flag', requireAdmin, validateParams(lawyerIdParamSchema), validateBody(adminFlagBodySchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id)
    const { type, reason } = req.body

    const { data: exists } = await supabase
      .from('lawyer_profiles').select('account_id').eq('account_id', id).maybeSingle()
    if (!exists) return res.status(404).json({ error: 'Lawyer not found' })

    const { data: flag, error } = await supabase
      .from('disciplinary_flags')
      .insert({ lawyer_id: id, type, reason, flagged_by: (req as any).user.id })
      .select('id, type, reason, created_at')
      .single()
    if (error) throw error

    await writeAudit(req, {
      action: 'FLAG_LAWYER', entityType: 'lawyer', entityId: id,
      after: { type, reason },
    })

    return res.status(201).json({ flag })
  } catch (err) {
    next(err)
  }
})

// ── POST /api/admin/lawyers/bulk ─────────────────────────────────────────────
// Applies one action to many lawyers. Each is processed independently so a
// single bad row cannot roll back the rest, and the response reports both
// sides rather than a bare success.
router.post('/lawyers/bulk', requireAdmin, validateBody(adminBulkLawyerSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ids, action, reason } = req.body
    const approving = action === 'approve'

    const { data: targets, error: fetchErr } = await supabase
      .from('lawyer_profiles')
      .select('account_id, email, first_name, verification_status')
      .in('account_id', ids)
    if (fetchErr) throw fetchErr

    const found = new Set((targets ?? []).map(t => t.account_id))
    const succeeded: string[] = []
    const failed: { id: string; error: string }[] = ids
      .filter((id: string) => !found.has(id))
      .map((id: string) => ({ id, error: 'Lawyer not found' }))

    for (const target of targets ?? []) {
      const update = approving
        ? { verification_status: 'verified', verified_at: new Date().toISOString(), updated_at: new Date().toISOString() }
        : { verification_status: 'rejected', rejection_reason: reason ?? null, updated_at: new Date().toISOString() }

      const { error } = await supabase
        .from('lawyer_profiles').update(update).eq('account_id', target.account_id)

      if (error) {
        failed.push({ id: target.account_id, error: error.message })
        continue
      }
      succeeded.push(target.account_id)

      if (target.email) {
        const name = target.first_name ?? 'Advocate'
        const send = approving
          ? sendLawyerApproved(target.email, name)
          : sendLawyerRejected(target.email, name, reason ?? 'Your documents could not be verified.')
        send.catch(err => logger.error({ err }, 'bulk lawyer email failed'))
      }
    }

    await writeAudit(req, {
      action: approving ? 'BULK_APPROVE_LAWYERS' : 'BULK_REJECT_LAWYERS',
      entityType: 'lawyer',
      entityId: null,
      before: { requested: ids },
      after: { succeeded, failed, reason: reason ?? null },
    })

    res.json({ succeeded, failed })
  } catch (err) {
    next(err)
  }
})

// ── GET /api/admin/clients ───────────────────────────────────────────────────
router.get('/clients', requireAdmin, validateQuery(adminListQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { search, page, pageSize } = req.validatedQuery as any
    const [from, to] = pageRange(page, pageSize)

    let query = supabase
      .from('accounts')
      .select('id, email, phone, first_name, last_name, status, created_at, last_login_at', { count: 'exact' })
      .eq('role', 'client')

    if (search) {
      const term = escapeLike(search)
      if (term) {
        query = query.or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%,email.ilike.%${term}%`)
      }
    }

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(from, to)
    if (error) throw error

    const clients = data ?? []

    // Balances live in `wallets`, keyed by account. Fetched in one batch for
    // the page rather than per row.
    const ids = clients.map(c => c.id)
    const balances = new Map<string, number>()
    if (ids.length) {
      const { data: wallets } = await supabase
        .from('wallets').select('account_id, balance').in('account_id', ids)
      for (const w of wallets ?? []) balances.set(w.account_id, Number(w.balance ?? 0))
    }

    res.json({
      clients: clients.map(c => ({ ...c, wallet_balance: balances.get(c.id) ?? 0 })),
      total: count ?? 0,
      page,
      pageSize,
    })
  } catch (err) {
    next(err)
  }
})

// ── GET /api/admin/clients/:id ───────────────────────────────────────────────
router.get('/clients/:id', requireAdmin, validateParams(accountIdParamSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id)

    const { data: account, error } = await supabase
      .from('accounts')
      .select('id, email, phone, first_name, last_name, role, status, created_at, last_login_at')
      .eq('id', id)
      .maybeSingle()
    if (error) throw error
    if (!account) return res.status(404).json({ error: 'Client not found' })

    const { data: wallet } = await supabase
      .from('wallets').select('id, balance, currency, updated_at').eq('account_id', id).maybeSingle()

    const [txnRes, disputesRes, consultRes] = await Promise.all([
      wallet
        ? supabase.from('wallet_transactions')
            .select('id, type, amount, balance_after, reference_type, reference_id, note, created_at')
            .eq('wallet_id', wallet.id).order('created_at', { ascending: false }).limit(100)
        : Promise.resolve({ data: [] as any[] }),
      supabase.from('disputes')
        .select('id, reason, status, created_at, resolution_note')
        .eq('client_id', id).order('created_at', { ascending: false }),
      supabase.from('consultations')
        .select('id, type, status, total_amount, started_at')
        .eq('client_id', id).order('created_at', { ascending: false }).limit(50),
    ])

    const transactions = txnRes.data ?? []
    const lifetimeSpend = transactions
      .filter(t => t.type === 'debit')
      .reduce((sum, t) => sum + Number(t.amount ?? 0), 0)

    return res.json({
      account,
      wallet: wallet ?? null,
      transactions,
      disputes: disputesRes.data ?? [],
      consultations: consultRes.data ?? [],
      lifetimeSpend,
    })
  } catch (err) {
    next(err)
  }
})

// ── PATCH /api/admin/clients/:id/wallet ──────────────────────────────────────
// Manual balance adjustment. Writes the ledger entry and the audit record so a
// credit can always be traced back to the admin who granted it and why.
router.patch('/clients/:id/wallet', requireAdmin, validateParams(accountIdParamSchema), validateBody(adminWalletAdjustSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id)
    const { amount, type, reason } = req.body

    const { data: account } = await supabase
      .from('accounts').select('id').eq('id', id).maybeSingle()
    if (!account) return res.status(404).json({ error: 'Client not found' })

    let { data: wallet } = await supabase
      .from('wallets').select('id, balance').eq('account_id', id).maybeSingle()

    if (!wallet) {
      const { data: created, error: createErr } = await supabase
        .from('wallets').insert({ account_id: id, balance: 0 }).select('id, balance').single()
      if (createErr) throw createErr
      wallet = created
    }

    const previous = Number(wallet!.balance ?? 0)
    const delta = type === 'credit' ? amount : -amount
    const next = previous + delta

    if (next < 0) {
      return res.status(400).json({
        error: `Insufficient balance. Current balance is ₹${previous.toFixed(2)}.`,
      })
    }

    const { error: updateErr } = await supabase
      .from('wallets')
      .update({ balance: next, updated_at: new Date().toISOString() })
      .eq('id', wallet!.id)
    if (updateErr) throw updateErr

    const { error: txnErr } = await supabase.from('wallet_transactions').insert({
      wallet_id: wallet!.id,
      type,
      amount,
      balance_after: next,
      reference_type: 'admin_adjustment',
      note: reason,
    })
    if (txnErr) {
      logger.error({ reqId: req.id, err: txnErr.message }, 'wallet ledger insert failed after balance update')
    }

    await writeAudit(req, {
      action: 'ADJUST_CLIENT_WALLET', entityType: 'client', entityId: id,
      before: { balance: previous },
      after: { balance: next, amount, type, reason },
    })

    await createNotification({
      accountId: id,
      title: type === 'credit' ? 'XCoins added' : 'XCoins deducted',
      message: `₹${amount.toLocaleString('en-IN')} was ${type === 'credit' ? 'added to' : 'deducted from'} your wallet. Reason: ${reason}`,
      type: 'wallet',
      link: '/',
    })

    return res.json({ balance: next, previousBalance: previous })
  } catch (err) {
    next(err)
  }
})

// ── GET /api/admin/audit-log ─────────────────────────────────────────────────
router.get('/audit-log', requireAdmin, validateQuery(adminAuditQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { entity_type, from: fromDate, to: toDate, page, pageSize } = req.validatedQuery as any
    const [from, to] = pageRange(page, pageSize)

    let query = supabase
      .from('audit_log')
      .select('id, admin_id, action, entity_type, entity_id, before_data, after_data, ip_address, created_at', { count: 'exact' })

    if (entity_type) query = query.eq('entity_type', entity_type)
    if (fromDate) query = query.gte('created_at', fromDate)
    if (toDate) query = query.lte('created_at', toDate)

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(from, to)
    if (error) throw error

    const entries = data ?? []

    // Resolve admin names in one batch so the feed isn't a wall of UUIDs.
    const adminIds = [...new Set(entries.map(e => e.admin_id).filter(Boolean))]
    const names = new Map<string, string>()
    if (adminIds.length) {
      const { data: admins } = await supabase
        .from('accounts').select('id, first_name, last_name, email').in('id', adminIds)
      for (const a of admins ?? []) {
        names.set(a.id, [a.first_name, a.last_name].filter(Boolean).join(' ') || a.email)
      }
    }

    res.json({
      entries: entries.map(e => ({ ...e, admin_name: names.get(e.admin_id) ?? 'Unknown' })),
      total: count ?? 0,
      page,
      pageSize,
    })
  } catch (err) {
    next(err)
  }
})

// ── PATCH /api/admin/lawyers/:id/approve ─────────────────────────────────────
router.patch('/lawyers/:id/approve', requireAdmin, validateParams(lawyerIdParamSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id)
    // Fetch lawyer details for email
    const { data: lawyer } = await supabase
      .from('lawyer_profiles')
      .select('email, first_name')
      .eq('account_id', id)
      .single()

    const { error } = await supabase
      .from('lawyer_profiles')
      .update({ verification_status: 'verified', verified_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('account_id', id)

    if (error) throw error

    // Send approval email
    if (lawyer?.email) {
      sendLawyerApproved(lawyer.email, lawyer.first_name ?? 'Advocate').catch(console.error)
    }

    await writeAudit(req, {
      action: 'APPROVE_LAWYER', entityType: 'lawyer', entityId: id,
      before: { verification_status: 'pending_verification' },
      after: { verification_status: 'verified' },
    })

    await createNotification({
      accountId: id,
      title: 'Your profile is approved',
      message: 'You are now live on LegalX and can start accepting consultations.',
      type: 'verification',
      link: '/lawyer-dashboard',
    })

    res.json({ message: 'Lawyer approved successfully' })
  } catch (err) {
    next(err)
  }
})

// ── PATCH /api/admin/lawyers/:id/reject ──────────────────────────────────────
router.patch('/lawyers/:id/reject', requireAdmin, validateParams(lawyerIdParamSchema), validateBody(adminLawyerRejectBodySchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id)
    const { reason } = req.body
    // Fetch lawyer details for email
    const { data: lawyer } = await supabase
      .from('lawyer_profiles')
      .select('email, first_name')
      .eq('account_id', id)
      .single()

    const { error } = await supabase
      .from('lawyer_profiles')
      .update({ verification_status: 'rejected', rejection_reason: reason ?? null, updated_at: new Date().toISOString() })
      .eq('account_id', id)

    if (error) throw error

    // Send rejection email with reason
    if (lawyer?.email) {
      sendLawyerRejected(lawyer.email, lawyer.first_name ?? 'Advocate', reason ?? 'Your documents could not be verified.').catch(console.error)
    }

    await writeAudit(req, {
      action: 'REJECT_LAWYER', entityType: 'lawyer', entityId: id,
      before: { verification_status: 'pending_verification' },
      after: { verification_status: 'rejected', reason: reason ?? null },
    })

    await createNotification({
      accountId: id,
      title: 'Application needs attention',
      message: reason
        ? `We could not verify your credentials: ${reason}`
        : 'We could not verify your credentials. Please review and resubmit.',
      type: 'verification',
      link: '/onboarding/lawyer',
    })

    res.json({ message: 'Lawyer application rejected' })
  } catch (err) {
    next(err)
  }
})

// ── GET /api/admin/stats ──────────────────────────────────────────────────────
router.get('/stats', requireAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const now = new Date()
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
    // Anything still pending past this point has breached the 24h review SLA.
    const slaCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

    const [
      verifiedRes, pendingRes, suspendedRes, clientsRes,
      disputesRes, payoutsRes, slaRes, consultRes, ordersRes,
    ] = await Promise.all([
      supabase.from('lawyer_profiles').select('account_id', { count: 'exact', head: true }).eq('verification_status', 'verified'),
      supabase.from('lawyer_profiles').select('account_id', { count: 'exact', head: true }).eq('verification_status', 'pending_verification'),
      supabase.from('lawyer_profiles').select('account_id', { count: 'exact', head: true }).eq('verification_status', 'suspended'),
      supabase.from('accounts').select('id', { count: 'exact', head: true }).eq('role', 'client'),
      supabase.from('disputes').select('id', { count: 'exact', head: true }).in('status', ['open', 'investigating', 'escalated']),
      supabase.from('payouts').select('id', { count: 'exact', head: true }).in('status', ['pending', 'processing']),
      supabase.from('lawyer_profiles').select('account_id', { count: 'exact', head: true })
        .eq('verification_status', 'pending_verification').lt('created_at', slaCutoff),
      supabase.from('consultations').select('total_amount').eq('payment_status', 'paid').gte('created_at', monthStart),
      supabase.from('service_orders').select('price').eq('status', 'completed').gte('created_at', monthStart),
    ])

    const sum = (rows: any[] | null, key: string) =>
      (rows ?? []).reduce((total, row) => total + Number(row[key] ?? 0), 0)

    const consultationRevenue = sum(consultRes.data, 'total_amount')
    const documentRevenue = sum(ordersRes.data, 'price')

    res.json({
      verifiedLawyers:  verifiedRes.count ?? 0,
      pendingApprovals: pendingRes.count ?? 0,
      suspendedLawyers: suspendedRes.count ?? 0,
      totalClients:     clientsRes.count ?? 0,
      openDisputes:     disputesRes.count ?? 0,
      pendingPayouts:   payoutsRes.count ?? 0,
      slaBreaches:      slaRes.count ?? 0,
      mtdRevenue:       consultationRevenue + documentRevenue,
      mtdConsultationRevenue: consultationRevenue,
      mtdDocumentRevenue:     documentRevenue,
    })
  } catch (err) {
    next(err)
  }
})


// ── GET /api/admin/lawyers/:id/docs ──────────────────────────────────────────
// Returns 24-hour signed URLs for all submitted documents.
// Admin uses this to view documents without direct Supabase Storage access.
router.get('/lawyers/:id/docs', requireAdmin, validateParams(lawyerIdParamSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id)
    const { data: lawyer, error } = await supabase
      .from('lawyer_profiles')
      .select('enrolment_cert_url, bar_id_front_url, bar_id_back_url, govt_id_url, profile_photo_url, govt_id_type, first_name, last_name, email')
      .eq('account_id', id)
      .single()

    if (error || !lawyer) return res.status(404).json({ error: 'Lawyer not found' })

    const docFields: Record<string, string | null> = {
      enrolment_cert: lawyer.enrolment_cert_url,
      bar_id_front:   lawyer.bar_id_front_url,
      bar_id_back:    lawyer.bar_id_back_url,
      govt_id:        lawyer.govt_id_url,
      profile_photo:  lawyer.profile_photo_url,
    }

    const signedDocs: Record<string, string | null> = {}
    for (const [key, path] of Object.entries(docFields)) {
      if (!path) { signedDocs[key] = null; continue }
      const { data } = await supabase.storage
        .from('legalx-lawyer-docs')
        .createSignedUrl(path, 86400)
      signedDocs[key] = data?.signedUrl ?? null
    }

    return res.json({
      lawyer: { name: `${lawyer.first_name} ${lawyer.last_name}`, email: lawyer.email, govtIdType: lawyer.govt_id_type },
      docs: signedDocs,
    })
  } catch (err) {
    next(err)
  }
})

// ── GET /api/admin/disputes ──────────────────────────────────────────────────
router.get('/disputes', requireAdmin, validateQuery(adminListQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, page, pageSize } = req.validatedQuery as any
    const [from, to] = pageRange(page, pageSize)

    let query = supabase
      .from('disputes')
      .select('id, consultation_id, service_order_id, client_id, lawyer_id, reason, status, resolution_note, created_at, updated_at', { count: 'exact' })

    if (status && status !== 'all') query = query.eq('status', status)

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(from, to)
    if (error) throw error

    const disputes = data ?? []

    // Resolve client and lawyer names in two batched lookups.
    const accountIds = [...new Set(disputes.flatMap(d => [d.client_id, d.lawyer_id]).filter(Boolean))] as string[]
    const names = new Map<string, string>()
    if (accountIds.length) {
      const { data: people } = await supabase
        .from('accounts').select('id, first_name, last_name, email').in('id', accountIds)
      for (const p of people ?? []) {
        names.set(p.id, [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email)
      }
    }

    res.json({
      disputes: disputes.map(d => ({
        ...d,
        client_name: d.client_id ? names.get(d.client_id) ?? 'Unknown' : null,
        lawyer_name: d.lawyer_id ? names.get(d.lawyer_id) ?? 'Unknown' : null,
      })),
      total: count ?? 0,
      page,
      pageSize,
    })
  } catch (err) {
    next(err)
  }
})

// ── PATCH /api/admin/disputes/:id ────────────────────────────────────────────
router.patch('/disputes/:id', requireAdmin, validateParams(uuidParamSchema), validateBody(adminDisputeUpdateSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id)
    const { status, resolutionNote } = req.body

    const { data: prev } = await supabase
      .from('disputes').select('status, resolution_note').eq('id', id).maybeSingle()
    if (!prev) return res.status(404).json({ error: 'Dispute not found' })

    const update: Record<string, unknown> = {
      status,
      resolution_note: resolutionNote ?? prev.resolution_note,
      updated_at: new Date().toISOString(),
    }
    // Stamp who closed it, only on the transition into resolved.
    if (status === 'resolved') update.resolved_by = (req as any).user.id

    const { error } = await supabase.from('disputes').update(update).eq('id', id)
    if (error) throw error

    await writeAudit(req, {
      action: 'UPDATE_DISPUTE', entityType: 'dispute', entityId: id,
      before: { status: prev.status },
      after: { status, resolution_note: resolutionNote ?? null },
    })

    return res.json({ message: 'Dispute updated' })
  } catch (err) {
    next(err)
  }
})

// ── Payout maths ──────────────────────────────────────────────────────────────
// Section 194J TDS on professional fees: 10% when the payee's PAN is on file,
// 20% when it is not. Platform commission is taken off the gross first.
const PLATFORM_FEE_RATE = 0.20
const TDS_RATE_WITH_PAN = 0.10
const TDS_RATE_NO_PAN   = 0.20

// ── GET /api/admin/payouts ───────────────────────────────────────────────────
router.get('/payouts', requireAdmin, validateQuery(adminListQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, page, pageSize } = req.validatedQuery as any
    const [from, to] = pageRange(page, pageSize)

    let query = supabase
      .from('payouts')
      .select('id, lawyer_id, period_start, period_end, gross_amount, tds_amount, platform_fee, net_amount, status, hold_reason, transaction_count, bank_ref, paid_at, created_at', { count: 'exact' })

    if (status && status !== 'all') query = query.eq('status', status)

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(from, to)
    if (error) throw error

    const payouts = data ?? []
    const lawyerIds = [...new Set(payouts.map(p => p.lawyer_id))]

    const meta = new Map<string, { name: string; hasPan: boolean }>()
    if (lawyerIds.length) {
      const { data: lawyers } = await supabase
        .from('lawyer_profiles')
        .select('account_id, first_name, last_name, email, pan_number')
        .in('account_id', lawyerIds)
      for (const l of lawyers ?? []) {
        meta.set(l.account_id, {
          name: [l.first_name, l.last_name].filter(Boolean).join(' ') || l.email || 'Unknown',
          hasPan: !!l.pan_number,
        })
      }
    }

    // Cumulative gross per lawyer this financial year — drives the ₹30,000
    // Section 194J threshold warning shown in the UI.
    const fyStart = (() => {
      const now = new Date()
      const year = now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1
      return `${year}-04-01`
    })()
    const cumulative = new Map<string, number>()
    if (lawyerIds.length) {
      const { data: ytd } = await supabase
        .from('payouts').select('lawyer_id, gross_amount')
        .in('lawyer_id', lawyerIds).gte('period_start', fyStart)
      for (const row of ytd ?? []) {
        cumulative.set(row.lawyer_id, (cumulative.get(row.lawyer_id) ?? 0) + Number(row.gross_amount ?? 0))
      }
    }

    res.json({
      payouts: payouts.map(p => ({
        ...p,
        lawyer_name: meta.get(p.lawyer_id)?.name ?? 'Unknown',
        has_pan: meta.get(p.lawyer_id)?.hasPan ?? false,
        fy_cumulative_gross: cumulative.get(p.lawyer_id) ?? 0,
      })),
      total: count ?? 0,
      page,
      pageSize,
      fyStart,
    })
  } catch (err) {
    next(err)
  }
})

// ── POST /api/admin/payouts/generate ─────────────────────────────────────────
// Builds one payout row per lawyer with paid consultations in the window.
// Re-runnable: the unique index on (lawyer_id, period_start, period_end) means
// a second run updates the existing row instead of duplicating it.
router.post('/payouts/generate', requireAdmin, validateBody(adminPayoutGenerateSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { periodStart, periodEnd } = req.body
    if (periodEnd < periodStart) {
      return res.status(400).json({ error: 'Period end must be on or after period start.' })
    }

    // periodEnd is a date; extend to end-of-day so that day's work is included.
    const { data: consults, error } = await supabase
      .from('consultations')
      .select('lawyer_id, total_amount')
      .eq('payment_status', 'paid')
      .gte('created_at', `${periodStart}T00:00:00Z`)
      .lte('created_at', `${periodEnd}T23:59:59Z`)
    if (error) throw error

    const totals = new Map<string, { gross: number; count: number }>()
    for (const c of consults ?? []) {
      if (!c.lawyer_id) continue
      const entry = totals.get(c.lawyer_id) ?? { gross: 0, count: 0 }
      entry.gross += Number(c.total_amount ?? 0)
      entry.count += 1
      totals.set(c.lawyer_id, entry)
    }

    if (totals.size === 0) {
      return res.json({ created: 0, payouts: [], message: 'No paid consultations in that period.' })
    }

    const lawyerIds = [...totals.keys()]
    const { data: lawyers } = await supabase
      .from('lawyer_profiles').select('account_id, pan_number').in('account_id', lawyerIds)
    const panMap = new Map((lawyers ?? []).map(l => [l.account_id, !!l.pan_number]))

    const rows = lawyerIds.map(lawyerId => {
      const { gross, count } = totals.get(lawyerId)!
      const platformFee = +(gross * PLATFORM_FEE_RATE).toFixed(2)
      const taxable = gross - platformFee
      const tds = +(taxable * (panMap.get(lawyerId) ? TDS_RATE_WITH_PAN : TDS_RATE_NO_PAN)).toFixed(2)
      return {
        lawyer_id: lawyerId,
        period_start: periodStart,
        period_end: periodEnd,
        gross_amount: +gross.toFixed(2),
        platform_fee: platformFee,
        tds_amount: tds,
        net_amount: +(taxable - tds).toFixed(2),
        transaction_count: count,
        status: 'pending',
        updated_at: new Date().toISOString(),
      }
    })

    const { data: inserted, error: upsertErr } = await supabase
      .from('payouts')
      .upsert(rows, { onConflict: 'lawyer_id,period_start,period_end' })
      .select('id, lawyer_id, net_amount')
    if (upsertErr) throw upsertErr

    await writeAudit(req, {
      action: 'GENERATE_PAYOUTS', entityType: 'payout', entityId: null,
      after: { periodStart, periodEnd, count: rows.length },
    })

    return res.json({ created: inserted?.length ?? 0, payouts: inserted ?? [] })
  } catch (err) {
    next(err)
  }
})

// ── PATCH /api/admin/payouts/:id/hold ────────────────────────────────────────
router.patch('/payouts/:id/hold', requireAdmin, validateParams(uuidParamSchema), validateBody(adminPayoutHoldSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id)
    const { reason } = req.body

    const { data: prev } = await supabase.from('payouts').select('status').eq('id', id).maybeSingle()
    if (!prev) return res.status(404).json({ error: 'Payout not found' })
    if (prev.status === 'paid') {
      return res.status(400).json({ error: 'This payout has already been paid and cannot be held.' })
    }

    const { error } = await supabase
      .from('payouts')
      .update({ status: 'held', hold_reason: reason, updated_at: new Date().toISOString() })
      .eq('id', id)
    if (error) throw error

    await writeAudit(req, {
      action: 'HOLD_PAYOUT', entityType: 'payout', entityId: id,
      before: { status: prev.status }, after: { status: 'held', reason },
    })

    return res.json({ message: 'Payout held' })
  } catch (err) {
    next(err)
  }
})

// ── PATCH /api/admin/payouts/:id/status ──────────────────────────────────────
router.patch('/payouts/:id/status', requireAdmin, validateParams(uuidParamSchema), validateBody(adminPayoutStatusSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id)
    const { status, bankRef } = req.body

    const { data: prev } = await supabase.from('payouts').select('status').eq('id', id).maybeSingle()
    if (!prev) return res.status(404).json({ error: 'Payout not found' })

    const update: Record<string, unknown> = {
      status,
      hold_reason: null,
      bank_ref: bankRef ?? null,
      updated_at: new Date().toISOString(),
    }
    if (status === 'paid') update.paid_at = new Date().toISOString()

    const { error } = await supabase.from('payouts').update(update).eq('id', id)
    if (error) throw error

    await writeAudit(req, {
      action: 'UPDATE_PAYOUT_STATUS', entityType: 'payout', entityId: id,
      before: { status: prev.status }, after: { status, bankRef: bankRef ?? null },
    })

    return res.json({ message: 'Payout updated' })
  } catch (err) {
    next(err)
  }
})

// ── GET /api/admin/documents ─────────────────────────────────────────────────
// Service orders still in flight, with the data the UI needs for SLA colouring.
router.get('/documents', requireAdmin, validateQuery(adminListQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, page, pageSize } = req.validatedQuery as any
    const [from, to] = pageRange(page, pageSize)

    let query = supabase
      .from('service_orders')
      .select('id, order_number, account_id, service_id, assigned_lawyer_id, status, price, customer_notes, internal_notes, created_at, updated_at, completed_at', { count: 'exact' })

    if (status && status !== 'all') {
      query = query.eq('status', status)
    } else {
      // Default view is work in progress — completed and cancelled orders are
      // noise on an operations screen.
      query = query.in('status', ['pending_payment', 'in_progress', 'pending_customer_input', 'in_review', 'revision_requested'])
    }

    const { data, error, count } = await query
      .order('created_at', { ascending: true })
      .range(from, to)
    if (error) throw error

    const orders = data ?? []
    const accountIds = [...new Set(orders.map(o => o.account_id).filter(Boolean))] as string[]
    const lawyerIds = [...new Set(orders.map(o => o.assigned_lawyer_id).filter(Boolean))] as string[]
    const serviceIds = [...new Set(orders.map(o => o.service_id).filter(Boolean))] as string[]

    const [peopleRes, servicesRes] = await Promise.all([
      accountIds.length || lawyerIds.length
        ? supabase.from('accounts').select('id, first_name, last_name, email').in('id', [...accountIds, ...lawyerIds])
        : Promise.resolve({ data: [] as any[] }),
      serviceIds.length
        ? supabase.from('service_catalog').select('id, title, slug').in('id', serviceIds)
        : Promise.resolve({ data: [] as any[] }),
    ])

    const names = new Map<string, string>()
    for (const p of peopleRes.data ?? []) {
      names.set(p.id, [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email)
    }
    const services = new Map((servicesRes.data ?? []).map((s: any) => [s.id, s.title ?? s.slug]))

    res.json({
      orders: orders.map(o => ({
        ...o,
        client_name: o.account_id ? names.get(o.account_id) ?? 'Unknown' : 'Guest',
        lawyer_name: o.assigned_lawyer_id ? names.get(o.assigned_lawyer_id) ?? 'Unknown' : null,
        service_title: o.service_id ? services.get(o.service_id) ?? 'Service' : 'Service',
      })),
      total: count ?? 0,
      page,
      pageSize,
    })
  } catch (err) {
    next(err)
  }
})

// ── GET /api/admin/analytics ─────────────────────────────────────────────────
router.get('/analytics', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Default window is the last 6 months, inclusive of the current one.
    const now = new Date()
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1)).toISOString()

    const [consultRes, ordersRes, signupsRes, lawyersRes, disputesRes] = await Promise.all([
      supabase.from('consultations').select('type, status, total_amount, payment_status, created_at').gte('created_at', start),
      supabase.from('service_orders').select('status, price, created_at').gte('created_at', start),
      supabase.from('accounts').select('role, created_at').gte('created_at', start),
      supabase.from('lawyer_profiles').select('account_id, first_name, last_name, email, avg_rating, total_reviews, verification_status'),
      supabase.from('disputes').select('id, status, created_at').gte('created_at', start),
    ])

    const monthKey = (iso: string) => iso.slice(0, 7) // YYYY-MM

    // Seed every month in range so gaps render as zero instead of disappearing.
    const months: string[] = []
    for (let i = 5; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
      months.push(d.toISOString().slice(0, 7))
    }
    const blank = () => Object.fromEntries(months.map(m => [m, 0])) as Record<string, number>

    const revenueByMonth = blank()
    const consultRevenue = blank()
    const docRevenue = blank()
    const clientSignups = blank()
    const lawyerSignups = blank()

    for (const c of consultRes.data ?? []) {
      if (c.payment_status !== 'paid') continue
      const m = monthKey(c.created_at)
      if (!(m in revenueByMonth)) continue
      const amt = Number(c.total_amount ?? 0)
      revenueByMonth[m] += amt
      consultRevenue[m] += amt
    }
    for (const o of ordersRes.data ?? []) {
      if (o.status !== 'completed') continue
      const m = monthKey(o.created_at)
      if (!(m in revenueByMonth)) continue
      const amt = Number(o.price ?? 0)
      revenueByMonth[m] += amt
      docRevenue[m] += amt
    }
    for (const a of signupsRes.data ?? []) {
      const m = monthKey(a.created_at)
      if (!(m in clientSignups)) continue
      if (a.role === 'client') clientSignups[m] += 1
      else if (a.role === 'lawyer') lawyerSignups[m] += 1
    }

    const consultByType: Record<string, number> = { chat: 0, voice: 0, video: 0 }
    for (const c of consultRes.data ?? []) {
      if (c.type && c.type in consultByType) consultByType[c.type] += 1
    }

    const leaderboard = (lawyersRes.data ?? [])
      .filter(l => (l.total_reviews ?? 0) > 0)
      .sort((a, b) => Number(b.avg_rating ?? 0) - Number(a.avg_rating ?? 0))
      .slice(0, 10)
      .map(l => ({
        lawyer_id: l.account_id,
        name: [l.first_name, l.last_name].filter(Boolean).join(' ') || l.email || 'Unknown',
        avg_rating: Number(l.avg_rating ?? 0),
        total_reviews: l.total_reviews ?? 0,
      }))

    const totalConsults = (consultRes.data ?? []).length
    const totalDisputes = (disputesRes.data ?? []).length

    res.json({
      months,
      revenueByMonth,
      consultRevenue,
      docRevenue,
      clientSignups,
      lawyerSignups,
      consultByType,
      leaderboard,
      totals: {
        consultations: totalConsults,
        disputes: totalDisputes,
        disputeRate: totalConsults ? +((totalDisputes / totalConsults) * 100).toFixed(1) : 0,
        totalRevenue: Object.values(revenueByMonth).reduce((a, b) => a + b, 0),
      },
    })
  } catch (err) {
    next(err)
  }
})

// ── Articles (content) ───────────────────────────────────────────────────────
router.get('/articles', requireAdmin, validateQuery(adminListQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, search, page, pageSize } = req.validatedQuery as any
    const [from, to] = pageRange(page, pageSize)

    let query = supabase
      .from('articles')
      .select('id, title, slug, content, status, published_at, created_at, updated_at', { count: 'exact' })

    if (status && status !== 'all') query = query.eq('status', status)
    if (search) {
      const term = escapeLike(search)
      if (term) query = query.or(`title.ilike.%${term}%,slug.ilike.%${term}%`)
    }

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(from, to)
    if (error) throw error

    res.json({ articles: data ?? [], total: count ?? 0, page, pageSize })
  } catch (err) {
    next(err)
  }
})

router.post('/articles', requireAdmin, validateBody(adminArticleSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { title, slug, content, status } = req.body
    const { data, error } = await supabase
      .from('articles')
      .insert({
        title, slug, content, status,
        published_at: status === 'published' ? new Date().toISOString() : null,
      })
      .select('id, title, slug, status')
      .single()

    if (error) {
      // 23505 = unique_violation, almost always the slug.
      if ((error as any).code === '23505') {
        return res.status(409).json({ error: 'An article with that slug already exists.' })
      }
      throw error
    }

    await writeAudit(req, {
      action: 'CREATE_ARTICLE', entityType: 'article', entityId: data.id,
      after: { title, slug, status },
    })

    return res.status(201).json({ article: data })
  } catch (err) {
    next(err)
  }
})

router.patch('/articles/:id', requireAdmin, validateParams(uuidParamSchema), validateBody(adminArticleUpdateSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id)
    const { data: prev } = await supabase
      .from('articles').select('title, slug, status').eq('id', id).maybeSingle()
    if (!prev) return res.status(404).json({ error: 'Article not found' })

    const update: Record<string, unknown> = { ...req.body, updated_at: new Date().toISOString() }
    // Stamp publish time on the draft -> published transition only.
    if (req.body.status === 'published' && prev.status !== 'published') {
      update.published_at = new Date().toISOString()
    }

    const { error } = await supabase.from('articles').update(update).eq('id', id)
    if (error) {
      if ((error as any).code === '23505') {
        return res.status(409).json({ error: 'An article with that slug already exists.' })
      }
      throw error
    }

    await writeAudit(req, {
      action: 'UPDATE_ARTICLE', entityType: 'article', entityId: id,
      before: prev, after: req.body,
    })

    return res.json({ message: 'Article updated' })
  } catch (err) {
    next(err)
  }
})

// ── Legal shorts ──────────────────────────────────────────────────────────────

// ── POST /api/admin/shorts/ingest ────────────────────────────────────────────
// Operator-supplied source: a URL to fetch, or text pasted directly for pages
// the fetcher cannot read (PDFs, captcha-gated court portals). Produces one
// pending suggestion — never publishes.
router.post('/shorts/ingest', requireAdmin, validateBody(shortsIngestSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sourceUrl, rawText, sourceName } = req.body
    const result = await draftFromSource({ sourceUrl, rawText, sourceName })

    if ('skipped' in result) {
      // A refusal is a successful outcome of the grounding contract, not an
      // error — say why so the operator can judge whether to paste more text.
      return res.status(422).json({ error: `Not summarised: ${result.reason}` })
    }

    await writeAudit(req, {
      action: 'INGEST_SHORT', entityType: 'short', entityId: result.id,
      after: { sourceUrl, title: result.title },
    })

    return res.status(201).json({ short: result })
  } catch (err: any) {
    if (/not configured|rate limit|Already ingested|Could not fetch|is a PDF/i.test(err?.message ?? '')) {
      return res.status(422).json({ error: err.message })
    }
    next(err)
  }
})

// ── POST /api/admin/shorts/auto-ingest ───────────────────────────────────────
// Manual "run now". Proposes a batch of suggestions for review; the scheduled
// job hits the same pipeline via /api/jobs/shorts-daily.
router.post('/shorts/auto-ingest', requireAdmin, validateBody(shortsAutoIngestSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const report = await runIngest({ target: req.body.limit, feeds: req.body.feeds })

    await writeAudit(req, {
      action: 'INGEST_SHORTS', entityType: 'short', entityId: null,
      after: { proposed: report.proposed, skipped: report.skipped.length, failed: report.failed.length },
    })

    return res.json(report)
  } catch (err: any) {
    if (/not configured|rate limit|No feed sources/i.test(err?.message ?? '')) {
      return res.status(422).json({ error: err.message })
    }
    next(err)
  }
})

// ── GET /api/admin/shorts/feeds ──────────────────────────────────────────────
router.get('/shorts/feeds', requireAdmin, (_req: Request, res: Response) => {
  res.json({
    feeds: FEED_SOURCES.map(f => ({
      id: f.id, label: f.label, enabled: f.enabled,
      sourceName: f.sourceName, licenceNote: f.licenceNote,
    })),
  })
})

// ── POST /api/admin/shorts/bulk ──────────────────────────────────────────────
// The core curation action: approve the 3-4 worth publishing, reject the rest.
// Rejected cards are kept so the same article is not re-suggested tomorrow.
router.post('/shorts/bulk', requireAdmin, validateBody(shortsBulkSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ids, action, reason } = req.body
    const now = new Date().toISOString()

    const update = action === 'approve'
      ? { review_status: 'approved', is_published: true, published_at: now, reviewed_by: (req as any).user.id, updated_at: now }
      : { review_status: 'rejected', is_published: false, rejected_reason: reason ?? null, reviewed_by: (req as any).user.id, updated_at: now }

    const { data, error } = await supabase
      .from('shorts_cards')
      .update(update)
      .in('id', ids)
      .eq('review_status', 'pending')   // never re-decide something already actioned
      .select('id')
    if (error) throw error

    const changed = (data ?? []).map(r => r.id)

    await writeAudit(req, {
      action: action === 'approve' ? 'PUBLISH_SHORTS' : 'REJECT_SHORTS',
      entityType: 'short', entityId: null,
      before: { requested: ids },
      after: { changed, reason: reason ?? null },
    })

    return res.json({
      changed: changed.length,
      skipped: ids.length - changed.length,
    })
  } catch (err) {
    next(err)
  }
})

// ── GET /api/admin/shorts ────────────────────────────────────────────────────
// The curation queue. `status=pending` (default) is the work list, ordered by
// relevance so the strongest suggestions are read first.
router.get('/shorts', requireAdmin, validateQuery(adminListQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status = 'pending', search, page, pageSize } = req.validatedQuery as any
    const [from, to] = pageRange(page, pageSize)

    let query = supabase
      .from('shorts_cards')
      .select(
        'id, title, slug, summary, takeaway, category, court, judgment_date, source_url, source_name, ' +
        'source_feed, tags, evidence, relevance_score, confidence, is_published, review_status, ' +
        'rejected_reason, published_at, likes_count, created_at',
        { count: 'exact' }
      )

    if (['pending', 'approved', 'rejected'].includes(status)) {
      query = query.eq('review_status', status)
    }

    if (search) {
      const term = escapeLike(search)
      if (term) query = query.or(`title.ilike.%${term}%,category.ilike.%${term}%`)
    }

    // Pending: best candidates first. Everything else: newest first.
    query = status === 'pending'
      ? query.order('relevance_score', { ascending: false }).order('created_at', { ascending: false })
      : query.order('created_at', { ascending: false })

    const { data, error, count } = await query.range(from, to)
    if (error) throw error

    // Counts for the tab badges, so the editor sees the backlog at a glance.
    const [pendingRes, approvedRes, rejectedRes] = await Promise.all([
      supabase.from('shorts_cards').select('id', { count: 'exact', head: true }).eq('review_status', 'pending'),
      supabase.from('shorts_cards').select('id', { count: 'exact', head: true }).eq('review_status', 'approved'),
      supabase.from('shorts_cards').select('id', { count: 'exact', head: true }).eq('review_status', 'rejected'),
    ])

    res.json({
      shorts: data ?? [],
      total: count ?? 0,
      page,
      pageSize,
      counts: {
        pending: pendingRes.count ?? 0,
        approved: approvedRes.count ?? 0,
        rejected: rejectedRes.count ?? 0,
      },
    })
  } catch (err) {
    next(err)
  }
})

// ── PATCH /api/admin/shorts/:id ──────────────────────────────────────────────
// Edit and/or publish. Editing before publishing is expected — the summary is a
// draft written by a model, not finished copy.
router.patch('/shorts/:id', requireAdmin, validateParams(uuidParamSchema), validateBody(shortsUpdateSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id)
    const { data: prev } = await supabase
      .from('shorts_cards').select('title, is_published').eq('id', id).maybeSingle()
    if (!prev) return res.status(404).json({ error: 'Short not found' })

    const body = req.body
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (body.title !== undefined) update.title = body.title
    if (body.summary !== undefined) update.summary = body.summary
    if (body.takeaway !== undefined) update.takeaway = body.takeaway
    if (body.category !== undefined) update.category = body.category
    if (body.court !== undefined) update.court = body.court
    if (body.judgmentDate !== undefined) update.judgment_date = body.judgmentDate
    if (body.tags !== undefined) update.tags = body.tags

    if (body.isPublished !== undefined) {
      update.is_published = body.isPublished
      // Stamp the reviewer on the draft -> published transition only, so a
      // later edit doesn't overwrite who originally approved it.
      if (body.isPublished && !prev.is_published) {
        update.published_at = new Date().toISOString()
        update.reviewed_by = (req as any).user.id
      }
    }

    const { error } = await supabase.from('shorts_cards').update(update).eq('id', id)
    if (error) throw error

    await writeAudit(req, {
      action: body.isPublished === true && !prev.is_published ? 'PUBLISH_SHORT' : 'UPDATE_SHORT',
      entityType: 'short', entityId: id,
      before: { title: prev.title, is_published: prev.is_published },
      after: update,
    })

    return res.json({ message: body.isPublished ? 'Short published' : 'Short updated' })
  } catch (err) {
    next(err)
  }
})

// ── DELETE /api/admin/shorts/:id ─────────────────────────────────────────────
router.delete('/shorts/:id', requireAdmin, validateParams(uuidParamSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id)
    const { data: prev } = await supabase
      .from('shorts_cards').select('title, source_url').eq('id', id).maybeSingle()
    if (!prev) return res.status(404).json({ error: 'Short not found' })

    const { error } = await supabase.from('shorts_cards').delete().eq('id', id)
    if (error) throw error

    await writeAudit(req, {
      action: 'DELETE_SHORT', entityType: 'short', entityId: id, before: prev,
    })

    return res.json({ message: 'Short deleted' })
  } catch (err) {
    next(err)
  }
})

export default router
