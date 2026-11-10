declare const Deno: {
  env: { get(name: string): string | undefined }
  serve(handler: (request: Request) => Response | Promise<Response>): void
}

import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)

  const token = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!token) return json({ error: 'A valid sign-in session is required.' }, 401)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return json({ error: 'Account deletion is not configured on the server.' }, 503)
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
  const { data: authData, error: authError } = await userClient.auth.getUser(token)
  if (authError || !authData.user) {
    return json({ error: 'Your sign-in session is invalid or expired.' }, 401)
  }
  const user = authData.user

  let body: {
    action?: unknown
    requestId?: unknown
    email?: unknown
    otp?: unknown
  }
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Request body must be valid JSON.' }, 400)
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  if (body.action === 'prepare') {
    const { data, error } = await userClient.rpc('prepare_account_deletion')
    if (error) return json({ error: error.message }, 400)
    return json({ requestId: data })
  }

  if (body.action === 'verify-email') {
    if (
      typeof body.requestId !== 'string' ||
      typeof body.email !== 'string' ||
      typeof body.otp !== 'string' ||
      !/^\d{6}$/.test(body.otp)
    ) {
      return json({ error: 'A valid deletion request and verification code are required.' }, 400)
    }
    if (body.email.trim().toLowerCase() !== String(user.email || '').toLowerCase()) {
      return json({ error: 'The verification email does not match your account.' }, 403)
    }

    const verifyResponse = await fetch(`${supabaseUrl}/auth/v1/verify`, {
      method: 'POST',
      headers: { apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'email',
        email: user.email,
        token: body.otp,
      }),
    })
    const verifyData = await verifyResponse.json()
    if (!verifyResponse.ok || verifyData?.user?.id !== user.id) {
      const message = String(verifyData?.msg || verifyData?.error_description || 'The verification code is incorrect or invalid.')
      return json({ error: message }, 400)
    }

    const { error } = await userClient.rpc('mark_account_deletion_email_verified', {
      p_request_id: body.requestId,
    })
    if (error) return json({ error: error.message }, 400)
    return json({ verified: true })
  }

  if (body.action === 'delete') {
    if (typeof body.requestId !== 'string') {
      return json({ error: 'A valid deletion request is required.' }, 400)
    }

    const paths: string[] = []
    const collectPaths = async (prefix: string) => {
      const { data: entries, error } = await admin.storage
        .from('portfolio-files')
        .list(prefix, { limit: 1000, offset: 0, sortBy: { column: 'name', order: 'asc' } })
      if (error) throw error
      for (const entry of entries || []) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.id === null) {
          await collectPaths(path)
        } else {
          paths.push(path)
        }
      }
    }
    await collectPaths(user.id)
    if (paths.length > 0) {
      const { error: storageError } = await admin.storage
        .from('portfolio-files')
        .remove(paths)
      if (storageError) return json({ error: storageError.message }, 500)
    }

    const { error: cleanupError } = await admin.rpc('delete_account_data', {
      p_request_id: body.requestId,
      p_user_id: user.id,
    })
    if (cleanupError) return json({ error: cleanupError.message }, 400)

    const { error: deleteAuthError } = await admin.auth.admin.deleteUser(user.id)
    if (deleteAuthError) return json({ error: deleteAuthError.message }, 500)
    return json({ deleted: true })
  }

  return json({ error: 'Unknown account deletion action.' }, 400)
})
