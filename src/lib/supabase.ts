import { createClient } from '@supabase/supabase-js'

const url        = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !serviceKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in environment')
}

/**
 * PRIMARY admin client — service_role key.
 * Used for all DB reads/writes and storage operations.
 * NEVER call supabase.auth.setSession() or supabase.auth.getUser(userJwt)
 * on this client — it will contaminate the session context for subsequent ops.
 */
export const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

/**
 * AUTH validation client — service_role key, separate instance.
 * Use ONLY for validating incoming user JWTs via auth.getUser(token).
 * Keeping this separate from `supabase` ensures user-JWT context
 * never leaks into DB or storage operations on the primary client.
 */
export const supabaseAuthValidator = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

/**
 * Alias kept for backward compat — same as supabase (service role).
 */
export const supabaseAuth = supabase

/**
 * ANON client — for auth operations that must run as an unauthenticated end
 * user. Currently only verifyOtp() during password recovery: that call is
 * defined against the public anon role, and running it here keeps the
 * recovery session off the primary client entirely.
 */
const anonKey = process.env.SUPABASE_ANON_KEY
if (!anonKey) {
  console.warn('[supabase] SUPABASE_ANON_KEY is not set — password reset OTP verification will not work')
}

export const supabaseAnon = createClient(url, anonKey || serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})
