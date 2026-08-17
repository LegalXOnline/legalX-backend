import { createClient } from '@supabase/supabase-js'

const url        = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const anonKey    = process.env.SUPABASE_ANON_KEY

if (!url || !serviceKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in environment')
}
if (!anonKey) {
  throw new Error('SUPABASE_ANON_KEY must be set in environment')
}

/**
 * Admin client — service_role key.
 * Bypasses Row Level Security. Use for data mutations, admin ops, getUser(token).
 * Never expose this key to the browser.
 */
export const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

/**
 * Auth client — anon key.
 * Used for signInWithPassword only. Properly validates user credentials.
 */
export const supabaseAuth = createClient(url, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})
