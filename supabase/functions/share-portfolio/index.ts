
declare const Deno: {
  env: {
    get(name: string): string | undefined
  }
  serve(handler: (request: Request) => Response | Promise<Response>): void
}

import { createClient } from 'npm:@supabase/supabase-js@2'
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function jsonResponse(
  body: Record<string, unknown>,
  status = 200,
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  })
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405)
  }

  const authorization = request.headers.get('Authorization')
  const accessToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]

  if (!accessToken) {
    return jsonResponse({
      error: 'A valid sign-in session is required.',
    }, 401)
  }

  let body: {
    recipientEmail?: unknown
    portfolioUrl?: unknown
  }

  try {
    body = await request.json()
  } catch {
    return jsonResponse({
      error: 'Request body must be valid JSON.',
    }, 400)
  }

  const { recipientEmail, portfolioUrl } = body

  if (
    typeof recipientEmail !== 'string' ||
    !/^[^\s@]+@gmail\.com$/i.test(recipientEmail.trim())
  ) {
    return jsonResponse({
      error: 'Enter a valid Gmail address.',
    }, 400)
  }

  if (
    typeof portfolioUrl !== 'string' ||
    portfolioUrl.length > 4000
  ) {
    return jsonResponse({
      error: 'The portfolio link is invalid.',
    }, 400)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const resendApiKey = Deno.env.get('RESEND_API_KEY')
  const senderEmail = Deno.env.get('SHARE_EMAIL_FROM')

  if (
    !supabaseUrl ||
    !supabaseAnonKey ||
    !resendApiKey ||
    !senderEmail
  ) {
    console.error('Portfolio sharing email configuration is incomplete.')

    return jsonResponse({
      error: 'Portfolio email delivery is not configured yet.',
    }, 503)
  }

  const supabase = createClient(
    supabaseUrl,
    supabaseAnonKey,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
      global: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    },
  )

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser(accessToken)

  if (userError || !user) {
    return jsonResponse({
      error: 'Your sign-in session is invalid or expired. Please sign in again.',
    }, 401)
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (profileError || profile?.role !== 'student') {
    return jsonResponse({
      error: 'Portfolio sharing is available to student accounts only.',
    }, 403)
  }

  let shareUrl: URL

  try {
    shareUrl = new URL(portfolioUrl)
  } catch {
    return jsonResponse({
      error: 'The portfolio link is invalid.',
    }, 400)
  }

  let projectUrl: URL

  try {
    projectUrl = new URL(supabaseUrl)
  } catch {
    return jsonResponse({
      error: 'Server configuration is invalid.',
    }, 500)
  }

  const expectedPath =
    `/storage/v1/object/sign/portfolio-files/${user.id}/shares/`

  if (
    shareUrl.origin !== projectUrl.origin ||
    !shareUrl.pathname.startsWith(expectedPath) ||
    !shareUrl.searchParams.has('token')
  ) {
    return jsonResponse({
      error: 'The portfolio link does not belong to your account.',
    }, 403)
  }

  const safeUrl = shareUrl.toString()

  const escapedUrl = safeUrl
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')

  let providerResponse: Response

  try {
    providerResponse = await fetch(
      'https://api.resend.com/emails',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: senderEmail,
          to: [recipientEmail.trim()],
          subject: 'A Work Immersion portfolio was shared with you',
          html: `
            <p>A student shared their Work Immersion portfolio with you.</p>
            <p>
              <a href="${escapedUrl}">
                Open the complete portfolio PDF
              </a>
            </p>
            <p>This link expires in 7 days.</p>
          `,
          text: `A student shared their Work Immersion portfolio with you.

Open the complete portfolio PDF: ${safeUrl}

This link expires in 7 days.`,
        }),
      },
    )
  } catch (error) {
    console.error('Portfolio email provider frequest ailed:', error)

    return jsonResponse({
      error: 'Could not connect to the email provider. Please try again.',
    }, 502)
  }

  if (!providerResponse.ok) {
    console.error(
      'Portfolio email provider returned an error:',
      providerResponse.status,
    )

    return jsonResponse({
      error: 'The email provider could not send the portfolio link.',
    }, 502)
  }

  return jsonResponse({ sent: true })
})
