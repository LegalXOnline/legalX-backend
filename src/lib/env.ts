/**
 * isProduction — true when running on Render (or any env where NODE_ENV=production).
 *
 * Render sets the env var RENDER=true automatically on all deployed services.
 * This means even if NODE_ENV is misconfigured, cookies/CORS still behave correctly.
 *
 * DO NOT use process.env.NODE_ENV directly for security-sensitive config.
 * Use this helper instead.
 */
export const isProduction: boolean =
  process.env.RENDER === 'true' ||
  process.env.NODE_ENV === 'production' ||
  process.env.IS_PRODUCTION === 'true'

export const isDevelopment = !isProduction

/**
 * Origins the frontend is allowed to be served from. Mirrors the CORS
 * allowlist in index.ts so that redirect URLs we hand to Supabase can be
 * validated the same way CORS validates browsers.
 */
export const allowedOrigins: string[] = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean)

export function isAllowedOrigin(origin: string): boolean {
  if (allowedOrigins.includes(origin)) return true
  if (isDevelopment) return /^http:\/\/localhost:\d{2,5}$/.test(origin)
  return (
    origin === 'https://legalxonline.com' ||
    origin === 'https://www.legalxonline.com' ||
    origin.endsWith('.legalxonline.com') ||
    origin.endsWith('.vercel.app')
  )
}

/** Fallback used when we cannot trust (or do not have) a request origin. */
export const publicAppUrl: string =
  process.env.PUBLIC_APP_URL || (isProduction ? 'https://www.legalxonline.com' : 'http://localhost:3000')

/**
 * Pick the origin to build a user-facing link from. `candidate` values come
 * from the request (body or Origin header) and are therefore untrusted — an
 * unrecognised one is discarded rather than echoed back into an email link.
 */
export function resolveAppOrigin(...candidates: (string | undefined | null)[]): string {
  for (const c of candidates) {
    if (c && isAllowedOrigin(c)) return c.replace(/\/+$/, '')
  }
  return publicAppUrl.replace(/\/+$/, '')
}
