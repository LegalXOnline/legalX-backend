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

const anonKey = process.env.SUPABASE_ANON_KEY
if (!anonKey) {
  console.warn('[supabase] SUPABASE_ANON_KEY is not set — password reset and login will not work correctly')
}

/**
 * ANON client — for auth operations that must run as an unauthenticated end
 * user (verifyOtp during password recovery).
 */
export const supabaseAnon = createClient(url, anonKey || serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

/**
 * SIGN-IN client — used ONLY for signInWithPassword.
 *
 * This must never be the service-role client. signInWithPassword stores the
 * returned session on whichever client made the call (persistSession: false
 * only stops it being written to disk, not held in memory), and supabase-js
 * then sends that user's JWT as the Authorization header on every subsequent
 * request from that client. Calling it on the primary client therefore
 * downgrades all later DB reads from service_role to that one user, silently
 * applying RLS and making rows disappear until the process restarts.
 *
 * Kept as its own instance so a login cannot disturb the recovery flow either.
 */
export const supabaseSignIn = createClient(url, anonKey || serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})
