import { Router, Request, Response, NextFunction } from 'express'
import { supabase } from '../lib/supabase'
import { validateBody, validateParams, applicationCreateSchema, applicationIdParamSchema } from '../lib/validation'

const router = Router()

// ── POST /api/applications
// Save full form data once user completes all steps
router.post('/', validateBody(applicationCreateSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { leadId, serviceSlug, formData } = req.body

    // Verify leadId exists
    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select('id')
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
