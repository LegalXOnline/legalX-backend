import { createClient } from '@supabase/supabase-js'

const url        = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !serviceKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in environment')
}

/**
 * Admin client — service_role key.
 * Bypasses Row Level Security. Used for all server-side operations.
 * Never expose this key to the browser.
 */
export const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

/**
 * Alias for auth routes that previously used the anon client.
 * The service_role key fully supports signInWithPassword on the server.
 */
export const supabaseAuth = supabase
