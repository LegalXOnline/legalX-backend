import { Router, Request, Response, NextFunction } from 'express'
import { supabase } from '../lib/supabase'
import { validateBody, validateParams, applicationCreateSchema, applicationIdParamSchema } from '../lib/validation'
import { sendClientApplicationConfirmation, sendDocumentsSubmittedAlert } from '../lib/email'
import { notifyAdmins } from '../lib/notify'

const router = Router()

// ── POST /api/applications
// Save full form data once user completes all steps
router.post('/', validateBody(applicationCreateSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { leadId, serviceSlug, formData } = req.body

    // Verify leadId exists and fetch details for email notification in one query
    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select('id, name, phone, email, service_title')
      .eq('id', leadId)
      .single()

    if (leadError || !lead) return res.status(404).json({ error: 'Lead not found' })

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

    // Mark lead as progressed
    await supabase.from('leads').update({ status: 'contacted' }).eq('id', leadId)

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
router.get('/:id', validateParams(applicationIdParamSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data, error } = await supabase
      .from('applications')
      .select('*, leads(name, phone, email, service_title)')
      .eq('id', req.params.id)
      .single()

    if (error || !data) return res.status(404).json({ error: 'Not found' })
    return res.json(data)
  } catch (err) {
    next(err)
  }
})

export default router
