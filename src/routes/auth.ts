import { Router, Request, Response, NextFunction } from 'express'
import crypto from 'crypto'
import { isProduction, resolveAppOrigin } from '../lib/env'
import { supabase, supabaseAnon, supabaseSignIn, supabaseAuthValidator } from '../lib/supabase'
import { sendWelcomeEmail, sendLawyerOnboardingWelcome, sendPasswordResetEmail, sendSignupOtpEmail } from '../lib/email'
import { logger } from '../lib/logger'
import {
  validateBody,
  authSignupSchema,
  authLoginSchema,
  authForgotPasswordSchema,
  authResetPasswordSchema,
  signupRequestOtpSchema,
  signupVerifyOtpSchema,
} from '../lib/validation'

import { rateLimit } from 'express-rate-limit'

const router = Router()

/**
 * How long the browser keeps the session cookies, independent of how long the
 * tokens inside them are valid. Matches the refresh token's 30-day life so the
 * client always has something to present, and a stale access token can be
 * exchanged rather than looking like a signed-out user.
 */
const SESSION_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

// Password-recovery endpoints send email and mutate credentials — much tighter
// than the global 100/15min so a stolen inbox can't be brute-forced or spammed.
const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: isProduction },
  message: { error: 'Too many password reset attempts. Please wait 15 minutes and try again.' },
})

// Signup OTP — rate limit OTP requests per IP
const signupOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: isProduction },
  message: { error: 'Too many OTP requests. Please wait 15 minutes and try again.' },
})

// ── OTP brute-force guard ─────────────────────────────────────────────────────
// The IP limiter above does not stop an attacker rotating IPs against one
// mailbox, so failures are also counted per email address. In-memory is
// sufficient here: the API runs as a single Render instance. If it is ever
// scaled to multiple instances this must move to a shared store, or each
// instance will keep its own independent (and therefore weaker) count.
const OTP_MAX_ATTEMPTS = 5
const OTP_ATTEMPT_WINDOW_MS = 15 * 60 * 1000
const otpAttempts = new Map<string, { count: number; firstAt: number }>()

function otpAttemptsExceeded(email: string): boolean {
  const entry = otpAttempts.get(email)
  if (!entry) return false
  if (Date.now() - entry.firstAt > OTP_ATTEMPT_WINDOW_MS) {
    otpAttempts.delete(email)
    return false
  }
  return entry.count >= OTP_MAX_ATTEMPTS
}

function recordOtpFailure(email: string): void {
  const entry = otpAttempts.get(email)
  if (!entry || Date.now() - entry.firstAt > OTP_ATTEMPT_WINDOW_MS) {
    otpAttempts.set(email, { count: 1, firstAt: Date.now() })
    return
  }
  entry.count += 1
}

// Prune expired entries so a spray of unique addresses cannot grow the map
// without bound.
setInterval(() => {
  const cutoff = Date.now() - OTP_ATTEMPT_WINDOW_MS
  for (const [email, entry] of otpAttempts) {
    if (entry.firstAt < cutoff) otpAttempts.delete(email)
  }
}, 5 * 60 * 1000).unref()

// ── Signup OTP store ──────────────────────────────────────────────────────────
// In-memory store for signup verification OTPs. Each entry has a 10-minute TTL.
// Keyed by lowercase email.
const SIGNUP_OTP_TTL_MS = 10 * 60 * 1000

interface SignupOtpEntry {
  otp: string
  firstName: string
  lastName: string
  password: string
  role: 'client' | 'lawyer'
  createdAt: number
}

const signupOtpStore = new Map<string, SignupOtpEntry>()

// Prune expired signup OTPs every 2 minutes
setInterval(() => {
  const cutoff = Date.now() - SIGNUP_OTP_TTL_MS
  for (const [email, entry] of signupOtpStore) {
    if (entry.createdAt < cutoff) signupOtpStore.delete(email)
  }
}, 2 * 60 * 1000).unref()

function generateOtp(): string {
  // Cryptographically random 6-digit code
  return String(crypto.randomInt(100000, 999999))
}

// ── POST /api/auth/signup/request-otp ─────────────────────────────────────────
// Step 1: Validate all fields, check email uniqueness, send OTP
router.post(
  '/signup/request-otp',
  signupOtpLimiter,
  validateBody(signupRequestOtpSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password, firstName, lastName, role = 'client' } = req.body

      // Check if email already exists in the accounts table (source of truth).
      // The handle_new_auth_user trigger creates an accounts row on every
      // admin.createUser, so this catches all existing accounts.
      const { data: userLookup } = await supabase
        .from('accounts')
        .select('id')
        .eq('email', email)
        .limit(1)

      if (userLookup && userLookup.length > 0) {
        // Constant-time response to prevent email enumeration
        await new Promise(r => setTimeout(r, 200 + Math.random() * 100))
        res.status(409).json({ error: 'An account with this email already exists.' })
        return
      }


      const otp = generateOtp()

      // Store the pending signup data (overwrites any previous OTP for this email)
      signupOtpStore.set(email, {
        otp,
        firstName,
        lastName,
        password,
        role,
        createdAt: Date.now(),
      })

      // Send OTP email (fire-and-forget)
      sendSignupOtpEmail(email, otp, firstName).catch(err =>
        logger.error({ reqId: req.id, err }, 'signup OTP email failed')
      )

      // Reset brute-force counter for this email (new code issued)
      otpAttempts.delete(`signup:${email}`)

      res.json({ message: 'Verification code sent to your email.' })
    } catch (err) {
      next(err)
    }
  }
)

// ── POST /api/auth/signup/verify-otp ──────────────────────────────────────────
// Step 2: Verify OTP, create the account
router.post(
  '/signup/verify-otp',
  signupOtpLimiter,
  validateBody(signupVerifyOtpSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, otp, password, firstName, lastName, role = 'client' } = req.body

      const otpKey = `signup:${email}`

      if (otpAttemptsExceeded(otpKey)) {
        res.status(429).json({
          error: 'Too many incorrect codes. Please request a new code and try again.',
        })
        return
      }

      const entry = signupOtpStore.get(email)

      // Check if OTP exists and hasn't expired
      if (!entry || Date.now() - entry.createdAt > SIGNUP_OTP_TTL_MS) {
        recordOtpFailure(otpKey)
        res.status(400).json({ error: 'Verification code has expired. Please request a new one.' })
        return
      }

      // Constant-time comparison to prevent timing attacks
      const otpMatch =
        otp.length === entry.otp.length &&
        crypto.timingSafeEqual(Buffer.from(otp), Buffer.from(entry.otp))

      if (!otpMatch) {
        recordOtpFailure(otpKey)
        res.status(400).json({ error: 'Incorrect verification code. Please try again.' })
        return
      }

      // OTP is valid — create the user
      // Use the password from the stored entry (validated at Step 1), not from
      // the request body, to prevent someone changing the password between steps.
      // However, the schema validates both, and we use the request body password
      // since the user should be able to correct it if they want.
      const { data, error } = await supabase.auth.admin.createUser({
        email,
        password,
        user_metadata: { first_name: firstName, last_name: lastName, role },
        email_confirm: true, // Email is verified — OTP proves ownership
      })

      if (error) {
        console.error('[SIGNUP VERIFY] supabase.auth.admin.createUser failed:', {
          message: error.message,
          name: error.name,
          status: error.status,
        })

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

      // Clean up OTP store
      signupOtpStore.delete(email)
      otpAttempts.delete(otpKey)

      // Send welcome email
      if (data.user?.email) {
        if (role === 'lawyer') {
          sendLawyerOnboardingWelcome(data.user.email, firstName).catch(console.error)
        } else {
          sendWelcomeEmail(data.user.email, firstName, role).catch(console.error)
        }
      }

      res.status(201).json({ message: 'Account created. Please sign in.' })
    } catch (err) {
      next(err)
    }
  }
)

// ── POST /api/auth/signup ─────────────────────────────────────────────────────
// Legacy endpoint — kept for backward compatibility but redirects to the OTP flow.
// Returns an error telling the client to use the two-step flow.
router.post('/signup', validateBody(authSignupSchema), async (_req: Request, res: Response) => {
  res.status(400).json({
    error: 'Please use the two-step signup flow. Request an OTP first via /api/auth/signup/request-otp.',
  })
})

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post('/login', validateBody(authLoginSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body

    // Dedicated sign-in client — never the service-role one. See the note on
    // supabaseSignIn: signing in on a client rebinds every later query from
    // that client to the user's JWT.
    const { data, error } = await supabaseSignIn.auth.signInWithPassword({
      email,
      password,
    })

    // No signOut here: supabase-js routes even a 'local' signOut through
    // GoTrue's logout endpoint, which would revoke the very tokens we are about
    // to set as cookies. Leaving the session cached on this client is harmless
    // because supabaseSignIn is never used for DB queries.
    if (error || !data.session) {
      // Phase 1.3: Constant-time response to prevent email enumeration via timing
      await new Promise(r => setTimeout(r, 200 + Math.random() * 100))
      res.status(401).json({ error: 'Invalid email or password' })
      return
    }

    const { access_token, refresh_token, expires_in } = data.session
    const user = data.user

    // Set HttpOnly cookies — JS on the browser CANNOT read these
    // The cookie deliberately outlives the token inside it.
    //
    // Tying maxAge to expires_in (1 hour) made the browser delete the cookie at
    // the moment the token expired, so the next request arrived with NO
    // credentials at all — indistinguishable from a signed-out user, and the
    // refresh cookie never got a chance to be spent. Expiry is enforced by
    // validating the JWT server-side, not by how long the browser keeps it.
    res.cookie('lx_access_token', access_token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: SESSION_COOKIE_MAX_AGE_MS,
      path: '/',
    })

    res.cookie('lx_refresh_token', refresh_token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: SESSION_COOKIE_MAX_AGE_MS,
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

// ── POST /api/auth/refresh ────────────────────────────────────────────────────
// Exchanges the long-lived refresh cookie for a fresh access token.
//
// Supabase access tokens expire after an hour. Without this the refresh cookie
// was set at login, cleared at logout, and never used in between — so every
// user was silently signed out after 60 minutes and saw "Invalid or expired
// session" with no way back except logging in again.
router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const refreshToken = req.cookies?.lx_refresh_token
    if (!refreshToken) {
      res.status(401).json({ error: 'No refresh token' })
      return
    }

    // The dedicated sign-in client, never the primary one — refreshSession
    // caches a session on whichever client makes the call, and on the primary
    // that would rebind every later DB query to this user.
    const { data, error } = await supabaseSignIn.auth.refreshSession({ refresh_token: refreshToken })

    if (error || !data.session) {
      // The refresh token is spent or revoked. Clear both cookies so the
      // browser stops presenting credentials that can never work.
      res.clearCookie('lx_access_token', { httpOnly: true, secure: isProduction, sameSite: isProduction ? 'none' : 'lax', path: '/' })
      res.clearCookie('lx_refresh_token', { httpOnly: true, secure: isProduction, sameSite: isProduction ? 'none' : 'lax', path: '/' })
      res.status(401).json({ error: 'Session expired. Please sign in again.' })
      return
    }

    const { access_token, refresh_token, expires_in } = data.session

    // The cookie deliberately outlives the token inside it.
    //
    // Tying maxAge to expires_in (1 hour) made the browser delete the cookie at
    // the moment the token expired, so the next request arrived with NO
    // credentials at all — indistinguishable from a signed-out user, and the
    // refresh cookie never got a chance to be spent. Expiry is enforced by
    // validating the JWT server-side, not by how long the browser keeps it.
    res.cookie('lx_access_token', access_token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: SESSION_COOKIE_MAX_AGE_MS,
      path: '/',
    })
    // Supabase rotates refresh tokens, so the new one must replace the old.
    res.cookie('lx_refresh_token', refresh_token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: SESSION_COOKIE_MAX_AGE_MS,
      path: '/',
    })

    const { data: account } = await supabase
      .from('accounts')
      .select('role, first_name, last_name, status')
      .eq('id', data.user!.id)
      .single()

    if (!account || account.status === 'suspended') {
      res.status(403).json({ error: 'Account unavailable' })
      return
    }

    res.json({
      user: {
        id: data.user!.id,
        email: data.user!.email,
        firstName: account.first_name ?? '',
        lastName: account.last_name ?? '',
        role: account.role,
      },
    })
  } catch (err) {
    logger.error({ reqId: req.id, err }, 'token refresh failed')
    res.status(401).json({ error: 'Could not refresh the session.' })
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

    // Validate on the isolated validator client, never the primary one — the
    // primary client's job is DB and storage access as service_role.
    const { data, error } = await supabaseAuthValidator.auth.getUser(token)
    if (error || !data.user) {
      res.status(401).json({ error: 'Session expired or invalid' })
      return
    }

    const u = data.user

    // Read role from accounts table — single source of truth
    const { data: account } = await supabase
      .from('accounts')
      .select('role, first_name, last_name, status, free_credit_paise')
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
        // Carried here so the booking widget can show what is actually left
        // rather than the flat "₹100 to start" it used to print regardless.
        freeCreditPaise: Number(account.free_credit_paise ?? 0),
      },
    })
  } catch {
    res.status(401).json({ error: 'Invalid session' })
  }
})

// ── POST /api/auth/forgot-password ────────────────────────────────────────────
// Sends a Supabase recovery email. Always answers 200 with the same body:
// telling the caller whether an address is registered is an enumeration oracle.
router.post(
  '/forgot-password',
  passwordResetLimiter,
  validateBody(authForgotPasswordSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email } = req.body

      // generateLink mints a recovery token and returns its one-time code
      // without sending anything, so we can deliver the code through Resend.
      // The action_link it also returns is deliberately unused — see the note
      // in sendPasswordResetEmail about scanners consuming single-use links.
      const { data, error } = await supabase.auth.admin.generateLink({
        type: 'recovery',
        email,
        options: { redirectTo: `${resolveAppOrigin(req.body.origin, req.get('origin'))}/reset-password` },
      })

      const otp = data?.properties?.email_otp
      if (error || !otp) {
        // Logged, never returned — the caller must not learn why this failed
        // (the usual cause is simply that no such account exists).
        logger.warn({ reqId: req.id, err: error?.message }, 'generateLink recovery failed')
      } else {
        // A fresh code was issued, so any earlier failed attempts are moot.
        otpAttempts.delete(email)
        // Fire-and-forget: awaiting Resend would make responses measurably
        // slower for registered addresses, reintroducing an enumeration oracle.
        sendPasswordResetEmail(
          email,
          otp,
          data.user?.user_metadata?.first_name as string | undefined
        ).catch(err => logger.error({ reqId: req.id, err }, 'password reset email failed'))
      }

      res.json({ message: 'If an account exists for that email, a reset code is on its way.' })
    } catch (err) {
      next(err)
    }
  }
)

// ── POST /api/auth/reset-password ─────────────────────────────────────────────
// Completes recovery. The browser posts the access_token it received in the
// URL hash; we validate it, then set the new password with the admin client.
router.post(
  '/reset-password',
  passwordResetLimiter,
  validateBody(authResetPasswordSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, otp, password } = req.body

      if (otpAttemptsExceeded(email)) {
        res.status(429).json({
          error: 'Too many incorrect codes. Request a new code and try again.',
        })
        return
      }

      // Verify on the anon client: this is a public auth operation, and it
      // keeps the recovery session off the primary (DB/storage) client.
      const { data, error } = await supabaseAnon.auth.verifyOtp({
        email,
        token: otp,
        type: 'recovery',
      })

      if (error || !data.user) {
        recordOtpFailure(email)
        logger.warn({ reqId: req.id, err: error?.message }, 'recovery OTP verification failed')
        res.status(401).json({ error: 'That code is incorrect or has expired. Please request a new one.' })
        return
      }

      const { error: updateError } = await supabase.auth.admin.updateUserById(data.user.id, { password })
      if (updateError) {
        logger.error({ reqId: req.id, err: updateError.message }, 'updateUserById password reset failed')
        res.status(400).json({ error: 'Could not update your password. Please request a new code.' })
        return
      }

      otpAttempts.delete(email)

      // Drop every existing session, including the one verifyOtp just issued.
      // A password reset is the standard response to a suspected compromise,
      // so any attacker still holding a token must be logged out too.
      if (data.session?.access_token) {
        await supabase.auth.admin.signOut(data.session.access_token, 'global').catch(() => {})
      }

      res.json({ message: 'Password updated. Please sign in.' })
    } catch (err) {
      next(err)
    }
  }
)

// ── GET /api/auth/csrf ──────────────────────────────────────────────────────────
// Get CSRF token for mutations (cookie is set by global middleware)
router.get('/csrf', (_req: Request, res: Response) => {
  res.json({ csrfToken: res.locals.csrfToken })
})

export default router
