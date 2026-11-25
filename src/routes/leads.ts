import { Router, Response, NextFunction } from 'express'
import { supabase } from '../lib/supabase'
import { sendLeadAlert, sendUserConfirmation } from '../lib/email'
import { notifyAdmins } from '../lib/notify'
import { rateLimit } from 'express-rate-limit'
import { validateBody, validateParams, leadCreateSchema, leadUpdateBodySchema, leadIdParamSchema } from '../lib/validation'
import { optionalAuth, requireAdminSecret, type AuthedRequest } from '../lib/auth'

const router = Router()

// Tight rate limit for lead creation — 10 per hour per IP
const leadLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true })

// ── POST /api/leads ──────────────────────────────────────────────────────────
// Open to guests — the lead gate lets someone enquire before signing up.
// optionalAuth only stamps an owner when there is one, which is what makes the
// enquiry readable back to them later.
router.post('/', leadLimit, optionalAuth, validateBody(leadCreateSchema), async (req: AuthedRequest, res, next) => {
  try {
    const { name, phone, email, serviceSlug, serviceTitle } = req.body
    const caller = req.user

    const { data, error } = await supabase
      .from('leads')
      .insert({
        name: name.trim(),
        phone: phone.replace(/\s+/g, ''),
        email: email?.trim() || null,
        service_slug: serviceSlug,
        service_title: serviceTitle,
        source: 'apply-online',
        // Only a client owns an enquiry — an admin or advocate here is acting
        // for someone else.
        account_id: caller?.role === 'client' ? caller.id : null,
      })
      .select('id')
      .single()

    if (error) {
      console.error('[leads] insert error:', error)
      return res.status(500).json({ error: 'Failed to save lead' })
    }

    // Fire-and-forget emails
    sendLeadAlert({ name: name.trim(), phone, email, serviceTitle })
    if (email) sendUserConfirmation(email, name.trim(), serviceTitle)

    // In-app alert, so the panel shows the lead without waiting on a mailbox
    void notifyAdmins({
      title: 'New lead',
      message: `${name.trim()} enquired about ${serviceTitle}.`,
      type: 'info',
      link: '/admin/documents',
    }).catch(() => {})

    return res.status(201).json({ leadId: data.id })
  } catch (err) {
    next(err)
  }
})

// ── PATCH /api/leads/:id ─────────────────────────────────────────────────────
// Update lead status (contacted / converted / dropped)
router.patch('/:id', requireAdminSecret, validateParams(leadIdParamSchema), validateBody(leadUpdateBodySchema), async (req, res, next) => {
  try {
    const { status } = req.body

    const { error } = await supabase
      .from('leads')
      .update({ status })
      .eq('id', req.params.id)

    if (error) throw error
    return res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// ── GET /api/leads ───────────────────────────────────────────────────────────
// Simple admin list — protected by bearer token check
router.get('/', requireAdminSecret, async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('leads')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200)

    if (error) throw error
    return res.json(data)
  } catch (err) {
    next(err)
  }
})

export default router
