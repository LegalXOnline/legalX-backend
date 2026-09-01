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
} from '../lib/validation'
import { sendLawyerApproved, sendLawyerRejected } from '../lib/email'

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

export default router
