import { Router, Request, Response, NextFunction } from 'express'
import multer from 'multer'
import { createClient } from '@supabase/supabase-js'
import { supabase, supabaseAuthValidator } from '../lib/supabase'
import { validateBody, profileUpdateSchema } from '../lib/validation'

const router = Router()

const AVATAR_BUCKET = 'legalx-client-avatars'
const SIGNED_URL_TTL = 60 * 60

/** Service-role client for storage. Never scoped to a user JWT. */
const storageClient = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp']
    if (allowed.includes(file.mimetype)) return cb(null, true)
    cb(new Error('Profile photos must be JPG, PNG or WebP'))
  },
})

interface AuthedRequest extends Request {
  user?: { id: string; email: string }
}

async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.lx_access_token || req.headers.authorization?.replace('Bearer ', '')
    if (!token) return res.status(401).json({ error: 'Not authenticated' })

    const { data, error } = await supabaseAuthValidator.auth.getUser(token)
    if (error || !data.user) return res.status(401).json({ error: 'Invalid or expired session' })

    req.user = { id: data.user.id, email: data.user.email ?? '' }
    next()
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }
}

/** The stored path signed for reading, or null. The bucket is private. */
async function signAvatar(path: string | null): Promise<string | null> {
  if (!path) return null
  const { data } = await storageClient.storage.from(AVATAR_BUCKET).createSignedUrl(path, SIGNED_URL_TTL)
  return data?.signedUrl ?? null
}

// ── GET /api/profile ─────────────────────────────────────────────────────────
// /api/auth/me carries only what the session needs. This is the whole record
// the profile screen renders, photo included.
router.get('/', requireAuth, async (req: AuthedRequest, res: Response, next: NextFunction) => {
  try {
    const { data, error } = await supabase
      .from('accounts')
      .select('first_name, last_name, email, phone, avatar_url')
      .eq('id', req.user!.id)
      .single()

    if (error || !data) return res.status(404).json({ error: 'Profile not found' })

    return res.json({
      profile: {
        firstName: data.first_name ?? '',
        lastName: data.last_name ?? '',
        email: data.email ?? req.user!.email,
        phone: data.phone ?? '',
        avatarUrl: await signAvatar(data.avatar_url),
      },
    })
  } catch (err) {
    next(err)
  }
})

// ── PATCH /api/profile ───────────────────────────────────────────────────────
router.patch(
  '/',
  requireAuth,
  validateBody(profileUpdateSchema),
  async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const { firstName, lastName, phone } = req.body as {
        firstName?: string
        lastName?: string
        phone?: string
      }

      const patch: Record<string, string> = {}
      if (firstName !== undefined) patch.first_name = firstName
      if (lastName !== undefined) patch.last_name = lastName
      if (phone !== undefined) patch.phone = phone

      const { data, error } = await supabase
        .from('accounts')
        .update(patch)
        .eq('id', req.user!.id)
        .select('first_name, last_name, email, phone, avatar_url')
        .single()

      if (error) {
        // phone is UNIQUE on accounts, so a number already in use comes back
        // as a constraint violation rather than a validation failure.
        if (error.code === '23505') {
          return res.status(409).json({ error: 'That mobile number is already on another account' })
        }
        console.error('[profile] update failed:', error.message)
        return res.status(500).json({ error: 'Could not save your profile' })
      }

      return res.json({
        profile: {
          firstName: data.first_name ?? '',
          lastName: data.last_name ?? '',
          email: data.email ?? req.user!.email,
          phone: data.phone ?? '',
          avatarUrl: await signAvatar(data.avatar_url),
        },
      })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * GET /api/profile/photo
 *
 * Redirects to a freshly signed URL, the same way lawyer photos are served.
 * A stable path means a client can put it straight in an <img> and never deal
 * with an hour-old signature going stale mid-session.
 */
router.get('/photo', requireAuth, async (req: AuthedRequest, res: Response) => {
  const { data } = await supabase
    .from('accounts')
    .select('avatar_url')
    .eq('id', req.user!.id)
    .maybeSingle()

  const path = data?.avatar_url
  if (!path) return res.status(404).json({ error: 'No photo' })
  if (/^https?:\/\//i.test(path)) return res.redirect(302, path)

  const signed = await signAvatar(path)
  if (!signed) return res.status(404).json({ error: 'No photo' })
  return res.redirect(302, signed)
})

// ── POST /api/profile/photo ──────────────────────────────────────────────────
// Multipart, so it cannot share the JSON route above.
router.post('/photo', requireAuth, upload.single('file'), async (req: AuthedRequest, res: Response) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' })

    const ext = req.file.mimetype === 'image/png' ? 'png'
      : req.file.mimetype === 'image/webp' ? 'webp' : 'jpg'
    const path = `${req.user!.id}/avatar-${Date.now()}.${ext}`

    const { error: uploadError } = await storageClient.storage
      .from(AVATAR_BUCKET)
      .upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: false })

    if (uploadError) {
      console.error('[profile/photo] storage error:', uploadError.message)
      return res.status(500).json({ error: 'Upload failed. Please try again.' })
    }

    const { data: previous } = await supabase
      .from('accounts')
      .select('avatar_url')
      .eq('id', req.user!.id)
      .maybeSingle()

    const { error: saveError } = await supabase
      .from('accounts')
      .update({ avatar_url: path })
      .eq('id', req.user!.id)

    if (saveError) {
      console.error('[profile/photo] save failed:', saveError.message)
      return res.status(500).json({ error: 'Could not save your photo' })
    }

    // The old file is now unreachable; leaving it would grow the bucket with
    // every change. Best-effort: the new photo is already saved.
    if (previous?.avatar_url && previous.avatar_url !== path) {
      void storageClient.storage.from(AVATAR_BUCKET).remove([previous.avatar_url])
    }

    return res.json({ avatarUrl: await signAvatar(path) })
  } catch (err) {
    const e = err as { message?: string; code?: string }
    if (e.message?.includes('Profile photos must be')) return res.status(400).json({ error: e.message })
    if (e.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Photo too large. Maximum 3 MB.' })
    console.error('[profile/photo] unexpected:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
