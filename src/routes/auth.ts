import { Router, Request, Response, NextFunction } from 'express'
import { supabase, supabaseAuth } from '../lib/supabase'
import { sendWelcomeEmail, sendLawyerOnboardingWelcome } from '../lib/email'
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
      // Log the exact error to Render console so we can debug why it's failing
      console.error('[SIGNUP ERROR] supabase.auth.admin.createUser failed:', {
        message: error.message,
        name: error.name,
        status: error.status,
      })

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

    // ── NOTE: Database trigger handles accounts & lawyer_profiles insertion ──────
    // The handle_new_auth_user trigger fires automatically on admin.createUser

    // Send welcome email — only the "account created, complete your profile" email for lawyers
    // The admin notification + confirmation email fires when lawyer submits the onboarding form
    if (data.user?.email) {
      if (role === 'lawyer') {
        // Non-blocking: send onboarding welcome (not a "submitted" email)
        sendLawyerOnboardingWelcome(data.user.email, firstName).catch(console.error)
      } else {
        sendWelcomeEmail(data.user.email, firstName, role).catch(console.error)
      }
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

    // Always read role from public.accounts (source of truth), not user_metadata
    // This ensures manually promoted admins get the correct role immediately
    const { data: account } = await supabase
      .from('accounts')
      .select('role, first_name, last_name, status')
      .eq('id', user.id)
      .single()

    // Guard: if no accounts row yet (shouldn't happen after fix, but just in case)
    if (!account) {
      res.status(403).json({ error: 'Account not found. Please contact support.' })
      return
    }

    if (account.status === 'suspended') {
      res.status(403).json({ error: 'This account has been suspended. Please contact support.' })
      return
    }

    res.json({
      user: {
        id: user.id,
        email: user.email,
        firstName: account.first_name ?? user.user_metadata?.first_name ?? '',
        lastName:  account.last_name  ?? user.user_metadata?.last_name  ?? '',
        role:      account.role,        // from accounts table — the real source of truth
      },
    })
  } catch (err) {
    next(err)
  }
})

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
// Signs out from Supabase server-side (invalidates JWT) AND clears cookies.
router.post('/logout', async (req: Request, res: Response) => {
  const token =
    req.cookies?.lx_access_token ||
    req.headers.authorization?.replace('Bearer ', '')

  // Best-effort Supabase signOut — invalidates JWT server-side
  if (token) {
    await supabase.auth.admin.signOut(token).catch(() => {})
  }

  const isProduction = process.env.NODE_ENV === 'production'
  res.clearCookie('lx_access_token', {
    httpOnly: true, secure: isProduction, sameSite: isProduction ? 'none' : 'lax', path: '/',
  })
  res.clearCookie('lx_refresh_token', {
    httpOnly: true, secure: isProduction, sameSite: isProduction ? 'none' : 'lax', path: '/',
  })
  res.clearCookie('csrf_secret', { httpOnly: true, path: '/' })
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

    // Read role from accounts table — single source of truth
    const { data: account } = await supabase
      .from('accounts')
      .select('role, first_name, last_name, status')
      .eq('id', u.id)
      .single()

    if (!account) {
      res.status(401).json({ error: 'Account not found' })
      return
    }

    if (account.status === 'suspended') {
      res.status(403).json({ error: 'Account suspended' })
      return
    }

    res.json({
      user: {
        id: u.id,
        email: u.email,
        firstName: account.first_name ?? u.user_metadata?.first_name ?? '',
        lastName:  account.last_name  ?? u.user_metadata?.last_name  ?? '',
        role:      account.role,
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
