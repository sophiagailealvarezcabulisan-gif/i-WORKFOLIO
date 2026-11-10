import { useEffect, useState } from 'react'
import { supabase } from './supabaseClient'
import { formatEmailAuthError, logAuthResponse } from './authEmailDiagnostics'

const RESEND_SECONDS = 60

function SignUp({ onBack, onLogin, onVerificationRequired }) {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [strand, setStrand] = useState('')
  const [gradeLevel, setGradeLevel] = useState('')

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [resending, setResending] = useState(false)
  const [secondsRemaining, setSecondsRemaining] = useState(0)
  const [verificationPending, setVerificationPending] = useState(false)

  useEffect(() => {
    if (secondsRemaining <= 0) return undefined

    const timer = window.setTimeout(() => {
      setSecondsRemaining((seconds) => seconds - 1)
    }, 1000)

    return () => window.clearTimeout(timer)
  }, [secondsRemaining])

  const handleSignUp = async (e) => {
  e.preventDefault()

  setError('')
  setSuccess('')

  if (password !== confirmPassword) {
    setError('Passwords do not match.')
    return
  }

  if (password.length < 6) {
    setError('Password must be at least 6 characters.')
    return
  }

  if (!['TVL', 'ACADEMIC'].includes(strand)) {
    setError('Please select your strand.')
    return
  }

  if (!gradeLevel.trim()) {
    setError('Please enter your grade level.')
    return
  }

  setLoading(true)
  const normalizedEmail = email.trim().toLowerCase()

  try {
    const response = await supabase.auth.signUp({
      email: normalizedEmail,
      password,
      options: {
        emailRedirectTo: window.location.origin,
        data: {
          full_name: fullName.trim(),
          strand,
          grade: gradeLevel.trim(),
        },
      },
    })
    logAuthResponse('signUp', response)
    const { data, error } = response

    if (error) {
      setError(formatEmailAuthError(error))
      return
    }

    if (!data.user) {
      setError('Supabase returned no user for the registration request. No verification page was opened.')
      return
    }

    // Create student profile
    const { error: profileError } = await supabase
      .from('profiles')
      .insert({
        id: data.user.id,
        full_name: fullName.trim(),
        email: normalizedEmail,
        role: 'student',
        strand,
        grade: gradeLevel.trim(),
      })

    if (profileError) {
      console.error('Profile creation error:', profileError)
      setError(profileError.message)
      return
    }

    const verified = Boolean(data.user.email_confirmed_at || data.user.confirmed_at)
    setSuccess(verified
      ? 'Account created successfully!'
      : 'Supabase accepted the signup request. Check your inbox and spam folder for the 6-digit code. If it does not arrive, use Resend confirmation email or check the Supabase email delivery logs.')

    if (verified) {
      window.setTimeout(() => onLogin(data.user), 700)
    } else if (typeof onVerificationRequired === 'function') {
      setVerificationPending(true)
      setSecondsRemaining(RESEND_SECONDS)
      window.setTimeout(() => onVerificationRequired(normalizedEmail), 700)
    }
  } catch (err) {
    console.error('Signup error:', err)
    setError(formatEmailAuthError(err, 'complete signup'))
  } finally {
    setLoading(false)
  }
}

  const handleResendConfirmation = async () => {
    setError('')
    setSuccess('')

    if (!email.trim()) {
      setError('Please enter your email first.')
      return
    }

    setResending(true)
    try {
      const response = await supabase.auth.resend({
        type: 'signup',
        email: email.trim().toLowerCase(),
      })
      logAuthResponse('signup email resend', response)
      const { error } = response

      if (error) {
        setError(formatEmailAuthError(error))
        if (String(error.message || '').toLowerCase().includes('rate limit')) {
          setSecondsRemaining(RESEND_SECONDS)
        }
        return
      }

      setSecondsRemaining(RESEND_SECONDS)
      setSuccess('A new verification email was requested. Check your inbox and spam folder.')
    } catch (err) {
      console.error('Signup verification resend failed:', err)
      setError(formatEmailAuthError(err, 'resend the verification email'))
    } finally {
      setResending(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">

        <button
          className="back-btn"
          type="button"
          onClick={onBack}
        >
          ← Back
        </button>

        <div className="brand login-brand">
          <div className="brand-icon">i</div>
          <span>i-WORKFOLIO</span>
        </div>

        <h1>Create an account</h1>

        <p className="login-subtitle">
          Create your i-WORKFOLIO account
        </p>

        <form
          className="login-form"
          onSubmit={handleSignUp}
        >

          <label htmlFor="signup-name">
            Full Name
          </label>

          <input
            id="signup-name"
            type="text"
            placeholder="Enter your full name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
          />

          <label htmlFor="signup-email">
            Email
          </label>

          <input
            id="signup-email"
            type="email"
            placeholder="Enter your email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />

          <label htmlFor="signup-grade">
            Grade Level
          </label>

          <input
            id="signup-grade"
            type="text"
            placeholder="Enter your grade level"
            value={gradeLevel}
            onChange={(e) => setGradeLevel(e.target.value)}
            required
          />

          <label htmlFor="signup-strand">
            Strand
          </label>

          <select
            id="signup-strand"
            value={strand}
            onChange={(e) => setStrand(e.target.value)}
            required
          >
            <option value="" disabled>
              Select your strand
            </option>
            <option value="TVL">
              TVL (Technical-Vocational-Livelihood)
            </option>
            <option value="ACADEMIC">
              ACADEMIC
            </option>
          </select>

          <label htmlFor="signup-password">
            Password
          </label>

          <input
            id="signup-password"
            type="password"
            placeholder="Create a password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />

          <label htmlFor="signup-confirm-password">
            Confirm Password
          </label>

          <input
            id="signup-confirm-password"
            type="password"
            placeholder="Confirm your password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
          />

          {error && (
            <p className="login-error">
              {error}
            </p>
          )}

          {success && (
            <p className="login-success">
              {success}
            </p>
          )}

          <button
            type="submit"
            className="primary-btn full-btn"
            disabled={loading}
          >
            {loading
              ? 'Creating Account...'
              : 'Create Account'}
          </button>

        </form>

        <button
          type="button"
          className="link-btn"
          onClick={handleResendConfirmation}
          disabled={!verificationPending || resending || secondsRemaining > 0}
        >
          {resending
            ? 'Sending...'
            : secondsRemaining > 0
              ? `Resend confirmation email (${secondsRemaining}s)`
              : 'Resend confirmation email'}
        </button>

        <p className="signup-text">
          Already have an account?{' '}

          <button
            type="button"
            className="link-btn"
            onClick={onLogin}
          >
            Log in
          </button>
        </p>

      </div>
    </div>
  )
}

export default SignUp