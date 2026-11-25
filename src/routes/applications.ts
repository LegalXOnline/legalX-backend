import { Router, Request, Response, NextFunction } from 'express'
import { supabase } from '../lib/supabase'
import { validateBody, validateParams, applicationCreateSchema, applicationIdParamSchema } from '../lib/validation'
import { sendClientApplicationConfirmation, sendDocumentsSubmittedAlert } from '../lib/email'
import { notifyAdmins } from '../lib/notify'
import { requireAuth, optionalAuth, ownsOrAdmin, type AuthedRequest } from '../lib/auth'

const router = Router()

// ── POST /api/applications ───────────────────────────────────────────────────
// Open to guests on purpose — the funnel exists so somebody can enquire
// before signing up. When a caller is signed in the lead is claimed for them,
// which is what makes the GET below answerable.
router.post('/', optionalAuth, validateBody(applicationCreateSchema), async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { leadId, serviceSlug, formData } = req.body
    const caller = req.user

    // Verify leadId exists and fetch details for email notification in one query
    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select('id, name, phone, email, service_title, account_id')
      .eq('id', leadId)
      .single()

    if (leadError || !lead) return res.status(404).json({ error: 'Lead not found' })

    // A lead owned by someone else is not available to attach to — otherwise
    // anyone could bolt their form data onto a stranger's enquiry.
    if (lead.account_id && (!caller || !ownsOrAdmin(caller, lead.account_id))) {
      return res.status(403).json({ error: 'This enquiry belongs to another account' })
    }

    const { data, error } = await supabase
      .from('applications')
      .insert({
        lead_id: leadId,
        service_slug: serviceSlug,
        form_data: formData,
        status: 'submitted',
      })
      .select('id')
      .single()

    if (error) {
      console.error('[applications] insert error:', error)
      return res.status(500).json({ error: 'Failed to save application' })
    }

    // Claim it if they signed in partway through, which is the common path:
    // payment needs an account, the lead gate does not.
    const leadUpdate: Record<string, unknown> = { status: 'contacted' }
    if (caller && caller.role === 'client' && !lead.account_id) {
      leadUpdate.account_id = caller.id
    }
    await supabase.from('leads').update(leadUpdate).eq('id', leadId)

    // Everything below is a side-effect of an application that has already
    // committed. A failed email must not turn a successful submission into an
    // error, so these are settled and swallowed rather than awaited for status.
    void Promise.allSettled([
      // Admin: documents are in, payment is not yet done
      sendDocumentsSubmittedAlert({
        name: lead.name,
        phone: lead.phone,
        email: lead.email,
        serviceTitle: lead.service_title,
        applicationId: data.id,
      }),
      // Client: their own receipt, with the reference to quote back at us
      sendClientApplicationConfirmation({
        to: lead.email ?? '',
        name: lead.name,
        serviceTitle: lead.service_title,
        applicationId: data.id,
      }),
      notifyAdmins({
        title: 'New application submitted',
        message: `${lead.name} submitted ${lead.service_title}.`,
        type: 'document',
        link: '/admin/documents',
      }),
    ]).catch(() => {})

    return res.status(201).json({ applicationId: data.id })
  } catch (err) {
    next(err)
  }
})

// ── GET /api/applications/:id ────────────────────────────────────────────────
// The client's own application, or any for an admin. This had no auth at all
// until now: CSRF-only, and CSRF skips GET, so the whole form_data payload —
// PAN, Aadhaar, bank details — was readable by anyone with the UUID.
router.get('/:id', requireAuth, validateParams(applicationIdParamSchema), async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const caller = req.user!

    const { data, error } = await supabase
      .from('applications')
      .select('*, leads(name, phone, email, service_title, account_id)')
      .eq('id', req.params.id)
      .single()

    if (error || !data) return res.status(404).json({ error: 'Not found' })

    // Supabase types a one-to-one embed as object or array depending on how it
    // infers the relationship, so normalise first.
    const leadRow = Array.isArray(data.leads) ? data.leads[0] : data.leads
    const ownerId: string | null = leadRow?.account_id ?? null

    // 404, not 403 — a 403 confirms the id is real, which is what enumeration
    // is looking for.
    if (!ownsOrAdmin(caller, ownerId)) {
      return res.status(404).json({ error: 'Not found' })
    }

    // Internal join key, not for the response.
    if (leadRow && 'account_id' in leadRow) {
      const { account_id: _omit, ...lead } = leadRow as Record<string, unknown>
      return res.json({ ...data, leads: lead })
    }

    return res.json(data)
  } catch (err) {
    next(err)
  }
})

export default router
