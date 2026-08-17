import { Router, Request, Response, NextFunction } from 'express'
import { supabase } from '../lib/supabase'
import { validateBody, validateParams, lawyerIdParamSchema, adminLawyerRejectBodySchema } from '../lib/validation'

const router = Router()

// ── Auth middleware — validates the HttpOnly cookie set by /api/auth/login ────
async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.lx_access_token || req.headers.authorization?.replace('Bearer ', '')
    if (!token) {
      return res.status(401).json({ error: 'Not authenticated' })
    }

    const { data, error } = await supabase.auth.getUser(token)
    if (error || !data.user) {
      return res.status(401).json({ error: 'Invalid or expired session' })
    }

    const role = data.user.user_metadata?.role
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
    const { error } = await supabase
      .from('lawyer_profiles')
      .update({ verification_status: 'verified', verified_at: new Date().toISOString() })
      .eq('account_id', id)

    if (error) throw error
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
    const { error } = await supabase
      .from('lawyer_profiles')
      .update({ verification_status: 'rejected', rejection_reason: reason ?? null })
      .eq('account_id', id)

    if (error) throw error
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

export default router
