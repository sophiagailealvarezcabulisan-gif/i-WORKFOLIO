import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { formatEmailAuthError, logAuthResponse } from './authEmailDiagnostics'

const RESEND_SECONDS = 60

function EmailVerification({ email, onBack, onVerified }) {
  const normalizedEmail = email.trim().toLowerCase()
  const [otp, setOtp] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [loading, setLoading] = useState(false)
  const [resending, setResending] = useState(false)
  const [secondsRemaining, setSecondsRemaining] = useState(RESEND_SECONDS)

  useEffect(() => {
    if (secondsRemaining <= 0) return undefined

    const timer = window.setTimeout(() => {
      setSecondsRemaining((seconds) => seconds - 1)
    }, 1000)

    return () => window.clearTimeout(timer)
  }, [secondsRemaining])

  const handleVerify = async (event) => {
    event.preventDefault()
    setError('')
    setSuccess('')

    if (!/^\d{6}$/.test(otp)) {
      setError('Enter the 6-digit verification code.')
      return
    }

    setLoading(true)
    try {
      const { data, error: verificationError } = await supabase.auth.verifyOtp({
        email: normalizedEmail,
        token: otp,
        type: 'signup',
      })

      if (verificationError) {
        const message = verificationError.message.toLowerCase()
        if (message.includes('expired')) {
          setError('This verification code has expired. Request a new code.')
        } else if (message.includes('token') || message.includes('code')) {
          setError('The verification code is incorrect or invalid.')
        } else {
          setError(verificationError.message)
        }
        return
      }

      if (!data.user) {
        setError('Unable to verify this account. Please try again.')
        return
      }

      setSuccess('Email verified successfully.')
      window.setTimeout(() => onVerified(data.user), 700)
    } catch (verificationException) {
      console.error('Email verification failed:', verificationException)
      setError('Unable to verify your email. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const handleResend = async () => {
    if (secondsRemaining > 0) return

    setError('')
    setSuccess('')
    setResending(true)
    try {
      const response = await supabase.auth.resend({
        type: 'signup',
        email: normalizedEmail,
      })
      logAuthResponse('verification email resend', response)
      const { error: resendError } = response

      if (resendError) {
        setError(formatEmailAuthError(resendError, 'resend the verification email'))
        if (String(resendError.message || '').toLowerCase().includes('rate limit')) {
          setSecondsRemaining(RESEND_SECONDS)
        }
        return
      }

      setOtp('')
      setSecondsRemaining(RESEND_SECONDS)
      setSuccess('Supabase accepted the resend request. Check your inbox and spam folder.')
    } catch (resendException) {
      console.error('Verification code resend failed:', resendException)
      setError(formatEmailAuthError(resendException, 'resend the verification email'))
    } finally {
      setResending(false)
    }
  }

  return (
    <div className="login-page email-verification-page">
      <div className="login-card">
        <button className="back-btn" type="button" onClick={onBack}>
          ← Back
        </button>

        <div className="brand login-brand">
          <div className="brand-icon">i</div>
          <span>i-WORKFOLIO</span>
        </div>

        <h1>Verify Your Email</h1>
        <p className="login-subtitle">
          Enter the 6-digit verification code sent to
        </p>
        <strong className="verification-email">{email}</strong>

        <form className="login-form verification-form" onSubmit={handleVerify}>
          <label htmlFor="verification-code">Verification Code</label>
          <input
            id="verification-code"
            className="verification-code-input"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="000000"
            value={otp}
            onChange={(event) => {
              setOtp(event.target.value.replace(/\D/g, '').slice(0, 6))
              setError('')
            }}
            required
          />

          {error && <p className="login-error" role="alert">{error}</p>}
          {success && <p className="login-success" role="status">{success}</p>}

          <button type="submit" className="primary-btn full-btn" disabled={loading}>
            {loading ? 'Verifying...' : 'Verify Email'}
          </button>
        </form>

        <div className="verification-resend">
          <button
            type="button"
            className="link-btn"
            onClick={handleResend}
            disabled={secondsRemaining > 0 || resending}
          >
            Resend Code
          </button>
          <span role="status">
            {secondsRemaining > 0
              ? `Available in ${secondsRemaining}s`
              : 'You can request another code.'}
          </span>
        </div>
      </div>
    </div>
  )
}

export default EmailVerification
