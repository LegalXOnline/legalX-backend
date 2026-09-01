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
 * ANON client — used only for flows that must run as an unauthenticated
 * end user, i.e. sending password-recovery emails.
 *
 * flowType MUST stay 'implicit'. supabase-js defaults to PKCE, which stores a
 * code verifier in the client that started the flow — this server process. The
 * browser that finally opens the emailed link could never reach that verifier,
 * so the recovery would always fail. Implicit flow instead returns the tokens
 * to the browser in the URL hash, which /reset-password reads.
 */
const anonKey = process.env.SUPABASE_ANON_KEY
if (!anonKey) {
  console.warn('[supabase] SUPABASE_ANON_KEY is not set — password recovery will fall back to the service-role key')
}

export const supabaseAnon = createClient(url, anonKey || serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false, flowType: 'implicit' },
})
