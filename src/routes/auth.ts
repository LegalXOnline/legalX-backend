import { Router, Request, Response, NextFunction } from 'express'
import { supabase, supabaseAuth } from '../lib/supabase'
import { sendWelcomeEmail } from '../lib/email'
import { validateBody, authSignupSchema, authLoginSchema } from '../lib/validation'

import { rateLimit } from 'express-rate-limit'

const router = Router()

// ── POST /api/auth/signup ─────────────────────────────────────────────────────
router.post('/signup', validateBody(authSignupSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password, firstName, lastName, role = 'client' } = req.body

    // Use admin client to create the user (service_role required for admin.createUser)
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      user_metadata: { first_name: firstName, last_name: lastName, role },
      email_confirm: true, // Bypass Supabase's built-in confirmation email
    })

    if (error) {
      // Phase 1.3: Never leak raw Supabase error text — normalize to safe messages
      const isDuplicate = error.message.toLowerCase().includes('already') ||
                          error.message.toLowerCase().includes('exists') ||
                          error.code === 'email_exists'
      res.status(isDuplicate ? 409 : 400).json({
        error: isDuplicate
          ? 'An account with this email already exists.'
          : 'Account creation failed. Please try again.',
      })
      return
    }

    // Send our custom welcome email via Resend
    if (data.user?.email) {
      await sendWelcomeEmail(data.user.email, firstName, role)
    }

    res.status(201).json({ message: 'Account created. Please sign in.' })
  } catch (err) {
    next(err)
  }
})

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post('/login', validateBody(authLoginSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body

    // Use anon client — correctly validates user credentials
    const { data, error } = await supabaseAuth.auth.signInWithPassword({
      email,
      password,
    })

    if (error || !data.session) {
      // Phase 1.3: Constant-time response to prevent email enumeration via timing
      await new Promise(r => setTimeout(r, 200 + Math.random() * 100))
      res.status(401).json({ error: 'Invalid email or password' })
      return
    }

    const { access_token, refresh_token, expires_in } = data.session
    const user = data.user
    const isProduction = process.env.NODE_ENV === 'production'

    // Set HttpOnly cookies — JS on the browser CANNOT read these
    res.cookie('lx_access_token', access_token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: expires_in * 1000,
      path: '/',
    })

    res.cookie('lx_refresh_token', refresh_token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      path: '/',
    })

    res.json({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.user_metadata?.first_name ?? '',
        lastName: user.user_metadata?.last_name ?? '',
        role: user.user_metadata?.role ?? 'client',
      },
    })
  } catch (err) {
    next(err)
  }
})

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
router.post('/logout', (_req: Request, res: Response) => {
  res.clearCookie('lx_access_token', { path: '/' })
  res.clearCookie('lx_refresh_token', { path: '/' })
  res.json({ message: 'Logged out' })
})

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
// Called by Next.js proxy middleware to validate every protected-route request.
router.get('/me', async (req: Request, res: Response) => {
  try {
    const token =
      req.cookies?.lx_access_token ||
      req.headers.authorization?.replace('Bearer ', '')

    if (!token) {
      res.status(401).json({ error: 'Not authenticated' })
      return
    }

    // service_role client validates the JWT — no DB hit for auth check
    const { data, error } = await supabase.auth.getUser(token)
    if (error || !data.user) {
      res.status(401).json({ error: 'Session expired or invalid' })
      return
    }

    const u = data.user
    res.json({
      user: {
        id: u.id,
        email: u.email,
        firstName: u.user_metadata?.first_name ?? '',
        lastName: u.user_metadata?.last_name ?? '',
        role: u.user_metadata?.role ?? 'client',
      },
    })
  } catch {
    res.status(401).json({ error: 'Invalid session' })
  }
})

// ── GET /api/auth/csrf ──────────────────────────────────────────────────────────
// Get CSRF token for mutations (cookie is set by global middleware)
router.get('/csrf', (_req: Request, res: Response) => {
  res.json({ csrfToken: res.locals.csrfToken })
})

export default router
