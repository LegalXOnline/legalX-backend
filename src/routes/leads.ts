import { Router } from 'express'
import { supabase } from '../lib/supabase'
import { sendLeadAlert, sendUserConfirmation } from '../lib/email'
import { rateLimit } from 'express-rate-limit'

const router = Router()

// Tight rate limit for lead creation — 10 per hour per IP
const leadLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true })

// ── POST /api/leads ──────────────────────────────────────────────────────────
// Called the moment user submits Step 0 (Lead Gate) on Apply Online page
router.post('/', leadLimit, async (req, res) => {
  const { name, phone, email, serviceSlug, serviceTitle } = req.body

  // Validate
  if (!name?.trim() || !phone?.trim() || !serviceSlug || !serviceTitle) {
    return res.status(400).json({ error: 'name, phone, serviceSlug and serviceTitle are required' })
  }
  if (!/^[6-9]\d{9}$/.test(phone.replace(/\s+/g, ''))) {
    return res.status(400).json({ error: 'Enter a valid 10-digit Indian phone number' })
  }

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
})

// ── PATCH /api/leads/:id ─────────────────────────────────────────────────────
// Update lead status (contacted / converted / dropped)
router.patch('/:id', async (req, res) => {
  const { status } = req.body
  const allowed = ['new', 'contacted', 'converted', 'dropped']
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` })
  }

  const { error } = await supabase
    .from('leads')
    .update({ status })
    .eq('id', req.params.id)

  if (error) return res.status(500).json({ error: 'Update failed' })
  return res.json({ ok: true })
})

// ── GET /api/leads ───────────────────────────────────────────────────────────
// Simple admin list — protected by bearer token check
router.get('/', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (token !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) return res.status(500).json({ error: error.message })
  return res.json(data)
})

export default router
