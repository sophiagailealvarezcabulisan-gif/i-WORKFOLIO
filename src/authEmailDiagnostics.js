function getErrorDetails(error) {
  if (!error) return null

  return {
    name: error.name,
    message: error.message,
    status: error.status,
    statusCode: error.statusCode,
    code: error.code,
    details: error.details,
    hint: error.hint,
  }
}

export function logAuthResponse(operation, response) {
  const { data, error } = response || {}
  const user = data?.user
  const session = data?.session

  console.info(`[Supabase Auth] ${operation} response`, {
    data: data
      ? {
          ...data,
          user: user
            ? {
                present: true,
                confirmed: Boolean(user.email_confirmed_at || user.confirmed_at),
                email_confirmed_at: user.email_confirmed_at || null,
                confirmed_at: user.confirmed_at || null,
                created_at: user.created_at || null,
              }
            : null,
          session: session
            ? {
                present: true,
                expires_at: session.expires_at || null,
                token_type: session.token_type || null,
                credentials: '[REDACTED]',
              }
            : null,
        }
      : data,
    error: getErrorDetails(error),
  })
}

export function formatEmailAuthError(error, action = 'send the verification email') {
  const message = error?.message || 'Supabase returned an unspecified authentication error.'
  const errorCode = String(error?.code || '').toLowerCase()
  const diagnostic = `${errorCode} ${message}`.toLowerCase()
  let guidance = ''

  if (
    diagnostic.includes('email_address_not_authorized') ||
    /email.{0,40}not authorized|not authorized.{0,40}email/.test(diagnostic)
  ) {
    guidance = 'Supabase did not authorize this recipient. The built-in SMTP service is restricted; configure a custom SMTP provider in Supabase Authentication settings.'
  } else if (
    /rate.?limit|too many requests|over_email_send_rate_limit|over_request_rate_limit/.test(diagnostic)
  ) {
    guidance = 'The email sending rate limit was reached. Wait before retrying, or review the email rate limits for your Supabase project.'
  } else if (
    /invalid.{0,30}(email|smtp|sender)|(?:email|smtp|sender).{0,30}(invalid|misconfigured|configuration)|missing.{0,30}(smtp|sender)/.test(diagnostic)
  ) {
    guidance = 'The email sender configuration is invalid or incomplete. Review the SMTP host, port, credentials, sender address, and verified sender domain in Supabase.'
  } else if (/smtp|email.{0,30}(send|deliver)|send.{0,30}email/.test(diagnostic)) {
    guidance = 'Supabase reported an SMTP delivery problem. Check the SMTP provider settings and delivery logs in Supabase and with your mail provider.'
  }

  return [
    `Supabase could not ${action}: ${message}`,
    error?.code ? `Code: ${error.code}.` : '',
    error?.status ? `Status: ${error.status}.` : '',
    guidance,
  ].filter(Boolean).join(' ')
}
