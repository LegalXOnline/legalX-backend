import { Router, Request, Response } from 'express'
import multer from 'multer'
import { createClient } from '@supabase/supabase-js'

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

export default router
