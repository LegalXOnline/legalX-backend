import { Router, Request, Response, NextFunction } from 'express'
import { supabase } from '../lib/supabase'
import { sendLeadAlert, sendUserConfirmation } from '../lib/email'
import { rateLimit } from 'express-rate-limit'
import crypto from 'crypto'
import { validateBody, validateParams, leadCreateSchema, leadUpdateBodySchema, leadIdParamSchema } from '../lib/validation'

const router = Router()

// Tight rate limit for lead creation — 10 per hour per IP
const leadLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true })

const ADMIN_SECRET = process.env.ADMIN_SECRET
if (!ADMIN_SECRET) {
  throw new Error('ADMIN_SECRET must be set in environment')
}

async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader) {
      return res.status(401).json({ error: 'Not authenticated' })
    }
    const token = authHeader.replace('Bearer ', '')
    if (!token) {
      return res.status(401).json({ error: 'Not authenticated' })
    }

    // Timing-safe comparison
    const tokenBuf = Buffer.from(token)
    const secretBuf = Buffer.from(ADMIN_SECRET!)
    if (tokenBuf.length !== secretBuf.length || !crypto.timingSafeEqual(tokenBuf, secretBuf)) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    next()
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }
}

// ── POST /api/leads ──────────────────────────────────────────────────────────
// Called the moment user submits Step 0 (Lead Gate) on Apply Online page
router.post('/', leadLimit, validateBody(leadCreateSchema), async (req, res, next) => {
  try {
    const { name, phone, email, serviceSlug, serviceTitle } = req.body

    const { data, error } = await supabase
      .from('leads')
      .insert({
        name: name.trim(),
        phone: phone.replace(/\s+/g, ''),
        email: email?.trim() || null,
        service_slug: serviceSlug,
        service_title: serviceTitle,
        source: 'apply-online',
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

    return res.status(201).json({ leadId: data.id })
  } catch (err) {
    next(err)
  }
})

// ── PATCH /api/leads/:id ─────────────────────────────────────────────────────
// Update lead status (contacted / converted / dropped)
router.patch('/:id', requireAdmin, validateParams(leadIdParamSchema), validateBody(leadUpdateBodySchema), async (req, res, next) => {
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
router.get('/', requireAdmin, async (req, res, next) => {
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
