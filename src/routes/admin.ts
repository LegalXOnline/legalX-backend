import { Router, Request, Response, NextFunction } from 'express'
import { supabase, supabaseAuthValidator } from '../lib/supabase'
import { validateBody, validateParams, lawyerIdParamSchema, adminLawyerRejectBodySchema } from '../lib/validation'
import { sendLawyerApproved, sendLawyerRejected } from '../lib/email'

const router = Router()

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

// ── GET /api/admin/lawyers?status=pending_verification ───────────────────────
router.get('/lawyers', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = (req.query.status as string) || 'pending_verification'
    const { data, error } = await supabase
      .from('lawyer_profiles')
      .select('account_id, first_name, last_name, email, bar_council_number, verification_status, created_at')
      .eq('verification_status', status)
      .order('created_at', { ascending: false })

    if (error) throw error
    res.json({ lawyers: data ?? [] })
  } catch (err) {
    next(err)
  }
})

// ── PATCH /api/admin/lawyers/:id/approve ─────────────────────────────────────
router.patch('/lawyers/:id/approve', requireAdmin, validateParams(lawyerIdParamSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params
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

    res.json({ message: 'Lawyer approved successfully' })
  } catch (err) {
    next(err)
  }
})

// ── PATCH /api/admin/lawyers/:id/reject ──────────────────────────────────────
router.patch('/lawyers/:id/reject', requireAdmin, validateParams(lawyerIdParamSchema), validateBody(adminLawyerRejectBodySchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params
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

    res.json({ message: 'Lawyer application rejected' })
  } catch (err) {
    next(err)
  }
})

// ── GET /api/admin/stats ──────────────────────────────────────────────────────
router.get('/stats', requireAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [lawyersRes, pendingRes] = await Promise.all([
      supabase.from('lawyer_profiles').select('account_id', { count: 'exact' }).eq('verification_status', 'verified'),
      supabase.from('lawyer_profiles').select('account_id', { count: 'exact' }).eq('verification_status', 'pending_verification'),
    ])

    res.json({
      verifiedLawyers: lawyersRes.count ?? 0,
      pendingApprovals: pendingRes.count ?? 0,
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
    const { id } = req.params
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
