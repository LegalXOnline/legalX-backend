/**
 * All auth in one place. This used to be copy-pasted across seven routes, and
 * the copies had drifted — which is how GET /api/applications/:id ended up
 * with no check at all.
 *
 * Accepts either credential: the website's HttpOnly cookie, or the Bearer
 * token the Android app gets from Supabase.
 */

import type { Request, Response, NextFunction } from 'express'
import crypto from 'crypto'
import { supabase, supabaseAuthValidator } from './supabase'
import { logger } from './logger'

export type Role = 'client' | 'lawyer' | 'admin'

export interface AuthUser {
  id: string
  email: string | undefined
  role: Role
  /** Display name for admin audit bylines. accounts first, JWT metadata second. */
  name: string | null
  /** From accounts.status. Resolved but not gated on — nothing writes it yet. */
  status: string | null
}

export interface AuthedRequest extends Request {
  user?: AuthUser
}

const ROLES: readonly string[] = ['client', 'lawyer', 'admin']

/** Narrows an untrusted value to a Role, or null. Keeps a stray JWT claim out. */
function asRole(value: unknown): Role | null {
  return typeof value === 'string' && ROLES.includes(value) ? (value as Role) : null
}

/** The caller's token, from the cookie the browser sends or the header a device does. */
export function readToken(req: Request): string | null {
  const cookie = req.cookies?.lx_access_token
  if (typeof cookie === 'string' && cookie.length > 0) return cookie

  const header = req.headers.authorization
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim()
    if (token.length > 0) return token
  }

  return null
}

// A route asks for the caller two or three times. Each resolve is a Supabase
// round trip plus a row read, so cache it per request.
const RESOLVED = Symbol('legalx.authUser')

/**
 * The caller, or null. Use where "not signed in" is a case the handler
 * handles; use requireAuth where it should end the request.
 */
export async function getAuthUser(req: Request): Promise<AuthUser | null> {
  const memo = req as Request & { [RESOLVED]?: AuthUser | null }
  if (RESOLVED in memo) return memo[RESOLVED] ?? null

  const user = await resolveAuthUser(req)
  memo[RESOLVED] = user
  return user
}

async function resolveAuthUser(req: Request): Promise<AuthUser | null> {
  const token = readToken(req)
  if (!token) return null

  // Must be the validator client. getUser() caches the session on whichever
  // client calls it, and on the primary that silently rebinds every later
  // query to this user under RLS.
  const { data, error } = await supabaseAuthValidator.auth.getUser(token)
  if (error || !data.user) return null

  // Role comes from accounts, not the JWT. A token is a snapshot; a demotion
  // has to bite now, not whenever it expires.
  const { data: account } = await supabase
    .from('accounts')
    .select('role, status, first_name, last_name')
    .eq('id', data.user.id)
    .maybeSingle()

  const meta = (data.user.user_metadata ?? {}) as Record<string, unknown>

  return {
    id: data.user.id,
    email: data.user.email,
    role: asRole(account?.role) ?? asRole(meta.role) ?? 'client',
    name: resolveName(account, meta),
    status: typeof account?.status === 'string' ? account.status : null,
  }
}

/** accounts first, JWT metadata second, nothing third. Never an empty string. */
function resolveName(
  account: { first_name?: string | null; last_name?: string | null } | null | undefined,
  meta: Record<string, unknown>,
): string | null {
  const fromAccount = [account?.first_name, account?.last_name]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(' ')
    .trim()
  if (fromAccount) return fromAccount

  const fromMeta = [meta.first_name, meta.last_name]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(' ')
    .trim()
  if (fromMeta) return fromMeta

  if (typeof meta.full_name === 'string' && meta.full_name.trim()) return meta.full_name.trim()

  return null
}

/** Ends the request with 401 unless a valid credential is present. */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await getAuthUser(req)
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' })
      return
    }
    ;(req as AuthedRequest).user = user
    next()
  } catch {
    res.status(401).json({ error: 'Unauthorized' })
  }
}

/**
 * 401 when signed out, 403 when the role is wrong. Kept distinct: a 401 means
 * sign in again, a 403 means this will never work.
 */
export function requireRole(...roles: Role[]) {
  return async function roleGate(req: Request, res: Response, next: NextFunction) {
    try {
      const user = await getAuthUser(req)
      if (!user) {
        res.status(401).json({ error: 'Not authenticated' })
        return
      }
      if (!roles.includes(user.role)) {
        res.status(403).json({ error: `Forbidden — ${roles.join(' or ')} access only` })
        return
      }
      ;(req as AuthedRequest).user = user
      next()
    } catch {
      res.status(401).json({ error: 'Unauthorized' })
    }
  }
}

export const requireAdmin = requireRole('admin')
export const requireLawyer = requireRole('lawyer')
export const requireClient = requireRole('client')

/**
 * Attaches the caller if present, never refuses. For routes open to guests
 * that should still record who acted when someone is signed in.
 */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const user = await getAuthUser(req)
    if (user) (req as AuthedRequest).user = user
  } catch {
    // A bad credential on an open route is not an error — carry on as a guest.
  }
  next()
}

/** True when the row is the caller's, or the caller is an admin. */
export function ownsOrAdmin(user: AuthUser, ownerId: string | null | undefined): boolean {
  if (user.role === 'admin') return true
  return ownerId != null && ownerId === user.id
}

// ── Machine credentials ───────────────────────────────────────────────────────

// Machine credential for the leads list and the cron. Thrown at load: a
// service that cannot authenticate its own jobs should not start.
const ADMIN_SECRET = process.env.ADMIN_SECRET
if (!ADMIN_SECRET) {
  throw new Error('ADMIN_SECRET must be set in environment')
}

/**
 * Constant-time compare. A plain === stops at the first wrong byte, and that
 * timing difference is enough to recover a secret one character at a time.
 */
export function constantTimeEqual(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/**
 * One guard, two headers. The difference is deliberate: /api/jobs reads a
 * custom header, which a cross-origin page cannot set without a preflight we
 * never approve — that is what lets it sit outside CSRF. Accepting either
 * header everywhere would quietly undo that.
 */
function machineSecretGuard(headerName: 'authorization' | 'x-admin-secret') {
  const isBearer = headerName === 'authorization'

  return function secretGate(req: Request, res: Response, next: NextFunction) {
    const expected = process.env.ADMIN_SECRET
    if (!expected) {
      // Unreachable today, but misconfigured is a 503, not a 401.
      res.status(503).json({ error: 'Endpoint is not configured' })
      return
    }

    const raw = req.headers[headerName]
    if (typeof raw !== 'string' || raw.length === 0) {
      res.status(401).json({ error: 'Not authenticated' })
      return
    }

    const provided = isBearer && raw.startsWith('Bearer ')
      ? raw.slice('Bearer '.length).trim()
      : raw

    if (!constantTimeEqual(provided, expected)) {
      logger.warn({ reqId: req.id, ip: req.ip, header: headerName }, 'Bad machine credential')
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    next()
  }
}

/** `Authorization: Bearer <ADMIN_SECRET>` — the internal leads endpoints. */
export const requireAdminSecret = machineSecretGuard('authorization')

/** `x-admin-secret: <ADMIN_SECRET>` — the scheduled-job endpoints. */
export const requireJobSecret = machineSecretGuard('x-admin-secret')
