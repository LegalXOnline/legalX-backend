import { Router, Request, Response, NextFunction } from 'express'
import { supabase, supabaseAuthValidator } from '../lib/supabase'
import { validateBody, profileUpdateSchema } from '../lib/validation'

const router = Router()

/**
 * The signed-in account.
 *
 * Same cookie-or-bearer pattern the payment routes use, so the mobile client
 * and the web client both reach this with the credential each already holds.
 */
async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.lx_access_token || req.headers.authorization?.replace('Bearer ', '')
    if (!token) return res.status(401).json({ error: 'Not authenticated' })

    const { data, error } = await supabaseAuthValidator.auth.getUser(token)
    if (error || !data.user) return res.status(401).json({ error: 'Invalid or expired session' })

    ;(req as Request & { user?: { id: string } }).user = { id: data.user.id }
    next()
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }
}

/**
 * PATCH /api/profile
 *
 * Writes to accounts, not a profiles table — accounts is where first_name,
 * last_name actually live. Role, status and email are not
 * editable here by design: those are decided elsewhere, and accepting them
 * would make this endpoint a privilege escalation.
 */
router.patch(
  '/',
  requireAuth,
  validateBody(profileUpdateSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as Request & { user?: { id: string } }).user!.id
      const { firstName, lastName } = req.body as { firstName?: string; lastName?: string }

      const patch: Record<string, string> = {}
      if (firstName !== undefined) patch.first_name = firstName
      if (lastName !== undefined) patch.last_name = lastName

      const { data, error } = await supabase
        .from('accounts')
        .update(patch)
        .eq('id', userId)
        .select('first_name, last_name')
        .single()

      if (error) {
        console.error('[profile] update failed:', error.message)
        return res.status(500).json({ error: 'Could not save your profile' })
      }

      return res.json({
        profile: {
          firstName: data.first_name ?? '',
          lastName: data.last_name ?? '',
        },
      })
    } catch (err) {
      next(err)
    }
  },
)

export default router
