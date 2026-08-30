import { Router, Request, Response } from 'express'
import multer from 'multer'
import { supabase } from '../lib/supabase'

const router = Router()

// ── Multer: memory storage (buffer sent directly to Supabase Storage) ─────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB hard limit
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
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return null

  const { data: account } = await supabase
    .from('accounts')
    .select('role')
    .eq('id', data.user.id)
    .single()

  return {
    id: data.user.id,
    email: data.user.email,
    role: account?.role ?? (data.user.role ?? 'client'),
  }
}

const VALID_DOC_TYPES = ['profile_photo', 'enrolment_cert', 'bar_id_front', 'bar_id_back', 'govt_id'] as const

// ── POST /api/upload/lawyer-doc ───────────────────────────────────────────────
// Accepts: multipart/form-data, field "file", query param "docType"
// Returns: { path: string } — Supabase Storage path for this file
// Admin retrieves signed URLs via GET /api/admin/lawyers/:id/docs (never public)
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

    // Storage path: {userId}/{docType}-{timestamp}.{ext}
    const storagePath = `${user.id}/${docType}-${Date.now()}.${ext}`

    const { error: uploadError } = await supabase.storage
      .from('legalx-lawyer-docs')
      .upload(storagePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true, // overwrite if lawyer re-uploads
      })

    if (uploadError) {
      console.error('[upload/lawyer-doc] Storage error:', uploadError.message)
      return res.status(500).json({ error: 'File upload failed. Please try again.' })
    }

    return res.json({ path: storagePath })
  } catch (err: any) {
    if (err.message?.includes('Only JPG')) return res.status(400).json({ error: err.message })
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File too large. Maximum size is 5 MB.' })
    console.error('[upload/lawyer-doc] Unexpected error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
