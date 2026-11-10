import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim()
const supabaseKey =
  import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ||
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()

if (!supabaseUrl) {
  throw new Error(
    'Missing VITE_SUPABASE_URL. Set this environment variable in Vercel and redeploy.'
  )
}

let parsedSupabaseUrl
try {
  parsedSupabaseUrl = new URL(supabaseUrl)
} catch {
  throw new Error(
    'Invalid VITE_SUPABASE_URL. It must be a valid HTTP or HTTPS URL.'
  )
}

if (parsedSupabaseUrl.protocol !== 'http:' && parsedSupabaseUrl.protocol !== 'https:') {
  throw new Error(
    'Invalid VITE_SUPABASE_URL. It must be a valid HTTP or HTTPS URL.'
  )
}

if (!supabaseKey) {
  throw new Error(
    'Missing VITE_SUPABASE_ANON_KEY. Set this environment variable in Vercel and redeploy.'
  )
}

export const supabase = createClient(supabaseUrl, supabaseKey)