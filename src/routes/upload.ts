import { Router, Request, Response } from 'express'
import multer from 'multer'
import { createClient } from '@supabase/supabase-js'
// The shared service-role client, for the one DB read this route needs. The
// two clients below stay separate for the reason described under them.
import { supabase } from '../lib/supabase'
import { notifyAdmins } from '../lib/notify'
import { sendDocumentUploadedAlert } from '../lib/email'

const router = Router()

// ── Two separate Supabase clients ─────────────────────────────────────────────
// authClient: validates user JWTs — may have session state set per-request
// storageClient: always uses service_role key for storage ops — never user-scoped
const SUPABASE_URL         = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

// Fresh client per module load — service role, never contaminated by user JWTs
const storageClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// Auth client (also service role for getUser() — getUser validates the JWT server-side)
const authClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// ── Multer: memory storage ────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'application/pdf']
    if (allowed.includes(file.mimetype)) return cb(null, true)
    cb(new Error('Only JPG, PNG and PDF files are accepted'))
  },
})

// ── Auth helper ───────────────────────────────────────────────────────────────
async function getAuthUser(req: Request): Promise<{ id: string; email: string | undefined; role: string } | null> {
  const token =
    req.cookies?.lx_access_token ||
    req.headers.authorization?.replace('Bearer ', '')
  if (!token) return null

  // Use authClient.auth.getUser — this does NOT mutate session state on service role client
  const { data, error } = await authClient.auth.getUser(token)
  if (error || !data.user) return null

  const { data: account } = await authClient
    .from('accounts')
    .select('role')
    .eq('id', data.user.id)
    .single()

  return {
    id:    data.user.id,
    email: data.user.email,
    role:  account?.role ?? 'client',
  }
}

/**
 * A client document is named by the service that asked for it, so the set is
 * open rather than an enum. It is still constrained: the value becomes a path
 * segment, and anything outside this shape could climb out of the prefix.
 */
const CLIENT_DOC_TYPE = /^[a-z0-9][a-z0-9_-]{0,48}$/
const CLIENT_BUCKET = 'legalx-client-docs'

const VALID_DOC_TYPES = ['profile_photo', 'enrolment_cert', 'bar_id_front', 'bar_id_back', 'govt_id'] as const

// ── POST /api/upload/lawyer-doc ───────────────────────────────────────────────
router.post('/lawyer-doc', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const user = await getAuthUser(req)
    if (!user) return res.status(401).json({ error: 'Not authenticated' })
    if (user.role !== 'lawyer') {
      return res.status(403).json({ error: 'Only lawyers can upload documents' })
    }
    if (!req.file) return res.status(400).json({ error: 'No file provided' })

    const docType = req.query.docType as string
    if (!docType || !(VALID_DOC_TYPES as readonly string[]).includes(docType)) {
      return res.status(400).json({ error: `docType must be one of: ${VALID_DOC_TYPES.join(', ')}` })
    }

    const ext = req.file.mimetype === 'application/pdf' ? 'pdf'
      : req.file.mimetype === 'image/png' ? 'png' : 'jpg'

    const storagePath = `${user.id}/${docType}-${Date.now()}.${ext}`

    // Use storageClient (fresh service role) — never user-JWT-scoped
    const { error: uploadError } = await storageClient.storage
      .from('legalx-lawyer-docs')
      .upload(storagePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true,
      })

    if (uploadError) {
      console.error('[upload/lawyer-doc] Storage error:', JSON.stringify(uploadError))
      return res.status(500).json({ error: `File upload failed: ${uploadError.message}` })
    }

    return res.json({ path: storagePath })
  } catch (err: any) {
    if (err.message?.includes('Only JPG')) return res.status(400).json({ error: err.message })
    if (err.code === 'LIMIT_FILE_SIZE')    return res.status(400).json({ error: 'File too large. Maximum 5 MB.' })
    console.error('[upload/lawyer-doc] Unexpected error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * A document sent inside a consultation.
 *
 * Separate from /lawyer-doc because that route is lawyers only, and in a chat
 * the client is usually the one with the notice, the receipt or the lease. Both
 * participants can upload here; neither can upload to a consultation they are
 * not in.
 *
 * Stored under the consultation, so what was shared during a matter stays
 * findable with it rather than in a flat pile keyed by uploader.
 */
router.post('/chat-attachment', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const user = await getAuthUser(req)
    if (!user) return res.status(401).json({ error: 'Not authenticated' })
    if (!req.file) return res.status(400).json({ error: 'No file provided' })

    const consultationId = String(req.query.consultationId ?? '')
    if (!/^[0-9a-f-]{36}$/i.test(consultationId)) {
      return res.status(400).json({ error: 'consultationId is required' })
    }

    const { data: consultation } = await supabase
      .from('consultations')
      .select('id, client_id, lawyer_id')
      .eq('id', consultationId)
      .maybeSingle()

    if (!consultation) return res.status(404).json({ error: 'Consultation not found' })
    if (consultation.client_id !== user.id && consultation.lawyer_id !== user.id) {
      return res.status(403).json({ error: 'Not your consultation' })
    }

    const ext = req.file.mimetype === 'application/pdf' ? 'pdf'
      : req.file.mimetype === 'image/png' ? 'png' : 'jpg'

    const storagePath = `chat/${consultationId}/${Date.now()}-${user.id.slice(0, 8)}.${ext}`

    const { error: uploadError } = await storageClient.storage
      .from('legalx-lawyer-docs')
      .upload(storagePath, req.file.buffer, { contentType: req.file.mimetype, upsert: false })

    if (uploadError) {
      console.error('[upload/chat-attachment]', uploadError.message)
      return res.status(500).json({ error: 'Upload failed. Please try again.' })
    }

    return res.json({
      path: storagePath,
      name: req.file.originalname?.slice(0, 255) ?? `document.${ext}`,
      size: req.file.size,
    })
  } catch (err: any) {
    if (err.message?.includes('Only JPG')) return res.status(400).json({ error: err.message })
    if (err.code === 'LIMIT_FILE_SIZE')    return res.status(400).json({ error: 'File too large. Maximum 5 MB.' })
    console.error('[upload/chat-attachment] unexpected', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * POST /api/upload/client-doc
 *
 * A document a client attaches to a service application. Separate from
 * /lawyer-doc because that one is gated to lawyers, and from /chat-attachment
 * because there is no consultation to hang it off — the application may not
 * exist yet when the first file arrives, so those land under "draft".
 */
router.post('/client-doc', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const user = await getAuthUser(req)
    if (!user) return res.status(401).json({ error: 'Not authenticated' })
    if (!req.file) return res.status(400).json({ error: 'No file provided' })

    const docType = String(req.query.docType ?? '')
    if (!CLIENT_DOC_TYPE.test(docType)) {
      return res.status(400).json({ error: 'docType must be a short lowercase identifier' })
    }

    const applicationId = String(req.query.applicationId ?? '')
    if (applicationId && !/^[0-9a-f-]{36}$/i.test(applicationId)) {
      return res.status(400).json({ error: 'applicationId is not a valid id' })
    }

    const ext = req.file.mimetype === 'application/pdf' ? 'pdf'
      : req.file.mimetype === 'image/png' ? 'png' : 'jpg'

    const storagePath = `${user.id}/${applicationId || 'draft'}/${docType}-${Date.now()}.${ext}`

    const { error: uploadError } = await storageClient.storage
      .from(CLIENT_BUCKET)
      .upload(storagePath, req.file.buffer, { contentType: req.file.mimetype, upsert: false })

    if (uploadError) {
      console.error('[upload/client-doc] storage error:', uploadError.message)
      return res.status(500).json({ error: 'Upload failed. Please try again.' })
    }

    // An hour for the client's own preview.
    const { data: signed } = await storageClient.storage
      .from(CLIENT_BUCKET)
      .createSignedUrl(storagePath, 60 * 60)

    // A day for the admin's inbox — an alert read tomorrow morning should
    // still open, which an hour-old link would not.
    const { data: adminLink } = await storageClient.storage
      .from(CLIENT_BUCKET)
      .createSignedUrl(storagePath, 60 * 60 * 24)

    // The upload has already succeeded; alerting is a consequence of it, so
    // these are settled and swallowed rather than awaited for status.
    const serviceTitle = String(req.query.serviceTitle ?? '').slice(0, 120) || 'Document service'
    void (async () => {
      const { data: account } = await supabase
        .from('accounts')
        .select('first_name, last_name, email')
        .eq('id', user.id)
        .maybeSingle()

      const clientName = account
        ? `${account.first_name ?? ''} ${account.last_name ?? ''}`.trim() || (account.email ?? 'A client')
        : 'A client'

      await Promise.allSettled([
        sendDocumentUploadedAlert({
          clientName,
          clientEmail: account?.email ?? user.email,
          serviceTitle,
          docType,
          fileName: req.file?.originalname?.slice(0, 255) ?? storagePath.split('/').pop()!,
          storagePath,
          signedUrl: adminLink?.signedUrl ?? null,
        }),
        notifyAdmins({
          title: 'Client document uploaded',
          message: `${clientName} uploaded ${docType} for ${serviceTitle}.`,
          type: 'document',
          link: '/admin/documents',
        }),
      ])
    })().catch(err => console.error('[upload/client-doc] alerts failed', err))

    return res.json({
      path: storagePath,
      url: signed?.signedUrl ?? null,
      name: req.file.originalname?.slice(0, 255) ?? `document.${ext}`,
      size: req.file.size,
    })
  } catch (err: any) {
    if (err.message?.includes('Only JPG')) return res.status(400).json({ error: err.message })
    if (err.code === 'LIMIT_FILE_SIZE')    return res.status(400).json({ error: 'File too large. Maximum 5 MB.' })
    console.error('[upload/client-doc] unexpected error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
