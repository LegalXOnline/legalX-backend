import { Router, Request, Response, NextFunction } from 'express'
import { supabase } from '../lib/supabase'
import { validateBody, validateParams, applicationCreateSchema, applicationIdParamSchema } from '../lib/validation'
import { sendClientApplicationConfirmation, sendDocumentsSubmittedAlert } from '../lib/email'
import { notifyAdmins } from '../lib/notify'
import { requireAuth, optionalAuth, ownsOrAdmin, type AuthedRequest } from '../lib/auth'
import { servicePriceInRupees } from '../lib/pricing'

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

// ── GET /api/applications/lawyer?serviceType=&status= ────────────────────────
/**
 * The document queue for the advocate portal. It has called this since it was
 * built and got a 400 every time — `/:id` matched first and rejected "lawyer"
 * as a malformed UUID.
 *
 * Applications are not assigned to an advocate, so this is the shared queue a
 * verified advocate works from rather than a personal list.
 *
 * MUST stay above GET /:id.
 */
router.get('/lawyer', requireAuth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const caller = req.user!
    if (caller.role !== 'lawyer' && caller.role !== 'admin') {
      return res.status(403).json({ error: 'Not a lawyer account' })
    }

    const status = typeof req.query.status === 'string' ? req.query.status : undefined
    const serviceType = typeof req.query.serviceType === 'string' ? req.query.serviceType : undefined

    let query = supabase
      .from('applications')
      .select('id, service_slug, status, created_at, leads(name)')
      .order('created_at', { ascending: false })
      .limit(100)

    if (status && status !== 'all') query = query.eq('status', status)
    if (serviceType && serviceType !== 'all') query = query.eq('service_slug', serviceType)

    const { data, error } = await query
    if (error) throw error

    // form_data is deliberately absent: it holds PAN and Aadhaar, and a queue
    // listing needs a name and a status, not identity documents.
    return res.json((data ?? []).map(row => {
      const lead = Array.isArray(row.leads) ? row.leads[0] : row.leads
      return {
        id: row.id,
        documentType: row.service_slug,
        status: row.status,
        clientName: lead?.name ?? 'Client',
        revisionCount: 0,
        pageCount: null,
        verificationTier: null,
        fee: servicePriceInRupees(row.service_slug) ?? 0,
        createdAt: row.created_at,
        deliverableUrl: null,
      }
    }))
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
