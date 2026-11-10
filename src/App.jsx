import html2pdf from 'html2pdf.js';
import { downloadPortfolioPDF } from './downloadPortfolioPDF'
import { useState, useEffect, useRef } from 'react'
import { supabase } from './supabaseClient'
import { formatEmailAuthError, logAuthResponse } from './authEmailDiagnostics'
import {
  addPendingSync,
  saveOfflineData,
  getOfflineData,
  getPendingSync,
  getPortfolioCache,
  getPortfolioEntriesCache,
  getPortfolioPhotos,
  getPortfolioPhoto,
  loadPortfolioEntry,
  portfolioCacheKey,
  deletePortfolioPhoto,
  removePendingSync,
  savePortfolioEntry,
  savePortfolioPhoto,
  savePortfolioCache,
  syncPendingPortfolioEntry,
} from './offlineStorage'
import SignUp from './SignUp'
import EmailVerification from './EmailVerification'
import {
  GraduationCap,
  School,
  Home,
  FolderOpen,
  BookOpen,
  TrendingUp,
  MessageSquare,
  Trophy,
  Bell,
  Clock3,
  User,
  Settings,
  HelpCircle,
  LogOut,
  Download,
  Send,
  ArrowLeft,
  Users,
  UserPlus,
  FileCheck,
  ChartNoAxesCombined,
  Copy,
  ExternalLink,
  Plus,
  Search,
  CalendarDays,
  CheckCircle2,
  Clock,
  Trash2,
  Menu,
  X,
} from 'lucide-react'

export function getPortfolioFormat(strand) {
  const normalizedStrand = String(strand || '').trim().toUpperCase()

  if (normalizedStrand === 'TVL') {
    return {
      format: 'TVL portfolio',
      requirements: 'Technical-vocational work immersion requirements',
    }
  }

  if (normalizedStrand === 'ACADEMIC') {
    return {
      format: 'Academic portfolio',
      requirements: 'Academic work immersion requirements',
    }
  }

  return null
}

function isAcademicStrand(strand) {
  return String(strand || '').trim().toUpperCase() === 'ACADEMIC'
}

async function loadStudentProfile(userId) {
  const cacheKey = `profile:${userId}`
  const cached = await getOfflineData(cacheKey)
  if (!navigator.onLine) return cached

  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle()

  if (error) {
    if (cached) return cached
    throw error
  }

  if (data) await saveOfflineData(cacheKey, data)
  return data || cached
}

async function resolvePortfolioPhotoUrl(userId, path) {
  if (!userId || !path) return ''

  const cachedPhoto = await getPortfolioPhoto(userId, path)
  if (cachedPhoto?.blob) return URL.createObjectURL(cachedPhoto.blob)
  if (!navigator.onLine) return ''

  const { data, error } = await supabase.storage
    .from('portfolio-files')
    .createSignedUrl(path, 3600)
  if (error) throw error

  const response = await fetch(data.signedUrl)
  if (!response.ok) throw new Error('Could not download the portfolio photo for offline use.')
  const blob = await response.blob()
  try {
    await savePortfolioPhoto(userId, path, blob, { pendingUpload: false })
  } catch (error) {
    console.error('Could not cache the portfolio photo on this device:', error)
    return data.signedUrl
  }
  window.dispatchEvent(new Event('portfolio-photos-updated'))
  return URL.createObjectURL(blob)
}

async function getPortfolioSignedUrl(userId, path) {
  try {
    return {
      data: { signedUrl: await resolvePortfolioPhotoUrl(userId, path) },
      error: null,
    }
  } catch (error) {
    return { data: null, error }
  }
}

function portfolioContentReferencesPath(content, path) {
  if (content === path) return true
  if (typeof content === 'string') {
    try {
      return portfolioContentReferencesPath(JSON.parse(content), path)
    } catch {
      return false
    }
  }
  if (Array.isArray(content)) {
    return content.some((value) => portfolioContentReferencesPath(value, path))
  }
  if (content && typeof content === 'object') {
    return Object.values(content).some((value) => portfolioContentReferencesPath(value, path))
  }
  return false
}

import './App.css'

function App() {
  const [user, setUser] = useState(null)
  const [page, setPage] = useState('home')
  const [mode, setMode] = useState('student')
  const [authLoading, setAuthLoading] = useState(true)
  const passwordRecoveryActive = useRef(false)
  const [isOffline, setIsOffline] = useState(!navigator.onLine)
  const [syncState, setSyncState] = useState('idle')
  const [syncError, setSyncError] = useState('')
  const [pendingCount, setPendingCount] = useState(0)
  const [verificationEmail, setVerificationEmail] = useState('')
  const syncInProgress = useRef(false)
  const [offlinePhotos, setOfflinePhotos] = useState([])
  const [showOfflinePhotos, setShowOfflinePhotos] = useState(false)
  const [offlinePhotoError, setOfflinePhotoError] = useState('')

  const isEmailVerified = (authUser) =>
    Boolean(authUser?.email_confirmed_at || authUser?.confirmed_at)

  const refreshPendingCount = async (userId = user?.id) => {
    const count = userId ? (await getPendingSync(userId)).length : 0
    setPendingCount(count)
    return count
  }

  const refreshOfflinePhotos = async (userId = user?.id) => {
    try {
      setOfflinePhotos(userId ? await getPortfolioPhotos(userId) : [])
      setOfflinePhotoError('')
    } catch (error) {
      console.error('Load saved offline photos failed:', error)
      setOfflinePhotoError(error?.message || 'Could not load photos saved on this device.')
    }
  }

  const handleRemoveOfflinePhoto = async (path) => {
    try {
      await deletePortfolioPhoto(user.id, path)
      setOfflinePhotoError('')
      await refreshOfflinePhotos(user.id)
    } catch (error) {
      console.error('Remove offline portfolio photo failed:', error)
      setOfflinePhotoError(error?.message || 'Could not remove the offline photo.')
    }
  }

  const syncPendingChanges = async () => {
    if (!user?.id || !navigator.onLine || syncInProgress.current) return
    syncInProgress.current = true
    setSyncState('syncing')
    let hasConflict = false

    try {
      const queue = await getPendingSync(user.id)
      if (queue.length === 0) {
        setSyncState('idle')
        setSyncError('')
        await refreshPendingCount(user.id)
        return
      }

      for (const item of queue) {
        if (item.status === 'conflict') {
          hasConflict = true
          continue
        }

        try {
          if (item.type === 'portfolio-upsert' && item.row) {
            await syncPendingPortfolioEntry(supabase, item)
            await removePendingSync(item.localId, item.row.updated_at)
            const remainingItems = await getPendingSync(user.id)
            for (const uploadItem of remainingItems) {
              if (
                uploadItem.type === 'storage-upload' &&
                uploadItem.status === 'uploaded' &&
                portfolioContentReferencesPath(item.row.content, uploadItem.path)
              ) {
                await removePendingSync(uploadItem.localId)
              }
            }
          } else if (item.type === 'storage-upload' && item.file) {
            if (
              item.userId !== user.id ||
              item.bucket !== 'portfolio-files' ||
              !item.path?.startsWith(`${user.id}/`)
            ) {
              throw new Error('A queued upload does not belong to the authenticated student.')
            }
            const upload = await supabase.storage
              .from(item.bucket)
              .upload(item.path, item.file, {
                upsert: true,
                contentType: item.file.type,
              })
            if (upload.error) throw upload.error
              const { data: entries, error } = await supabase
                .from('portfolio_entries')
                .select('content')
                .eq('user_id', user.id)
              if (error) throw error
              const referenced = (entries || []).some((entry) => (
                portfolioContentReferencesPath(entry.content, item.path)
              ))
              if (referenced) {
                await removePendingSync(item.localId)
              } else {
                await addPendingSync({ ...item, status: 'uploaded' })
              }
          } else {
            console.error('Skipping unsupported offline change:', item.type)
            setSyncError(`Unsupported saved change type: ${item.type}`)
          }
        } catch (error) {
          if (error?.code === 'PORTFOLIO_CONFLICT') {
            hasConflict = true
            setSyncError(error.message)
            await addPendingSync({
              ...item,
              status: 'conflict',
              conflictAt: new Date().toISOString(),
            })
          } else {
            console.error('Offline sync item failed; it remains queued:', error)
            setSyncError(error?.message || 'A saved change could not be synchronized yet.')
          }
        }
      }

      const remaining = await refreshPendingCount(user.id)
      setSyncState(hasConflict
        ? 'conflict'
        : remaining > 0
          ? 'waiting'
          : 'synced')
      if (!hasConflict && remaining === 0) {
        setSyncError('')
        window.setTimeout(() => setSyncState((state) => (
          state === 'synced' ? 'idle' : state
        )), 3500)
      }
    } catch (error) {
      console.error('Offline sync failed:', error)
      setSyncError(error?.message || 'A saved change could not be synchronized yet.')
      await refreshPendingCount(user.id)
      setSyncState('waiting')
    } finally {
      syncInProgress.current = false
    }
  }

  useEffect(() => {
    const goOnline = () => {
      setIsOffline(false)
      syncPendingChanges()
    }
    const goOffline = () => {
      setIsOffline(true)
    }

    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    const requestSync = (event) => {
      refreshPendingCount().catch((error) => {
        console.error('Refresh pending offline changes failed:', error)
        setSyncError(error?.message || 'Could not check saved changes.')
      })
      refreshOfflinePhotos()
      if (event.detail?.synced) {
        setSyncError('')
        setSyncState('synced')
        window.setTimeout(() => setSyncState((state) => (
          state === 'synced' ? 'idle' : state
        )), 3500)
        return
      }
      if (navigator.onLine) syncPendingChanges()
    }
    const refreshPhotos = () => refreshOfflinePhotos()
    const retrySync = window.setInterval(() => {
      if (navigator.onLine) syncPendingChanges()
    }, 30000)
    window.addEventListener('portfolio-sync-needed', requestSync)
    window.addEventListener('portfolio-photos-updated', refreshPhotos)
    const refreshTimer = window.setTimeout(() => {
      refreshPendingCount().catch((error) => {
        console.error('Refresh pending offline changes failed:', error)
        setSyncError(error?.message || 'Could not check saved changes.')
      })
      refreshOfflinePhotos()
    }, 0)
    if (navigator.onLine) syncPendingChanges()

    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
      window.removeEventListener('portfolio-sync-needed', requestSync)
      window.removeEventListener('portfolio-photos-updated', refreshPhotos)
      window.clearTimeout(refreshTimer)
      window.clearInterval(retrySync)
    }
  }, [user?.id])

  useEffect(() => {
    const loadSession = async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession()

        if (session?.user) {
        const recoveryRequested = new URLSearchParams(window.location.hash.slice(1)).get('type') === 'recovery'
        if (recoveryRequested) {
          passwordRecoveryActive.current = true
          setUser(session.user)
          setPage('password-recovery')
          setAuthLoading(false)
          return
        }

        if (!isEmailVerified(session.user)) {
          setUser(session.user)
          setVerificationEmail(session.user.email || '')
          setPage('email-verification')
          setAuthLoading(false)
          return
        }

        const profile = await loadStudentProfile(session.user.id)

        setUser({
          ...session.user,
          ...profile,
        })

        document.documentElement.classList.toggle(
          'dark-mode',
          profile?.dark_mode === true
        )

        if (profile?.role === 'teacher') {
          setPage('teacher')
        } else {
          setPage('student')
        }
        }
      } catch (error) {
        console.error('Load saved session failed:', error)
      } finally {
        setAuthLoading(false)
      }
    }

    loadSession()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (!session?.user) {
          if (passwordRecoveryActive.current) {
            setAuthLoading(false)
            return
          }
          setUser(null)
          setPage('home')
          setAuthLoading(false)
          return
        }

        if (event === 'PASSWORD_RECOVERY') {
          passwordRecoveryActive.current = true
        }

        if (passwordRecoveryActive.current) {
          setUser(session.user)
          setPage('password-recovery')
          setAuthLoading(false)
          return
        }

        if (!isEmailVerified(session.user)) {
          setUser(session.user)
          setVerificationEmail(session.user.email || '')
          setPage('email-verification')
          setAuthLoading(false)
          return
        }

        let profile
        try {
          profile = await loadStudentProfile(session.user.id)
        } catch (error) {
          console.error('Load profile after authentication failed:', error)
          setAuthLoading(false)
          return
        }

        const completeUser = {
          ...session.user,
          ...profile,
        }

        setUser(completeUser)

        document.documentElement.classList.toggle(
          'dark-mode',
          profile?.dark_mode === true
        )

        if (completeUser?.role === 'teacher') {
          setPage('teacher')
        } else {
          setPage('student')
        }

        setAuthLoading(false)
      }
    )

    return () => {
      subscription.unsubscribe()
    }
  }, [])

  const handleLogin = async (loggedInUser) => {
  if (!loggedInUser) return

  if (!isEmailVerified(loggedInUser)) {
    setUser(loggedInUser)
    setVerificationEmail(loggedInUser.email || '')
    setPage('email-verification')
    return
  }

  let profile
  try {
    profile = await loadStudentProfile(loggedInUser.id)
    if (!profile) throw new Error('No saved profile is available for this account.')
  } catch (error) {
    console.error('LOGIN PROFILE ERROR:', error)
    alert('Cannot load profile: ' + error.message)
    return
  }

  const completeUser = {
    ...loggedInUser,
    ...profile,
  }

  console.log('PROFILE ROLE:', profile.role)

  setUser(completeUser)

  if (profile.role === 'teacher') {
    setPage('teacher')
  } else {
    setPage('student')
  }
}

  const handleLogout = async () => {
    await supabase.auth.signOut()

    document.documentElement.classList.remove('dark-mode')
    setUser(null)
    setPage('home')
  }

  const handlePasswordRecoveryComplete = async () => {
    passwordRecoveryActive.current = false
    window.history.replaceState(
      {},
      document.title,
      `${window.location.pathname}${window.location.search}`
    )
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user?.id)
      .single()
    if (error) {
      console.error('Load profile after password recovery failed:', error)
      setUser(null)
      setPage('login')
      return
    }
    const completeUser = { ...user, ...profile }
    setUser(completeUser)
    setPage(completeUser?.role === 'teacher' ? 'teacher' : 'student')
  }

  if (authLoading) {
    return (
      <div className="auth-loading">
        Loading i-WORKFOLIO...
      </div>
    )
  }

  if (page === 'password-recovery') {
    return (
      <PasswordRecoveryPage
        onComplete={handlePasswordRecoveryComplete}
      />
    )
  }

  if (page === 'login') {
    return (
      <LoginPage
        mode={mode}
        setMode={setMode}
        onBack={() => setPage('home')}
        onLogin={handleLogin}
        onVerificationRequired={(email) => {
          setVerificationEmail(email)
          setPage('email-verification')
        }}
        onSignUp={() => setPage('signup')}
      />
    )
  }

  if (page === 'signup') {
    return (
      <SignUp
        onBack={() => setPage('login')}
        onLogin={handleLogin}
        onVerificationRequired={(email) => {
          setVerificationEmail(email)
          setPage('email-verification')
        }}
      />
    )
  }

  if (page === 'email-verification') {
    return (
      <EmailVerification
        email={verificationEmail}
        onBack={() => setPage('login')}
        onVerified={handleLogin}
      />
    )
  }

  if (
    page === 'student' ||
    page === 'teacher'
  ) {
    return (
      <>
        {(isOffline || pendingCount > 0 || syncState !== 'idle') && (
          <div className={`offline-status-banner ${syncState === 'synced' ? 'is-synced' : ''}`} role="status">
            {isOffline
              ? pendingCount > 0
                ? 'Offline: No internet connection · Saved on this device · Waiting for synchronization'
                : 'Offline: No internet connection'
              : syncState === 'syncing'
                ? 'Waiting for synchronization'
                : syncState === 'conflict'
                  ? `Waiting for synchronization · ${syncError || 'Newer server changes found; your saved copy is kept'}`
                  : pendingCount > 0
                    ? syncError
                      ? `Waiting for synchronization · ${syncError}`
                      : 'Waiting for synchronization'
                    : syncState === 'synced'
                      ? 'Synced'
                      : 'Saved on this device'}
          </div>
        )}
        {page === 'student' && offlinePhotos.length > 0 && (
          <button
            type="button"
            className="offline-photo-manager-trigger"
            onClick={() => setShowOfflinePhotos(true)}
          >
            Manage saved photos
          </button>
        )}
        {showOfflinePhotos && (
          <div className="offline-photo-manager-backdrop" role="presentation">
            <section
              className="offline-photo-manager"
              role="dialog"
              aria-modal="true"
              aria-labelledby="offline-photo-manager-title"
            >
              <button
                type="button"
                className="offline-photo-manager-close"
                onClick={() => setShowOfflinePhotos(false)}
                aria-label="Close saved photos"
              >
                <X size={18} />
              </button>
              <h2 id="offline-photo-manager-title">Photos saved on this device</h2>
              <p>Remove an offline copy without deleting its photo from your Supabase portfolio.</p>
              {offlinePhotoError && <p role="alert">{offlinePhotoError}</p>}
              <ul>
                {offlinePhotos.map((photo) => (
                  <li key={photo.path}>
                    <span>{photo.name}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveOfflinePhoto(photo.path)}
                    >
                      Remove offline copy
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}
        <Dashboard
          type={
            page === 'student'
              ? 'Student'
              : 'Teacher'
          }
          user={user}
          onLogout={handleLogout}
        />
      </>
    )
  }

  return (
    <LandingPage
      onLogin={() => setPage('login')}
    />
  )
}

/* =========================
   LANDING PAGE
========================= */

function LandingPage({ onLogin }) {
  return (
    <div className="landing-page">

      <header className="landing-header">

        <div className="brand">
          <div className="brand-icon">i</div>
          <span>i-WORKFOLIO</span>
        </div>

        <button
          className="primary-btn"
          onClick={onLogin}
        >
          Log In
        </button>

      </header>

      <main className="landing-content">

        <div className="landing-icon">
          <GraduationCap size={42} />
        </div>

        <p className="eyebrow">
          YOUR WORK IMMERSION JOURNEY
        </p>

        <h1>
          Your achievements.
          <br />
          Your journey.
          <br />
          Your portfolio.
        </h1>

        <p className="landing-description">
          Keep your Work Immersion experiences,
          achievements, and requirements organized
          in one digital portfolio.
        </p>

        <button
          className="primary-btn landing-button"
          onClick={onLogin}
        >
          Get Started
        </button>

        <p className="landing-note">
          A digital e-portfolio for Grade 12
          Work Immersion students.
        </p>

      </main>

    </div>
  )
}

/* =========================
   LOGIN PAGE
========================= */

function LoginPage({
  mode,
  setMode,
  onBack,
  onLogin,
  onVerificationRequired,
  onSignUp,
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [resetMessage, setResetMessage] = useState('')
  const [loading, setLoading] = useState(false)

  const handleLogin = async (e) => {
    e.preventDefault()

    setError('')
    setResetMessage('')
    setLoading(true)

    try {
      const { data, error } =
        await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        })

      if (error) {
        if (
          error.code === 'email_not_confirmed' ||
          error.message?.toLowerCase().includes('email not confirmed')
        ) {
          const normalizedEmail = email.trim().toLowerCase()
          const response = await supabase.auth.resend({
            type: 'signup',
            email: normalizedEmail,
          })
          logAuthResponse('login verification email resend', response)
          const { error: resendError } = response

          if (resendError) {
            setError(`Your email is not verified. ${formatEmailAuthError(resendError, 'resend the verification email')}`)
            return
          }

          onVerificationRequired(normalizedEmail)
          return
        }

        setError(error.message)
        return
      }

      if (data.user) {
        await onLogin(data.user)
      }
    } catch (err) {
      console.error(err)
      setError(
        'Unable to log in. Please try again.'
      )
    } finally {
      setLoading(false)
    }
  }

  const handleForgotPassword = async () => {
    setError('')
    setResetMessage('')
    if (!email.trim()) {
      setError('Enter your teacher email address first.')
      return
    }

    setLoading(true)
    try {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(
        email.trim(),
        { redirectTo: window.location.origin }
      )
      if (resetError) throw resetError
      setResetMessage('If this email belongs to a teacher account, a password recovery link has been sent. Check your Gmail inbox and spam folder.')
    } catch (resetError) {
      console.error('Teacher password recovery email failed:', resetError)
      setError(resetError?.message || 'Could not send a password recovery email. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-page">

      <div className="login-card">

        <button
          className="back-btn"
          onClick={onBack}
          type="button"
        >
          <ArrowLeft size={17} />
          Back
        </button>

        <div className="brand login-brand">
          <div className="brand-icon">i</div>
          <span>i-WORKFOLIO</span>
        </div>

        <h1>
          {mode === 'student'
            ? 'Student Login'
            : 'Teacher Login'}
        </h1>

        <p className="login-subtitle">
          Log in to your {mode} account
        </p>

        <div className="mode-options">

          <button
            type="button"
            className={`mode-card ${
              mode === 'student'
                ? 'selected'
                : ''
            }`}
            onClick={() => {
              setMode('student')
              setError('')
            }}
          >
            <GraduationCap size={22} />

            <div>
              <strong>Student</strong>
              <span>Student dashboard</span>
            </div>
          </button>

          <button
            type="button"
            className={`mode-card ${
              mode === 'teacher'
                ? 'selected'
                : ''
            }`}
            onClick={() => {
              setMode('teacher')
              setError('')
            }}
          >
            <School size={22} />

            <div>
              <strong>Teacher</strong>
              <span>Teacher dashboard</span>
            </div>
          </button>

        </div>

        <div className="or-divider">
          <span>
            Sign in with your account
          </span>
        </div>

        <form
          className="login-form"
          onSubmit={handleLogin}
        >

          <label htmlFor="login-email">
            Email
          </label>

          <input
            id="login-email"
            type="email"
            placeholder="Enter your email"
            value={email}
            onChange={(e) =>
              setEmail(e.target.value)
            }
            required
          />

          <label htmlFor="login-password">
            Password
          </label>

          <input
            id="login-password"
            type="password"
            placeholder="Enter your password"
            value={password}
            onChange={(e) =>
              setPassword(e.target.value)
            }
            required
          />

          {error && (
            <p className="login-error">
              {error}
            </p>
          )}

          {mode === 'teacher' && (
            <button
              type="button"
              className="link-btn teacher-forgot-password"
              onClick={handleForgotPassword}
              disabled={loading}
            >
              Forgot your password? Send recovery email
            </button>
          )}

          {resetMessage && (
            <p className="password-recovery-success" role="status">
              {resetMessage}
            </p>
          )}

          <button
            type="submit"
            className="primary-btn full-btn"
            disabled={loading}
          >
            {loading
              ? 'Logging in...'
              : 'Log In'}
          </button>

        </form>

        <p className="login-footer">
          Use the email and password registered
          with your Supabase project.
        </p>

        <p className="signup-text">
          Don't have an account?{' '}

          <button
            type="button"
            className="link-btn"
            onClick={onSignUp}
          >
            Create an account
          </button>
        </p>

      </div>

    </div>
  )
}

function PasswordRecoveryPage({ onComplete }) {
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const handleSubmit = async (event) => {
    event.preventDefault()
    setErrorMessage('')

    if (password.length < 6) {
      setErrorMessage('Password must be at least 6 characters.')
      return
    }
    if (password !== confirmPassword) {
      setErrorMessage('Passwords do not match.')
      return
    }

    setSaving(true)
    try {
      const { error } = await supabase.auth.updateUser({ password })
      if (error) throw error
      setSaved(true)
      await onComplete()
    } catch (error) {
      console.error('Password recovery update failed:', error)
      setErrorMessage(error?.message || 'Could not update your password. Request a new recovery email and try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="brand login-brand">
          <div className="brand-icon">i</div>
          <span>i-WORKFOLIO</span>
        </div>
        <h1>Reset your password</h1>
        <p className="login-subtitle">
          Choose a new password for your account.
        </p>
        {saved ? (
          <p className="password-recovery-success" role="status">
            Password updated successfully.
          </p>
        ) : (
          <form className="login-form" onSubmit={handleSubmit}>
            <label htmlFor="recovery-password">New password</label>
            <input
              id="recovery-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
            <label htmlFor="recovery-confirm-password">Confirm new password</label>
            <input
              id="recovery-confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
            />
            {errorMessage && (
              <p className="login-error" role="alert">{errorMessage}</p>
            )}
            <button
              type="submit"
              className="primary-btn full-btn"
              disabled={saving}
            >
              {saving ? 'Updating password...' : 'Update Password'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

/* =========================
   DASHBOARD
========================= */

function Dashboard({
  type,
  user,
  onLogout,
}) {
  const isStudent = type === 'Student'

console.log('DASHBOARD TYPE:', type)
console.log('USER ROLE:', user?.role)

  const [activePage, setActivePage] =
    useState('Home')

  const [avatarUrl, setAvatarUrl] =
    useState(user?.avatar_url || '')

  const [profileName, setProfileName] =
    useState(user?.full_name || '')

  const [mobileProfileOpen, setMobileProfileOpen] =
    useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] =
    useState(false)
  const [unreadNotificationCount, setUnreadNotificationCount] = useState(0)
  const [selectedFeedbackId, setSelectedFeedbackId] = useState(null)

  useEffect(() => {
    if (!isStudent || !user?.id) {
      setUnreadNotificationCount(0)
      return undefined
    }

    let cancelled = false
    const refreshUnreadCount = async () => {
      const { count, error } = await supabase
        .from('student_notifications')
        .select('id', { count: 'exact', head: true })
        .eq('recipient_id', user.id)
        .eq('is_read', false)

      if (error) {
        console.error('Load unread student notification count failed:', error)
        return
      }
      if (!cancelled) setUnreadNotificationCount(count || 0)
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshUnreadCount()
    }
    const handleNotificationUpdate = () => refreshUnreadCount()

    refreshUnreadCount()
    const intervalId = window.setInterval(refreshUnreadCount, 30000)
    window.addEventListener('focus', refreshUnreadCount)
    window.addEventListener('student-notifications-updated', handleNotificationUpdate)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    const channel = supabase
      .channel(`student-notifications-count-${user.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'student_notifications',
          filter: `recipient_id=eq.${user.id}`,
        },
        refreshUnreadCount
      )
      .subscribe()

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
      window.removeEventListener('focus', refreshUnreadCount)
      window.removeEventListener('student-notifications-updated', handleNotificationUpdate)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      supabase.removeChannel(channel)
    }
  }, [isStudent, user?.id])

  useEffect(() => {
    const loadAvatar = async () => {
      if (!user?.id) return

      const { data, error } =
        await supabase
          .from('profiles')
          .select(
            'avatar_url, full_name'
          )
          .eq('id', user.id)
          .single()

      if (error) {
        console.error(
          'SIDEBAR PROFILE ERROR:',
          error
        )
        return
      }

      setAvatarUrl(
        data?.avatar_url || ''
      )

      setProfileName(
        data?.full_name || ''
      )
    }

    loadAvatar()
  }, [user?.id])

  const studentMenu = [
    ['Home', Home],
    ['My Portfolio', FolderOpen],
    ['Progress', TrendingUp],
    [
      'Teacher Feedback',
      MessageSquare,
    ],
    ['Notifications', Bell],
    [
      'My Work Immersion Class',
      GraduationCap,
    ],
    ['Help Center', HelpCircle],
    ['My Profile', User],
    ['Settings', Settings],
  ]

  const teacherMenu = [
    ['Home', Home],
    ['Students', GraduationCap],
    ['Monitoring', TrendingUp],
    ['Notifications', Bell],
    ['Settings', Settings],
  ]

  const menu = isStudent
    ? studentMenu
    : teacherMenu

  const emailName = user?.email
    ? user.email.split('@')[0]
    : type

  const handleAvatarChange = (
    newAvatar
  ) => {
    setAvatarUrl(newAvatar)
  }

  const handleNameChange = (
    newName
  ) => {
    setProfileName(newName)
  }

  return (
    <div className="dashboard">

      <header className="mobile-dashboard-header">
        {isStudent && (
          <button
            type="button"
            className="mobile-menu-btn"
            aria-label="Open navigation menu"
            aria-expanded={mobileMenuOpen}
            onClick={() =>
              setMobileMenuOpen(true)
            }
          >
            <Menu size={22} />
          </button>
        )}
        <div className="mobile-brand">
          <div className="brand-icon">i</div>
          <span>i-WORKFOLIO</span>
        </div>

        <div className="mobile-user-actions">
          <button
            type="button"
            className="mobile-profile-avatar"
            title={profileName || emailName}
            aria-label="Open profile menu"
            aria-expanded={mobileProfileOpen}
            onClick={() =>
              setMobileProfileOpen(
                (open) => !open
              )
            }
          >
            {avatarUrl ? (
              <img src={avatarUrl} alt="" />
            ) : (
              (
                profileName ||
                emailName
              )
                .charAt(0)
                .toUpperCase()
            )}
          </button>

          {mobileProfileOpen && (
            <div className="mobile-profile-popup">
              <strong>
                {profileName ||
                  emailName}
              </strong>
              <span>{type}</span>
              <button
                type="button"
                className="mobile-logout-btn"
                onClick={onLogout}
              >
                Log Out
              </button>
            </div>
          )}
        </div>
      </header>

      <button
        type="button"
        className={`sidebar-overlay${mobileMenuOpen ? ' overlay-visible' : ''}`}
        aria-label="Close navigation menu"
        onClick={() => setMobileMenuOpen(false)}
      />

      <aside className={`sidebar${mobileMenuOpen ? ' sidebar-open' : ''}`}>

        <div className="brand">
          <button
            type="button"
            className="sidebar-close"
            aria-label="Close navigation menu"
            onClick={() => setMobileMenuOpen(false)}
          >
            <X size={20} />
          </button>
          <div className="brand-icon">
            i
          </div>

          <span>
            i-WORKFOLIO
          </span>
        </div>

        <div className="sidebar-menu">

          {menu.map(
            ([name, Icon]) => (
              <button
                key={name}
                type="button"
                className={
                  activePage === name
                    ? 'active-menu'
                    : ''
                }
                data-mobile-nav={
                  isStudent &&
                    ['Progress', 'Teacher Feedback', 'Notifications', 'My Work Immersion Class', 'Help Center'].includes(name)
                    ? 'drawer'
                    : 'bottom'
                }
                onClick={() => {
                  if (name !== 'Teacher Feedback') setSelectedFeedbackId(null)
                  setActivePage(name)
                  setMobileMenuOpen(false)
                }}
              >
                <Icon size={18} />

                <span>
                  {name}
                </span>
                {isStudent && name === 'Notifications' && unreadNotificationCount > 0 && (
                  <span className="notification-count-badge" aria-label={`${unreadNotificationCount} unread`}>
                    {unreadNotificationCount > 99 ? '99+' : unreadNotificationCount}
                  </span>
                )}
              </button>
            )
          )}

        </div>

        <div className="sidebar-profile">

          <div className="sidebar-profile-circle">

            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt="Profile"
                className="sidebar-avatar-img"
              />
            ) : (
              (
                profileName ||
                emailName
              )
                .charAt(0)
                .toUpperCase()
            )}

          </div>

          <div className="sidebar-profile-info">

            <strong>
              {profileName ||
                emailName}
            </strong>

            <span>
              {type}
            </span>

          </div>

        </div>

        <button
          type="button"
          className="logout-btn"
          onClick={onLogout}
        >
          <LogOut size={17} />
          <span>Log Out</span>
        </button>

      </aside>

      <nav
        className="mobile-bottom-nav"
        aria-label="Dashboard navigation"
      >
        {(isStudent
          ? menu.filter(([name]) =>
              ['Home', 'My Portfolio', 'My Profile', 'Settings'].includes(name)
            )
          : menu).map(
          ([name, Icon]) => (
            <button
              key={name}
              type="button"
              className={
                activePage === name
                  ? 'active-menu'
                  : ''
              }
              onClick={() =>
                setActivePage(name)
              }
            >
              <Icon size={19} />
              <span>{name}</span>
            </button>
          )
        )}
      </nav>

      <main className="dashboard-main">

        {isStudent ? (
          <StudentContent
            activePage={activePage}
            user={user}
            selectedFeedbackId={selectedFeedbackId}
            onOpenFeedback={(feedbackId) => {
              setSelectedFeedbackId(feedbackId)
              setActivePage('Teacher Feedback')
            }}
            onClearSelectedFeedback={() => setSelectedFeedbackId(null)}
            setActivePage={
              setActivePage
            }
            onAvatarChange={
              handleAvatarChange
            }
            onNameChange={
              handleNameChange
            }
          />
        ) : (
          <TeacherContent
            activePage={activePage}
            user={user}
          />
        )}

      </main>

    </div>
  )
}

/* =========================
   STUDENT CONTENT
========================= */

function StudentContent({
  activePage,
  user,
  selectedFeedbackId,
  onOpenFeedback,
  onClearSelectedFeedback,
  setActivePage,
  onAvatarChange,
  onNameChange,
}) {
  const isAcademicStudent = isAcademicStrand(user?.strand)

  if (activePage === 'Home') {
    return (
      <StudentHome
        user={user}
        setActivePage={
          setActivePage
        }
      />
    )
  }

  if (
    activePage ===
    'My Portfolio'
  ) {
    if (isAcademicStudent) return null

    return (
      <PortfolioDocumentFrame>
        <MyPortfolio user={user} />
      </PortfolioDocumentFrame>
    )
  }

  if (
    activePage === 'Progress'
  ) {
    if (isAcademicStudent) {
      return <AcademicProgress />
    }

    return (
      <StudentProgress
        user={user}
      />
    )
  }

  if (
    activePage ===
    'Teacher Feedback'
  ) {
    return (
      <TeacherFeedback
        user={user}
        selectedFeedbackId={selectedFeedbackId}
        onClearSelectedFeedback={onClearSelectedFeedback}
      />
    )
  }

  if (
    activePage ===
    'My Work Immersion Class'
  ) {
    return (
      <WorkImmersionClass
        user={user}
      />
    )
  }

  if (
    activePage ===
    'Submission History'
  ) {
    return (
      <SubmissionHistory
        user={user}
      />
    )
  }

  if (
    activePage ===
    'Leaderboard'
  ) {
    return (
      <Leaderboard
        user={user}
      />
    )
  }

  if (
    activePage ===
    'Notifications'
  ) {
    return (
      <StudentNotifications
        user={user}
        onOpenFeedback={onOpenFeedback}
      />
    )
  }

  if (
    activePage ===
    'Help Center'
  ) {
    return (
      <HelpCenter
        user={user}
      />
    )
  }

  if (
    activePage ===
    'My Profile'
  ) {
    return (
      <MyProfile
        user={user}
        onAvatarChange={
          onAvatarChange
        }
        onNameChange={
          onNameChange
        }
      />
    )
  }

  if (
    activePage === 'Settings'
  ) {
    return (
      <SettingsPage
        user={user}
      />
    )
  }

  /*
    These pages are opened from
    the Portfolio Folders on Home.
  */

  if (activePage === 'Module Introduction') {
  return (
    <ModuleIntroduction
      user={user}
      setActivePage={setActivePage}
    />
  )
}

  if (
    activePage ===
    'Pre-Immersion'
  ) {
    return (
      <PreImmersion
        user={user}
        setActivePage={setActivePage}
      />
    )
  }

  if (
    activePage ===
    'Immersion Proper'
  ) {
    return (
      <ImmersionProper
        user={user}
        setActivePage={setActivePage}
      />
    )
  }

  if (
    activePage ===
    'Post-Immersion'
  ) {
    return (
      <PostImmersion
        setActivePage={
          setActivePage
        }
      />
    )
  }

  return (
    <div className="dashboard-section">

      <p className="eyebrow">
        STUDENT DASHBOARD
      </p>

      <h1>
        Page not found
      </h1>

      <p>
        This section is currently
        unavailable.
      </p>

      <button
        type="button"
        className="primary-btn"
        onClick={() =>
          setActivePage('Home')
        }
      >
        Back to Home
      </button>

    </div>
  )
}

/* =========================
   STUDENT PROGRESS
========================= */

const PORTFOLIO_PROGRESS_GROUPS = [
  {
    title: 'Module Introduction',
    modules: [
      { title: 'Cover Page', section: 'Module Introduction/Cover Page' },
      { title: 'Work Immersion Objectives', completedByDefault: true },
      { title: 'How to Use This Work Immersion Module', section: 'Module Introduction/How to Use This Work Immersion Module' },
      { title: "Students' Duties & Responsibilities", section: 'Module Introduction/Student Duties Photo' },
      { title: 'Portfolio Checklist', section: 'Module Introduction/Portfolio Checklist' },
      { title: 'Student ID', section: 'Module Introduction/Student ID Photos' },
    ],
  },
  {
    title: 'Pre-Immersion',
    modules: [
      { title: 'Requirements Checklist', section: 'Pre-Immersion/Requirements Checklist' },
      { title: 'Parent Consent', section: 'Pre-Immersion/Parent Consent' },
      { title: 'List of Task', section: 'Pre-Immersion/List of Task' },
      { title: 'Essay on Workplace Conduct', section: 'Pre-Immersion/Essay on Workplace Conduct' },
      { title: 'Application Letter', section: 'Pre-Immersion/Application Letter' },
      { title: 'Resume', section: 'Pre-Immersion/Resume' },
      { title: 'Barangay Clearance', section: 'Pre-Immersion/Barangay Clearance' },
      { title: 'Police Clearance', section: 'Pre-Immersion/Police Clearance' },
      { title: 'Mayors Clearance', section: 'Pre-Immersion/Mayors Clearance' },
      { title: 'Health Clearance', section: 'Pre-Immersion/Health Clearance' },
    ],
  },
  {
    title: 'Immersion Proper',
    modules: [
      { title: 'Narrative Report', section: 'Immersion Proper/Narrative Report' },
      { title: 'Work Immersion Map Location', section: 'Immersion Proper/Work Immersion Map Location' },
      { title: 'Evaluation Sheet', section: 'Immersion Proper/Evaluation Sheet' },
      { title: 'Daily Time Record', section: 'Immersion Proper/Daily Time Record' },
    ],
  },
  {
    title: 'Post-Immersion',
    modules: [
      { title: 'Written Report', section: 'Post-Immersion/Written Report' },
      { title: 'Forms', section: 'Post-Immersion/Forms' },
      { title: 'Sample', section: 'Post-Immersion/Sample' },
      { title: 'Gallery', section: 'Post-Immersion/Gallery' },
      { title: 'Evaluation', section: 'Post-Immersion/Evaluation' },
      { title: 'Self Evaluation and Reflection', section: 'Post-Immersion/Self Evaluation and Reflection' },
      { title: 'Certificate', section: 'Post-Immersion/Certificate' },
    ],
  },
]

const hasSavedPortfolioAnswer = (value) => {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return false
    try {
      return hasSavedPortfolioAnswer(JSON.parse(trimmed))
    } catch {
      return true
    }
  }
  if (typeof value === 'number' || typeof value === 'boolean') return true
  if (Array.isArray(value)) return value.some(hasSavedPortfolioAnswer)
  if (value && typeof value === 'object') {
    return Object.values(value).some(hasSavedPortfolioAnswer)
  }
  return false
}

function getPortfolioProgress(entries) {
  const progressGroups = PORTFOLIO_PROGRESS_GROUPS.map((group) => {
    const completed = group.modules.filter((module) => (
      module.completedByDefault || hasSavedPortfolioAnswer(entries[module.section])
    )).length
    return { ...group, completed, total: group.modules.length }
  })
  const totalSections = progressGroups.reduce((sum, group) => sum + group.total, 0)
  const completedSections = progressGroups.reduce((sum, group) => sum + group.completed, 0)

  return {
    groups: progressGroups,
    totalSections,
    completedSections,
    percentage: totalSections
      ? Math.round((completedSections / totalSections) * 100)
      : 0,
  }
}

function PortfolioDocumentFrame({ children }) {
  return (
    <div className="portfolio-document-frame-shell">
      <div className="portfolio-document-frame">
        <main className="portfolio-document-frame-content">
          {children}
        </main>
      </div>
    </div>
  )
}

function StudentProgress({ user }) {
  const [entries, setEntries] = useState({})
  const [loading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState('')

  useEffect(() => {
    let cancelled = false

    const loadProgress = async () => {
      if (!user?.id) {
        setLoading(false)
        setErrorMessage('Your account could not be identified. Please log in again.')
        return
      }

      setLoading(true)
      setErrorMessage('')
      try {
        if (!navigator.onLine) {
          const cachedEntries = await getPortfolioEntriesCache(user.id)
          if (!cancelled) {
            setEntries(Object.fromEntries(
              cachedEntries.map((entry) => [entry.section, entry.content]),
            ))
          }
          return
        }

        const { data, error } = await supabase
          .from('portfolio_entries')
          .select('section,content')
          .eq('user_id', user.id)
        if (error) throw error

        const savedEntries = Object.fromEntries(
          (data || []).map((entry) => [entry.section, entry.content])
        )
        await Promise.all((data || []).map((entry) => (
          savePortfolioCache(user.id, entry.section, entry.content)
            .catch((cacheError) => {
              console.error('Cache portfolio progress entry failed:', cacheError)
            })
        )))
        if (!cancelled) setEntries(savedEntries)
      } catch (error) {
        console.error('Load portfolio progress failed:', error)
        if (!cancelled) {
          const cachedEntries = await getPortfolioEntriesCache(user.id)
          if (cachedEntries.length) {
            setEntries(Object.fromEntries(
              cachedEntries.map((entry) => [entry.section, entry.content]),
            ))
          } else {
            setErrorMessage(error?.message || 'Could not load your portfolio progress.')
          }
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadProgress()
    return () => { cancelled = true }
  }, [user?.id])

  const portfolioProgress = getPortfolioProgress(entries)

  return (
    <div className="dashboard-section">

      <p className="eyebrow">
        STUDENT DASHBOARD / PROGRESS
      </p>

      <h1>
        Portfolio Progress
      </h1>

      <p>
        Track your progress as you
        complete your Work Immersion
        portfolio.
      </p>

      <div className="progress-overview-card">

        <div className="progress-overview-header">

          <div>
            <span className="eyebrow">
              OVERALL PROGRESS
            </span>

            <h2>
              Portfolio Completion
            </h2>
          </div>

          <strong>
            {loading ? '…' : `${portfolioProgress.percentage}%`}
          </strong>

        </div>

        <div className="progress-bar">

          <div
            className="progress-fill"
            style={{
              width: `${loading ? 0 : portfolioProgress.percentage}%`,
            }}
          />

        </div>

        <div className="progress-stats">

          <span>
            Completed sections:{' '}
            <strong>
              {loading ? '…' : portfolioProgress.completedSections}
            </strong>
          </span>

          <span>
            Remaining sections:{' '}
            <strong>
              {loading ? '…' : portfolioProgress.totalSections - portfolioProgress.completedSections}
            </strong>
          </span>

        </div>

      </div>

      <div className="progress-module-list">
        {portfolioProgress.groups.map((group) => (
          <ProgressModule
            key={group.title}
            title={group.title}
            completed={group.completed}
            total={group.total}
          />
        ))}

      </div>

      {loading && <p role="status">Loading portfolio progress...</p>}
      {errorMessage && <p role="alert" className="workplace-essay-message error">{errorMessage}</p>}

    </div>
  )
}

function AcademicProgress() {
  return (
    <div className="dashboard-section">
      <p className="eyebrow">
        STUDENT DASHBOARD / PROGRESS
      </p>
      <h1>Progress</h1>
      <p>Academic progress tracking is not available yet.</p>
      <div className="progress-overview-card">
        <div className="progress-overview-header">
          <div>
            <span className="eyebrow">OVERALL PROGRESS</span>
            <h2>Academic Progress</h2>
          </div>
          <strong>—</strong>
        </div>
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: '0%' }} />
        </div>
      </div>
    </div>
  )
}

/* =========================
   PROGRESS MODULE CARD
========================= */

function ProgressModule({
  title,
  completed,
  total,
}) {
  const percentage =
    total > 0
      ? Math.round(
          (completed / total) *
            100
        )
      : 0

  return (
    <div className="progress-module-card">

      <div className="progress-module-header">

        <h3>
          {title}
        </h3>

        <span>
          {percentage}%
        </span>

      </div>

      <div className="progress-bar">

        <div
          className="progress-bar-fill"
          style={{
            width:
              `${percentage}%`,
          }}
        />

      </div>

      <div className="progress-module-footer">

        <span>
          {percentage}% complete
        </span>

        <span>
          {completed} / {total} sections
        </span>

      </div>

    </div>
  )
}

/* =========================
   TEACHER FEEDBACK
========================= */

function TeacherFeedback({ user, selectedFeedbackId, onClearSelectedFeedback }) {
  const [feedback, setFeedback] = useState([])
  const [selectedFeedback, setSelectedFeedback] = useState(null)
  const [loading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState('')

  useEffect(() => {
    if (!user?.id) {
      setLoading(false)
      return undefined
    }

    let cancelled = false
    const loadFeedback = async () => {
      setLoading(true)
      setErrorMessage('')
      try {
        const [{ data: feedbackRows, error: feedbackError }, { data: notifications, error: notificationError }] =
          await Promise.all([
            supabase
              .from('teacher_feedback')
              .select('id, teacher_id, student_id, title, message, category, created_at')
              .eq('student_id', user.id)
              .order('created_at', { ascending: false }),
            supabase
              .from('student_notifications')
              .select('id, feedback_id, is_read')
              .eq('recipient_id', user.id),
          ])
        if (feedbackError) throw feedbackError
        if (notificationError) throw notificationError

        const teacherIds = [...new Set((feedbackRows || []).map((item) => item.teacher_id))]
        let teacherProfiles = []
        if (teacherIds.length) {
          const { data, error } = await supabase
            .from('profiles')
            .select('id, full_name')
            .in('id', teacherIds)
          if (error) throw error
          teacherProfiles = data || []
        }

        const notificationByFeedback = new Map(
          (notifications || []).map((notification) => [notification.feedback_id, notification])
        )
        const teacherById = new Map(teacherProfiles.map((profile) => [profile.id, profile]))
        let rows = (feedbackRows || []).map((item) => ({
          ...item,
          teacher_name: teacherById.get(item.teacher_id)?.full_name || 'Teacher',
          notification: notificationByFeedback.get(item.id) || null,
        }))
        const requestedFeedback = rows.find((item) => item.id === selectedFeedbackId)
        if (requestedFeedback?.notification && !requestedFeedback.notification.is_read) {
          const { error } = await supabase
            .from('student_notifications')
            .update({ is_read: true })
            .eq('id', requestedFeedback.notification.id)
            .eq('recipient_id', user.id)
            .eq('is_read', false)
          if (error) throw error
          const readNotification = { ...requestedFeedback.notification, is_read: true }
          rows = rows.map((item) => (
            item.id === requestedFeedback.id
              ? { ...item, notification: readNotification }
              : item
          ))
          window.dispatchEvent(new Event('student-notifications-updated'))
        }

        if (!cancelled) {
          setFeedback(rows)
          setSelectedFeedback((current) => {
            const requestedId = selectedFeedbackId || current?.id
            return rows.find((item) => item.id === requestedId) || null
          })
        }
      } catch (error) {
        console.error('Load teacher feedback failed:', error)
        if (!cancelled) {
          setErrorMessage(error?.message || 'Could not load teacher feedback.')
          setFeedback([])
          setSelectedFeedback(null)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadFeedback()
    const intervalId = window.setInterval(loadFeedback, 30000)
    const channel = supabase
      .channel(`student-feedback-${user.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'teacher_feedback',
          filter: `student_id=eq.${user.id}`,
        },
        loadFeedback
      )
      .subscribe()
    window.addEventListener('focus', loadFeedback)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
      window.removeEventListener('focus', loadFeedback)
      supabase.removeChannel(channel)
    }
  }, [user?.id, selectedFeedbackId])

  const openFeedback = async (item) => {
    setSelectedFeedback(item)
    const notification = item.notification
    if (!notification || notification.is_read) return

    const { error } = await supabase
      .from('student_notifications')
      .update({ is_read: true })
      .eq('id', notification.id)
      .eq('recipient_id', user.id)
      .eq('is_read', false)

    if (error) {
      console.error('Mark feedback notification as read failed:', error)
      setErrorMessage(error.message || 'Could not mark this notification as read.')
      return
    }

    const updatedNotification = { ...notification, is_read: true }
    setFeedback((previous) => previous.map((entry) => (
      entry.id === item.id ? { ...entry, notification: updatedNotification } : entry
    )))
    setSelectedFeedback((previous) => (
      previous?.id === item.id ? { ...previous, notification: updatedNotification } : previous
    ))
    window.dispatchEvent(new Event('student-notifications-updated'))
  }

  const formatFeedbackDate = (date) => {
    const parsedDate = date ? new Date(date) : null
    return parsedDate && !Number.isNaN(parsedDate.getTime())
      ? parsedDate.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      : 'Date unavailable'
  }

  return (
    <div className="dashboard-section">

      <p className="eyebrow">
        STUDENT DASHBOARD / TEACHER FEEDBACK
      </p>

      <h1>
        Teacher Feedback
      </h1>

      <p>
        View comments and feedback
        from your Work Immersion
        teacher.
      </p>

      {errorMessage && <p className="student-feedback-error" role="alert">{errorMessage}</p>}
      {loading ? (
        <div className="feedback-empty-card" role="status">
          <p>Loading teacher feedback...</p>
        </div>
      ) : selectedFeedback ? (
        <article className="student-feedback-detail">
          <button
            type="button"
            className="teacher-text-btn"
            onClick={() => {
              setSelectedFeedback(null)
              onClearSelectedFeedback?.()
            }}
          >
            <ArrowLeft size={16} /> All feedback
          </button>
          <div className="student-feedback-detail-heading">
            <div>
              <p className="eyebrow">FROM {selectedFeedback.teacher_name}</p>
              <h2>{selectedFeedback.title}</h2>
            </div>
            <span className={`student-feedback-read-status ${selectedFeedback.notification?.is_read ? 'is-read' : ''}`}>
              {selectedFeedback.notification?.is_read ? 'Read' : 'Unread'}
            </span>
          </div>
          {selectedFeedback.category && (
            <p className="student-feedback-category">{selectedFeedback.category}</p>
          )}
          <p className="student-feedback-date">Sent {formatFeedbackDate(selectedFeedback.created_at)}</p>
          <p className="student-feedback-message">{selectedFeedback.message}</p>
        </article>
      ) : feedback.length ? (
        <div className="student-feedback-list">
          {feedback.map((item) => (
            <button
              type="button"
              className="student-feedback-card"
              key={item.id}
              onClick={() => openFeedback(item)}
            >
              <span className="student-feedback-card-main">
                <strong>{item.title}</strong>
                <span>From {item.teacher_name} · {formatFeedbackDate(item.created_at)}</span>
                {item.category && <span>{item.category}</span>}
              </span>
              <span className={`student-feedback-read-status ${item.notification?.is_read ? 'is-read' : ''}`}>
                {item.notification?.is_read ? 'Read' : 'Unread'}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="feedback-empty-card">
          <div className="feedback-icon"><MessageSquare size={28} /></div>
          <h2>No Feedback Yet</h2>
          <p>Your teacher's comments and feedback will appear here once they send them.</p>
        </div>
      )}

    </div>
  )
}


/* =========================
   WORK IMMERSION CLASS
========================= */

function WorkImmersionClass() {
  const [classCode, setClassCode] = useState('')
  const [joinedClass, setJoinedClass] = useState([])
  const [loading, setLoading] = useState(true)
  const [joining, setJoining] = useState(false)

  // LOAD JOINED CLASSES
  const loadJoinedClasses = async () => {
    setLoading(true)

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      setLoading(false)
      return
    }

    const { data, error } = await supabase
      .from('class_members')
      .select(`
        id,
        joined_at,
        immersion_classes (
          id,
          class_name,
          class_code,
          teacher_id
        )
      `)
      .eq('student_id', user.id)
      .order('joined_at', { ascending: false })

    if (error) {
      console.error('Load joined classes:', error)
      alert('Unable to load classes: ' + error.message)
    } else {
      setJoinedClass(
        (data || []).map((item) => item.immersion_classes).filter(Boolean)
      )
    }

    setLoading(false)
  }

  useEffect(() => {
    loadJoinedClasses()
  }, [])

  // JOIN CLASS USING CODE
  const joinClass = async () => {
    if (!classCode.trim()) {
      alert('Please enter your class code.')
      return
    }

    setJoining(true)

    try {
      const { data, error } = await supabase.rpc(
        'join_immersion_class',
        {
          p_class_code: classCode.trim().toUpperCase(),
        }
      )

      if (error) {
        console.error('Join class error:', error)
        alert('Unable to join class: ' + error.message)
        return
      }

      alert('Successfully joined your Work Immersion class!')

      setClassCode('')
      await loadJoinedClasses()

    } catch (error) {
      console.error(error)
      alert('Something went wrong. Please try again.')
    } finally {
      setJoining(false)
    }
  }

  return (
    <div className="dashboard-section">

      <p className="eyebrow">
        STUDENT DASHBOARD / WORK IMMERSION CLASS
      </p>

      <h1>
        My Work Immersion Class
      </h1>

      <p>
        Join your Work Immersion class using
        the class code provided by your teacher.
      </p>

      {/* JOIN CLASS */}

      <div className="class-info-card">

        <h2>
          Join a Class
        </h2>

        <p>
          Enter the class code shared by your
          Work Immersion teacher.
        </p>

        <input
          type="text"
          placeholder="Enter class code"
          value={classCode}
          onChange={(e) =>
            setClassCode(e.target.value.toUpperCase())
          }
          maxLength={8}
        />

        <button
          type="button"
          className="primary-btn"
          onClick={joinClass}
          disabled={joining}
        >
          {joining ? 'Joining...' : 'Join Class'}
        </button>

      </div>

      {/* JOINED CLASSES */}

      <div className="class-info-card">

        <h2>
          My Joined Classes
        </h2>

        {loading ? (
          <p>Loading your classes...</p>
        ) : joinedClass.length > 0 ? (

          joinedClass.map((item) => (
            <div
              key={item.id}
              className="joined-class-item"
            >

              <h3>{item.class_name}</h3>

              <p>
                Class Code: {item.class_code}
              </p>

              <p>
                Status: Joined
              </p>

            </div>
          ))

        ) : (

          <p>
            You have not joined a class yet.
            Enter your teacher's class code above.
          </p>

        )}

      </div>

    </div>
  )
}

/* =========================
   SUBMISSION HISTORY
========================= */

function SubmissionHistory() {
  return (
    <div className="dashboard-section">

      <p className="eyebrow">
        STUDENT DASHBOARD / SUBMISSION HISTORY
      </p>

      <h1>
        Submission History
      </h1>

      <p>
        View your previous portfolio
        submissions and their status.
      </p>

      <div className="submission-empty-card">

        <Clock3 size={28} />

        <h2>
          No Submissions Yet
        </h2>

        <p>
          Your submitted portfolio
          requirements will appear
          here.
        </p>

      </div>

    </div>
  )
}

/* =========================
   LEADERBOARD
========================= */

function Leaderboard() {
  return (
    <div className="dashboard-section">

      <p className="eyebrow">
        STUDENT DASHBOARD / LEADERBOARD
      </p>

      <h1>
        Leaderboard
      </h1>

      <p>
        View the completion rankings
        of students in your Work
        Immersion class.
      </p>

      <div className="leaderboard-empty-card">

        <Trophy size={28} />

        <h2>
          No Rankings Yet
        </h2>

        <p>
          Student rankings will
          appear here once portfolio
          progress is recorded.
        </p>

      </div>

    </div>
  )
}

/* =========================
   NOTIFICATIONS
========================= */

function StudentNotifications({ user, onOpenFeedback }) {
  const [notifications, setNotifications] = useState([])
  const [loading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState('')

  useEffect(() => {
    if (!user?.id) {
      setLoading(false)
      return undefined
    }

    let cancelled = false
    const loadNotifications = async () => {
      setErrorMessage('')
      try {
        const { data, error } = await supabase
          .from('student_notifications')
          .select('id, feedback_id, title, message, created_at, is_read')
          .eq('recipient_id', user.id)
          .order('created_at', { ascending: false })
        if (error) throw error
        if (!cancelled) setNotifications(data || [])
      } catch (error) {
        console.error('Load student notifications failed:', error)
        if (!cancelled) {
          setNotifications([])
          setErrorMessage(error?.message || 'Could not load notifications.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadNotifications()
    const intervalId = window.setInterval(loadNotifications, 30000)
    const channel = supabase
      .channel(`student-notifications-list-${user.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'student_notifications',
          filter: `recipient_id=eq.${user.id}`,
        },
        loadNotifications
      )
      .subscribe()
    window.addEventListener('focus', loadNotifications)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
      window.removeEventListener('focus', loadNotifications)
      supabase.removeChannel(channel)
    }
  }, [user?.id])

  return (
    <div className="dashboard-section">

      <p className="eyebrow">
        STUDENT DASHBOARD / NOTIFICATIONS
      </p>

      <h1>
        Notifications
      </h1>

      <p>
        Stay updated with your
        portfolio and Work Immersion
        activities.
      </p>

      {errorMessage && <p className="student-feedback-error" role="alert">{errorMessage}</p>}
      {loading ? (
        <div className="notification-empty-card" role="status"><p>Loading notifications...</p></div>
      ) : notifications.length ? (
        <div className="student-notification-list">
          {notifications.map((notification) => (
            <article
              className={`student-notification-card${notification.is_read ? '' : ' is-unread'}`}
              key={notification.id}
            >
              <div>
                <p className="student-notification-date">
                  {notification.created_at
                    ? new Date(notification.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
                    : 'Date unavailable'}
                </p>
                <h2>{notification.title}</h2>
                <p>{notification.message}</p>
                <span className={`student-feedback-read-status ${notification.is_read ? 'is-read' : ''}`}>
                  {notification.is_read ? 'Read' : 'Unread'}
                </span>
              </div>
              <button
                type="button"
                className="teacher-outline-btn"
                onClick={() => onOpenFeedback?.(notification.feedback_id)}
              >
                Open feedback
              </button>
            </article>
          ))}
        </div>
      ) : (
        <div className="notification-empty-card">
          <Bell size={28} />
          <h2>No Notifications</h2>
          <p>New updates, reminders, and announcements will appear here.</p>
        </div>
      )}

    </div>
  )
}

/* =========================
   HELP CENTER
========================= */

function HelpCenter({ teacherMode = false, user }) {
  const [openFAQ, setOpenFAQ] =
    useState(null)
  const [sendingRecoveryEmail, setSendingRecoveryEmail] = useState(false)
  const [recoveryEmailMessage, setRecoveryEmailMessage] = useState('')
  const [recoveryEmailError, setRecoveryEmailError] = useState('')

  const handleSendRecoveryEmail = async () => {
    if (!user?.email) {
      setRecoveryEmailError('No email address is associated with your teacher account.')
      setRecoveryEmailMessage('')
      return
    }

    setSendingRecoveryEmail(true)
    setRecoveryEmailError('')
    setRecoveryEmailMessage('')
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(user.email, {
        redirectTo: window.location.origin,
      })
      if (error) throw error
      setRecoveryEmailMessage(
        `If ${user.email} is registered, a password recovery link has been sent. Check your Gmail inbox and spam folder.`
      )
    } catch (error) {
      console.error('Teacher password recovery email failed:', error)
      setRecoveryEmailError(
        error?.message || 'Could not send the recovery email. Please try again.'
      )
    } finally {
      setSendingRecoveryEmail(false)
    }
  }

  const faqs = [
    {
      question:
        'How do I start my portfolio?',
      answer:
        'Go to My Portfolio and select the portfolio theme for your strand.',
    },
    {
      question:
        'Can I update my portfolio?',
      answer:
        'Yes. You can update your portfolio sections as you complete your Work Immersion requirements.',
    },
    {
      question:
        'How do I know my progress?',
      answer:
        'Open Progress to view your completed sections and overall portfolio completion.',
    },
    {
      question:
        "Where can I see my teacher's feedback?",
      answer:
        "Open Teacher Feedback to view comments and feedback from your Work Immersion teacher.",
    },
  ]

  return (
    <div className="dashboard-section">

      <p className="eyebrow">
        {teacherMode ? 'TEACHER' : 'STUDENT'} DASHBOARD / HELP CENTER
      </p>

      <h1>
        Help Center
      </h1>

      <p>
        {teacherMode
          ? 'Guides and account support for your i-WORKFOLIO teacher account.'
          : 'Guides and answers to help you use i-WORKFOLIO.'}
      </p>

      {teacherMode && (
        <section className="help-password-recovery">
          <div>
            <h2>Forgot your password?</h2>
            <p>
              Send a secure password recovery link to your teacher email address:
              {' '}<strong>{user?.email || 'Email unavailable'}</strong>
            </p>
            <p>
              Open the link in your inbox to choose a new password. The link is sent by the account email provider.
            </p>
          </div>
          <button
            type="button"
            className="primary-btn"
            onClick={handleSendRecoveryEmail}
            disabled={sendingRecoveryEmail || !user?.email}
          >
            {sendingRecoveryEmail ? 'Sending...' : 'Send Password Recovery Link'}
          </button>
          {recoveryEmailMessage && (
            <p className="password-recovery-success" role="status">
              {recoveryEmailMessage}
            </p>
          )}
          {recoveryEmailError && (
            <p className="login-error" role="alert">
              {recoveryEmailError}
            </p>
          )}
        </section>
      )}

      <div className="help-guides">

        <h2>
          Quick Start Guides
        </h2>

        <div className="help-guide-grid">

          <div className="help-guide-card">
            <h3>
              Getting Started
            </h3>

            <p>
              Set up your student
              profile and join your
              first class.
            </p>
          </div>

          <div className="help-guide-card">
            <h3>
              Building Your Portfolio
            </h3>

            <p>
              Complete each module
              folder: Module Introduction,
              Pre-Immersion, Immersion
              Proper, and Post-Immersion.
            </p>
          </div>

          <div className="help-guide-card">
            <h3>
              Uploading Documents
            </h3>

            <p>
              Upload photos, signatures,
              and documents to your
              portfolio sections.
            </p>
          </div>

          <div className="help-guide-card">
            <h3>
              Exporting to PDF
            </h3>

            <p>
              Download your complete
              portfolio as a professional
              PDF document.
            </p>
          </div>

          <div className="help-guide-card">
            <h3>
              Notifications
            </h3>

            <p>
              Stay updated on teacher
              feedback and portfolio
              status changes.
            </p>
          </div>

          <div className="help-guide-card">
            <h3>
              Account Settings
            </h3>

            <p>
              Manage your profile,
              notifications, and
              appearance preferences.
            </p>
          </div>

        </div>

      </div>

      <div className="help-faq">

        <h2>
          Frequently Asked Questions
        </h2>

        {faqs.map(
          (faq, index) => (
            <div
              className="faq-card"
              key={faq.question}
            >

              <button
                type="button"
                className="faq-question"
                onClick={() =>
                  setOpenFAQ(
                    openFAQ === index
                      ? null
                      : index
                  )
                }
              >

                <span>
                  {faq.question}
                </span>

                <span className="faq-arrow">
                  {openFAQ === index
                    ? '⌃'
                    : '⌄'}
                </span>

              </button>

              {openFAQ === index && (
                <p className="faq-answer">
                  {faq.answer}
                </p>
              )}

            </div>
          )
        )}

      </div>

    </div>
  )
}

/* =========================
   MY PROFILE
========================= */

function MyProfile({
  user,
  onAvatarChange,
  onNameChange,
}) {
  const [profile, setProfile] =
    useState({
      full_name:
        user?.full_name || '',
      lrn: user?.lrn || '',
      grade:
        user?.grade || '',
      section:
        user?.section || '',
      strand:
        user?.strand || '',
      track:
        user?.track || '',
      specialization:
        user?.specialization || '',
      school:
        user?.school || '',
      email:
        user?.email || '',
      contact_number:
        user?.contact_number || '',
      adviser:
        user?.adviser || '',
      work_immersion_teacher:
        user?.work_immersion_teacher ||
        '',
      school_head:
        user?.school_head || '',
    })

  const [avatarUrl, setAvatarUrl] =
    useState(
      user?.avatar_url || ''
    )

  const [uploading, setUploading] =
    useState(false)

  useEffect(() => {
    const loadProfile =
      async () => {
        if (!user?.id) return

        const { data, error } =
          await supabase
            .from('profiles')
            .select('*')
            .eq('id', user.id)
            .single()

        if (error) {
          console.error(
            'LOAD PROFILE ERROR:',
            error
          )
          return
        }

        if (data) {
          setProfile({
            full_name:
              data.full_name || '',
            lrn:
              data.lrn || '',
            grade:
              data.grade || '',
            section:
              data.section || '',
            strand:
              data.strand || '',
            track:
              data.track || '',
            specialization:
              data.specialization ||
              '',
            school:
              data.school || '',
            email:
              data.email || '',
            contact_number:
              data.contact_number ||
              '',
            adviser:
              data.adviser || '',
            work_immersion_teacher:
              data.work_immersion_teacher ||
              '',
            school_head:
              data.school_head || '',
          })

          setAvatarUrl(
            data.avatar_url || ''
          )
        }
      }

    loadProfile()
  }, [user?.id])

  const uploadAvatar = async (
    event
  ) => {
    const file =
      event.target.files?.[0]

    if (!file) return

    setUploading(true)

    try {
      const {
        data: {
          session,
        },
      } =
        await supabase.auth.getSession()

      if (!session) {
        alert(
          'No active Supabase session. Please log in again.'
        )
        return
      }

      const filePath =
        `${session.user.id}/${Date.now()}-${file.name}`

      const {
        error: uploadError,
      } =
        await supabase.storage
          .from(
            'profile-pictures'
          )
          .upload(
            filePath,
            file,
            {
              upsert: false,
              contentType:
                file.type,
            }
          )

      if (uploadError) {
        console.error(
          'UPLOAD ERROR:',
          uploadError
        )

        alert(
          `Upload error: ${uploadError.message}`
        )

        return
      }

      const { data } =
        supabase.storage
          .from(
            'profile-pictures'
          )
          .getPublicUrl(
            filePath
          )

      const imageUrl =
        data.publicUrl

      const {
        error: updateError,
      } =
        await supabase
          .from('profiles')
          .update({
            avatar_url:
              imageUrl,
          })
          .eq(
            'id',
            session.user.id
          )

      if (updateError) {
        console.error(
          'PROFILE UPDATE ERROR:',
          updateError
        )

        alert(
          `Profile update error: ${updateError.message}`
        )

        return
      }

      setAvatarUrl(imageUrl)

      if (onAvatarChange) {
        onAvatarChange(
          imageUrl
        )
      }

      if (onNameChange) {
        onNameChange(
          profile.full_name
        )
      }

      alert(
        'Profile picture saved!'
      )
    } finally {
      setUploading(false)
    }
  }

  const saveProfile = async () => {
    if (!user?.id) {
      alert(
        'No user account found.'
      )
      return
    }

    const {
      data: { session },
    } =
      await supabase.auth.getSession()

    if (!session) {
      alert(
        'Please log in again.'
      )
      return
    }

    const { error } =
      await supabase
        .from('profiles')
        .update({
          full_name:
            profile.full_name,
          lrn:
            profile.lrn,
          grade:
            profile.grade,
          section:
            profile.section,
          strand:
            profile.strand,
          track:
            profile.track,
          specialization:
            profile.specialization,
          school:
            profile.school,
          contact_number:
            profile.contact_number,
          adviser:
            profile.adviser,
          work_immersion_teacher:
            profile.work_immersion_teacher,
          school_head:
            profile.school_head,
        })
        .eq(
          'id',
          session.user.id
        )

    if (error) {
      console.error(
        'SAVE PROFILE ERROR:',
        error
      )

      alert(
        `Failed to save profile: ${error.message}`
      )

      return
    }

    if (onNameChange) {
      onNameChange(
        profile.full_name
      )
    }

    alert(
      'Profile saved successfully!'
    )

    window.location.reload()
  }

  return (
    <div className="dashboard-section">

      <p className="eyebrow">
        STUDENT DASHBOARD / MY PROFILE
      </p>

      <h1>
        My Profile
      </h1>

      <p>
        {isAcademicStrand(user?.strand)
          ? 'Your information syncs with your account automatically.'
          : 'Your information syncs with your portfolio automatically.'}
      </p>

      <div className="profile-completion-card">

        <div className="profile-completion-header">

          <div>
            <span className="eyebrow">
              PROFILE COMPLETION
            </span>

            <h2>
              Profile Completion
            </h2>
          </div>

          <strong>
            0%
          </strong>

        </div>

        <div className="profile-progress-bar">
          <div className="profile-progress-fill"></div>
        </div>

        <div className="profile-missing">

          <span>
            Missing:
          </span>

          <div className="missing-fields">

            <span>Full Name</span>
            <span>LRN</span>
            <span>Grade</span>
            <span>Section</span>
            <span>Strand</span>
            <span>Track</span>
            {!isAcademicStrand(user?.strand) && (
              <span>Specialization</span>
            )}
            <span>School</span>
            <span>Email</span>
            <span>Contact Number</span>
            <span>Adviser</span>
            <span>
              Work Immersion Teacher
            </span>
            <span>School Head</span>

          </div>

        </div>

      </div>

      <div className="profile-photo-card">

        <div>
          <span className="eyebrow">
            PROFILE PHOTO
          </span>

          <h2>
            Profile Photo
          </h2>
        </div>

        <div className="profile-photo-preview">

          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt="Profile"
            />
          ) : (
            <div className="profile-photo-placeholder">
              No photo
            </div>
          )}

        </div>

        <label className="profile-upload-btn">

          {uploading
            ? 'Uploading...'
            : 'Choose Photo'}

          <input
            type="file"
            accept="image/*"
            onChange={
              uploadAvatar
            }
            disabled={
              uploading
            }
            hidden
          />

        </label>

      </div>

      <div className="profile-info-section">

        <h2>
          Personal Information
        </h2>

        <ProfileField
          label="Full Name"
          value={
            profile.full_name
          }
          placeholder="Enter your full name"
          onChange={(value) =>
            setProfile({
              ...profile,
              full_name: value,
            })
          }
        />

        <ProfileField
          label="LRN"
          value={
            profile.lrn
          }
          placeholder="Enter your LRN"
          onChange={(value) =>
            setProfile({
              ...profile,
              lrn: value,
            })
          }
        />

        <ProfileField
          label="Grade"
          value={
            profile.grade
          }
          placeholder="Enter your grade"
          onChange={(value) =>
            setProfile({
              ...profile,
              grade: value,
            })
          }
        />

        <ProfileField
          label="Section"
          value={
            profile.section
          }
          placeholder="Enter your section"
          onChange={(value) =>
            setProfile({
              ...profile,
              section: value,
            })
          }
        />

        <ProfileField
          label="Strand"
          value={
            profile.strand
          }
          placeholder="Enter your strand"
          options={[
            'TVL',
            'ACADEMIC',
          ]}
          onChange={(value) =>
            setProfile({
              ...profile,
              strand: value,
            })
          }
        />

        <ProfileField
          label="Track"
          value={
            profile.track
          }
          placeholder="Enter your track"
          onChange={(value) =>
            setProfile({
              ...profile,
              track: value,
            })
          }
        />

        {!isAcademicStrand(user?.strand) && (
          <ProfileField
            label="Specialization"
            value={
              profile.specialization
            }
            placeholder="Enter your specialization"
            onChange={(value) =>
              setProfile({
                ...profile,
                specialization:
                  value,
              })
            }
          />
        )}

        <ProfileField
          label="School"
          value={
            profile.school
          }
          placeholder="Enter your school"
          onChange={(value) =>
            setProfile({
              ...profile,
              school: value,
            })
          }
        />

        <div className="profile-info-item">

          <span>
            Email
          </span>

          <input
            value={
              profile.email
            }
            disabled
          />

        </div>

        <ProfileField
          label="Contact Number"
          value={
            profile.contact_number
          }
          placeholder="Enter your contact number"
          onChange={(value) =>
            setProfile({
              ...profile,
              contact_number:
                value,
            })
          }
        />

        <ProfileField
          label="Adviser"
          value={
            profile.adviser
          }
          placeholder="Enter your adviser"
          onChange={(value) =>
            setProfile({
              ...profile,
              adviser: value,
            })
          }
        />

        <ProfileField
          label="Work Immersion Teacher"
          value={
            profile.work_immersion_teacher
          }
          placeholder="Enter your work immersion teacher"
          onChange={(value) =>
            setProfile({
              ...profile,
              work_immersion_teacher:
                value,
            })
          }
        />

        <ProfileField
          label="School Head"
          value={
            profile.school_head
          }
          placeholder="Enter your school head"
          onChange={(value) =>
            setProfile({
              ...profile,
              school_head:
                value,
            })
          }
        />

      </div>

      <button
        className="profile-save-btn"
        onClick={
          saveProfile
        }
      >
        Save Profile
      </button>

    </div>
  )
}

/* =========================
   PROFILE FIELD
========================= */

function ProfileField({
  label,
  value,
  placeholder,
  onChange,
  options,
}) {
  return (
    <div className="profile-info-item">

      <span>
        {label}
      </span>

      {options ? (
        <select
          value={
            options.includes(value)
              ? value
              : value || ''
          }
          onChange={(e) =>
            onChange(
              e.target.value
            )
          }
        >
          <option value="" disabled>
            Select your strand
          </option>
          {value && !options.includes(value) && (
            <option value={value} disabled>
              {value}
            </option>
          )}
          {options.map((option) => (
            <option
              key={option}
              value={option}
            >
              {option === 'TVL'
                ? 'TVL (Technical-Vocational-Livelihood)'
                : option}
            </option>
          ))}
        </select>
      ) : (
        <input
          value={value}
          onChange={(e) =>
            onChange(
              e.target.value
            )
          }
          placeholder={
            placeholder
          }
        />
      )}

    </div>
  )
}

/* =========================
   SETTINGS
========================= */

function formatPortfolioLabel(value) {
  return String(value)
    .split('/')
    .pop()
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function getPortfolioExportPages(entries, groupTitles = PORTFOLIO_PROGRESS_GROUPS.map((group) => group.title)) {
  const selectedGroups = PORTFOLIO_PROGRESS_GROUPS.filter((group) => groupTitles.includes(group.title))
  const knownPages = selectedGroups.flatMap((group) => group.modules.map((module) => ({
    title: module.title,
    section: module.section || null,
    group: group.title,
    staticContent: module.title === 'Work Immersion Objectives'
      ? [
          'One of the goals of the K to 12 Basic Education Program is for you to develop the competencies, work ethics, and values relevant in pursuing further education and/or joining the world of work.',
          "To become a productive citizen that will contribute to our nation's development targets, Work immersion, a required subject in Senior High School, has been incorporated in to the curriculum that will provide you with opportunities:",
          '1. To become familiar with the work place;',
          '2. For employment simulation; and',
          '3. To apply your competencies Computer Systems Servicing in authentic work environment.',
          'To achieve the above objectives, Work Immersion is a requirement for graduation from secondary education. In this time of pandemic, you will be immersed in actual school-based work immersion simulation and home-based activities. In addition, portfolio shall be submitted and presented to a group of panel at the end of this subject.',
        ]
      : module.title === "Students' Duties & Responsibilities"
        ? [
            'Adopted from School System Practicum Manual by E. Lorenzana',
            'You must observe the rules of etiquette at all times.',
            'Always treat your Immersion Teacher and school employees as supervisors with utmost respect.',
            'Give your customers the appropriate service.',
            'You must always be friendly to your fellow immersionists.',
            'Maintain professionalism in all your activities.',
            'You must observe the rules and regulations of the work immersion simulation area.',
            'Keep regular working hours as assigned to you at the school simulation workplace.',
            'Inform the Work Immersion Teacher immediately about absences or tardiness.',
            'Present a medical certificate if the absence was due to health reasons. If the reason was personal, present an excuse letter from your parent or guardian.',
            'Follow policies on break time, meals, and other school simulation rules. Sharing of food is not allowed.',
            'Uniform: Female students should wear a white T-shirt, pants, closed shoes, and a ponytail. Male students should wear a white T-shirt, pants, and closed shoes. Shorts, sleeveless shirts, and slippers are not allowed.',
            'Never take school property outside the workplace, including RJ45 connectors, cables, crimpers, RAM, mice, or keyboards.',
            'Loitering in the school or work simulation area is not allowed.',
            'Cellphones and other gadgets are not allowed while on duty.',
            'Smoking and chewing betel nut, locally known as mama, are not allowed within the workplace premises.',
            'Accept and complete responsibilities assigned as part of the Work Immersion training and experience.',
            'Stay away from employees’ problems and intrigues.',
            'Violation of the rules and regulations, especially health protocols, may result in disciplinary action, including a written reprimand, suspension from school-based training, or termination from school-based training.',
            'Depending on the gravity of the misdemeanor, such as a breach of health protocols, pilferage, or insubordination, the Work Immersion Teacher may decide on termination with the approval of the School Principal.',
            'Conforme: Student’s Name and Signature ____________________    Parent’s/Guardian’s Name and Signature ____________________',
            'Date: ____________________    Date: ____________________',
          ]
        : null,
  }))).flatMap((page) => page.title === 'Requirements Checklist'
    ? [
        page,
        { title: 'Class Schedule', section: 'Pre-Immersion/Class Schedule', group: 'Pre-Immersion' },
      ]
    : [page])

  return selectedGroups.flatMap((group) => {
    const groupPages = knownPages
      .filter((page) => page.group === group.title)
      .map((page) => ({
        ...page,
        savedContent: page.section
          ? entries.find((entry) => entry.section === page.section)?.content
          : undefined,
      }))
    const knownSections = new Set(groupPages.map((page) => page.section).filter(Boolean))
    const additionalPages = entries
      .filter((entry) => (
        entry.section?.startsWith(`${group.title}/`) &&
        !knownSections.has(entry.section)
      ))
      .map((entry) => ({
        title: formatPortfolioLabel(entry.section),
        section: entry.section,
        group: group.title,
        savedContent: entry.content,
      }))

    return [...groupPages, ...additionalPages]
  })
}

function normalizePortfolioExportContent(content) {
  if (typeof content !== 'string') return content

  try {
    return JSON.parse(content)
  } catch {
    return content
  }
}

async function appendPortfolioSupplementPages(pdf, entries, groupTitle, handledSections, font, boldFont) {
  const { rgb } = await import('pdf-lib')
  const pageSize = pdf.getPages()[0]?.getSize() || { width: 612, height: 1008 }
  const extraEntries = entries.filter((entry) => (
    entry.section?.startsWith(groupTitle + '/') &&
    !handledSections.has(entry.section) &&
    hasSavedPortfolioAnswer(entry.content)
  ))
  const wrap = (value, width, size) => {
    const lines = []
    let line = ''
    for (const word of toPdfSafeText(String(value), font).split(/\s+/).filter(Boolean)) {
      let remaining = word
      while (remaining && font.widthOfTextAtSize(remaining, size) > width) {
        if (line) { lines.push(line); line = '' }
        let split = remaining.length
        while (split > 1 && font.widthOfTextAtSize(remaining.slice(0, split), size) > width) split -= 1
        lines.push(remaining.slice(0, split))
        remaining = remaining.slice(split)
      }
      if (!remaining) continue
      const candidate = line ? line + ' ' + remaining : remaining
      if (line && font.widthOfTextAtSize(candidate, size) > width) {
        lines.push(line)
        line = remaining
      } else line = candidate
    }
    if (line) lines.push(line)
    return lines
  }
  const collectImages = (value, prefix = '') => {
    if (Array.isArray(value)) return value.flatMap((item, index) => collectImages(item, prefix + ' ' + (index + 1)))
    if (!value || typeof value !== 'object') return []
    return Object.entries(value).flatMap(([key, child]) => {
      const label = (prefix + ' ' + formatPortfolioLabel(key)).trim()
      if (typeof child === 'string' && /(?:path|photo|image|picture|url)$/i.test(key) && child.trim()) {
        return [{ label, path: child.trim() }]
      }
      return collectImages(child, label)
    })
  }
  for (const entry of extraEntries) {
    const title = formatPortfolioLabel(entry.section.split('/').slice(1).join('/'))
    let page
    let y
    let pageNumber = 0
    const addPage = () => {
      page = pdf.addPage([pageSize.width, pageSize.height])
      pageNumber += 1
      page.drawText(toPdfSafeText(groupTitle.toUpperCase(), boldFont), {
        x: 54, y: pageSize.height - 50, font: boldFont, size: 10, color: rgb(0.35, 0.35, 0.35),
      })
      page.drawText(toPdfSafeText(pageNumber === 1 ? title : title + ' (continued)', boldFont), {
        x: 54, y: pageSize.height - 80, font: boldFont, size: 15,
      })
      y = pageSize.height - 112
    }
    addPage()
    for (const field of getFillablePortfolioFields(entry.content)) {
      const label = field.kind === 'note' ? field.label + ' (website attachment)' : field.label
      const lines = wrap(field.value, pageSize.width - 128, 9)
      const labelLines = wrap(label, pageSize.width - 128, 8.5)
      let offset = 0
      while (offset < lines.length) {
        const room = Math.max(1, Math.floor((y - 68 - labelLines.length * 11 - 12) / 12))
        const count = Math.min(room, lines.length - offset)
        const boxHeight = labelLines.length * 11 + count * 12 + 16
        if (boxHeight > y - 55) { addPage(); continue }
        page.drawRectangle({ x: 54, y: y - boxHeight, width: pageSize.width - 108, height: boxHeight, borderColor: rgb(0.5, 0.5, 0.5), borderWidth: 0.6 })
        let textY = y - 14
        labelLines.forEach((line) => {
          page.drawText(line, { x: 62, y: textY, font: boldFont, size: 8.5 })
          textY -= 11
        })
        lines.slice(offset, offset + count).forEach((line) => {
          page.drawText(line, { x: 62, y: textY, font, size: 9 })
          textY -= 12
        })
        y -= boxHeight + 10
        offset += count
        if (offset < lines.length) addPage()
      }
    }
    for (const imageInfo of collectImages(entry.content)) {
      let imageUrl = imageInfo.path
      if (!/^https?:\/\//i.test(imageUrl) && !/^data:image\//i.test(imageUrl)) {
        const { data: signed, error } = await supabase.storage.from('portfolio-files').createSignedUrl(imageUrl, 3600)
        if (error) throw error
        imageUrl = signed.signedUrl
      }
      const response = await fetch(imageUrl)
      if (!response.ok) throw new Error('A saved portfolio image could not be loaded for an extra PDF page.')
      const bitmap = await createImageBitmap(await response.blob())
      const bounds = { x: 72, y: 100, width: pageSize.width - 144, height: pageSize.height - 230 }
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(bounds.width * 2)
      canvas.height = Math.round(bounds.height * 2)
      const context = canvas.getContext('2d')
      if (!context) throw new Error('A saved portfolio image could not be prepared for an extra PDF page.')
      const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height)
      const width = bitmap.width * scale
      const height = bitmap.height * scale
      context.drawImage(bitmap, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height)
      bitmap.close()
      const png = await new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('A saved portfolio image could not be prepared for an extra PDF page.')), 'image/png'))
      const image = await pdf.embedPng(new Uint8Array(await png.arrayBuffer()))
      addPage()
      page.drawText(toPdfSafeText(imageInfo.label, boldFont), { x: 54, y: pageSize.height - 112, font: boldFont, size: 10 })
      page.drawImage(image, bounds)
    }
  }
}


async function appendPortfolioExportValue(parent, label, value, context = '') {
  if (value === null || value === undefined || value === '') return

  const fieldPath = [context, label].filter(Boolean).join('/')

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      await appendPortfolioExportValue(
        parent,
        `${label} ${index + 1}`,
        item,
        fieldPath
      )
    }
    return
  }

  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      await appendPortfolioExportValue(parent, key, item, fieldPath)
    }
    return
  }

  const isImageField =
    typeof value === 'string' &&
    /(?:photo|image|picture|gallery)/i.test(fieldPath) &&
    (
      /(?:path|photo|image|picture|url)$/i.test(label) ||
      (
        label === 'Answer' &&
        /(?:student.*photo|gallery|pictures?)/i.test(context)
      )
    )

  const row = document.createElement('div')
  row.className = 'portfolio-export-answer'

  if (isImageField) {
    const image = document.createElement('img')
    image.className = 'portfolio-export-upload'
    image.alt = formatPortfolioLabel(label)

    const imageValue = value.trim()

    if (/^data:image\//i.test(imageValue)) {
      image.src = imageValue
    } else {
      let imageUrl = imageValue

      if (!/^https?:\/\//i.test(imageValue)) {
        const { data, error } = await supabase.storage
          .from('portfolio-files')
          .createSignedUrl(imageValue, 3600)

        if (error) throw error
        imageUrl = data.signedUrl
      }

      image.src = await fetchImageAsDataUrl(imageUrl)
    }

    row.append(image)
    parent.append(row)
    return
  }

  const title = document.createElement('strong')
  title.textContent = `${formatPortfolioLabel(label)}: `

  const answer = document.createElement('span')
  answer.textContent = String(value)

  row.append(title, answer)
  parent.append(row)
}


async function fetchImageAsDataUrl(url) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Could not load an image for the portfolio PDF (${response.status}).`)
  }
  const blob = await response.blob()
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('Could not prepare a portfolio image for the PDF.'))
    reader.readAsDataURL(blob)
  })
}

function getFillablePortfolioFields(content, prefix = '', depth = 0) {
  if (depth > 8 || content === null || content === undefined || content === '') return []

  if (Array.isArray(content)) {
    return content.flatMap((item, index) =>
      getFillablePortfolioFields(item, `${prefix} ${index + 1}`.trim(), depth + 1)
    )
  }

  if (typeof content === 'object') {
    return Object.entries(content).flatMap(([key, value]) => {
      const label = prefix ? `${prefix} / ${formatPortfolioLabel(key)}` : formatPortfolioLabel(key)
      if (/(?:path|image|photo)$/i.test(key) && value !== null && value !== undefined) {
        return [{ label, value: 'Attach this photo or image separately.', kind: 'note' }]
      }
      return getFillablePortfolioFields(value, label, depth + 1)
    })
  }

  if (/(?:path|image|photo)$/i.test(prefix)) {
    return [{ label: formatPortfolioLabel(prefix), value: 'Attach this photo or image separately.', kind: 'note' }]
  }

  return [{
    label: prefix || 'Answer',
    value: String(content),
    kind: typeof content === 'boolean' ? 'checkbox' : 'text',
  }]
}

function toPdfSafeText(value, font) {
  return Array.from(String(value), (character) => {
    try {
      font.encodeText(character)
      return character
    } catch {
      return '?'
    }
  }).join('')
}

function drawPdfWrappedText(page, text, { x, y, maxWidth, font, fontSize, lineHeight }) {
  const words = String(text).split(/\s+/)
  let line = ''
  let currentY = y

  for (const word of words) {
    let remainingWord = word
    while (remainingWord && font.widthOfTextAtSize(remainingWord, fontSize) > maxWidth) {
      if (line) {
        page.drawText(line, { x, y: currentY, font, size: fontSize })
        currentY -= lineHeight
        line = ''
      }
      let splitAt = remainingWord.length
      while (splitAt > 1 && font.widthOfTextAtSize(remainingWord.slice(0, splitAt), fontSize) > maxWidth) splitAt -= 1
      page.drawText(remainingWord.slice(0, splitAt), { x, y: currentY, font, size: fontSize })
      currentY -= lineHeight
      remainingWord = remainingWord.slice(splitAt)
    }
    if (!remainingWord) continue
    const candidate = line ? `${line} ${remainingWord}` : remainingWord
    if (line && font.widthOfTextAtSize(candidate, fontSize) > maxWidth) {
      page.drawText(line, { x, y: currentY, font, size: fontSize })
      currentY -= lineHeight
      line = word
    } else {
      line = candidate
    }
  }

  if (line) {
    page.drawText(line, { x, y: currentY, font, size: fontSize })
    currentY -= lineHeight
  }
  return currentY
}

async function createFillablePortfolioPdf(user, groupTitle) {
  const userId = user?.id
  const { data, error } = await supabase
    .from('portfolio_entries')
    .select('section,content')
    .eq('user_id', userId)
    .order('section')
  if (error) throw error

  const { PDFDocument, StandardFonts, PageSizes, TextAlignment, rgb } = await import('pdf-lib')
  const entries = (data || []).map((entry) => ({
    ...entry,
    content: normalizePortfolioExportContent(entry.content),
  }))
  const pages = getPortfolioExportPages(entries, [groupTitle])

  if (groupTitle === 'Module Introduction') {
    const templateResponse = await fetch(`${import.meta.env.BASE_URL}module-introduction-template.pdf`)
    if (!templateResponse.ok) {
      throw new Error('The Module Introduction PDF template could not be loaded.')
    }

    const pdf = await PDFDocument.load(await templateResponse.arrayBuffer())
    const form = pdf.getForm()
    const regularFont = await pdf.embedFont(StandardFonts.TimesRoman)
    const boldFont = await pdf.embedFont(StandardFonts.TimesRomanBold)
    const textFont = await pdf.embedFont(StandardFonts.Helvetica)
    const sourcePages = pdf.getPages()
    const coverPageInfo = pages.find((page) => page.title === 'Cover Page')
    const coverData = coverPageInfo?.savedContent || {}
    const getWebsiteValue = (key, profileKey = key) => String(
      coverData[key] ?? user?.[profileKey] ?? ''
    )
    const fitFontSize = (value, font, size, maxWidth, minimum = 8) => {
      let fittedSize = size
      while (fittedSize > minimum && font.widthOfTextAtSize(value, fittedSize) > maxWidth) {
        fittedSize -= 0.5
      }
      return fittedSize
    }
    const addTemplateField = (
      name,
      value,
      pageIndex,
      bounds,
      { font = regularFont, fontSize = 10, centered = true, replacePrintedText = false } = {},
    ) => {
      const safeValue = toPdfSafeText(value || '', font)
      const field = form.createTextField(name)
      if (safeValue) field.setText(safeValue)
      if (centered) field.setAlignment(TextAlignment.Center)
      field.addToPage(sourcePages[pageIndex], {
        ...bounds,
        borderWidth: 0,
        borderColor: rgb(1, 1, 1),
        backgroundColor: rgb(1, 1, 1),
        font,
        fontSize: fitFontSize(safeValue, font, fontSize, Math.max(24, bounds.width - 10)),
      })
      field.setFontSize(fitFontSize(safeValue, font, fontSize, Math.max(24, bounds.width - 10)))
      field.updateAppearances(font)
      return field
    }
    const placeSavedImage = async (path, pageIndex, bounds) => {
      if (!path) return
      const { data: signedImage, error: signedImageError } = await supabase.storage
        .from('portfolio-files')
        .createSignedUrl(path, 3600)
      if (signedImageError) throw signedImageError

      const response = await fetch(signedImage.signedUrl)
      if (!response.ok) throw new Error('A saved portfolio photo could not be loaded.')
      const bitmap = await createImageBitmap(await response.blob())
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(bounds.width * 2)
      canvas.height = Math.round(bounds.height * 2)
      const context = canvas.getContext('2d')
      if (!context) throw new Error('A saved portfolio photo could not be prepared.')
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height)
      const imageWidth = bitmap.width * scale
      const imageHeight = bitmap.height * scale
      context.drawImage(bitmap, (canvas.width - imageWidth) / 2, (canvas.height - imageHeight) / 2, imageWidth, imageHeight)
      bitmap.close()
      const png = await new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob) resolve(blob)
          else reject(new Error('A saved portfolio photo could not be prepared.'))
        }, 'image/png')
      })
      const image = await pdf.embedPng(new Uint8Array(await png.arrayBuffer()))
      sourcePages[pageIndex].drawImage(image, bounds)
    }
    const addDateToCell = (page, dateValue, x, y, width = 77) => {
      if (!dateValue) return
      const [year, month, day] = String(dateValue).split('-')
      const dateText = year && month && day ? `${month}/${day}/${year}` : String(dateValue)
      const fontSize = 8
      const textWidth = textFont.widthOfTextAtSize(dateText, fontSize)
      page.drawText(dateText, {
        x: x + Math.max(2, (width - textWidth) / 2),
        y,
        font: textFont,
        size: fontSize,
      })
    }
    const drawWrappedParagraph = (page, text, {
      x,
      y,
      maxWidth,
      font,
      fontSize,
      lineHeight,
      firstLineIndent = 0,
    }) => {
      const words = String(text).split(/\s+/).filter(Boolean)
      let line = ''
      let currentY = y
      let firstLine = true
      const drawLine = () => {
        if (!line) return
        page.drawText(toPdfSafeText(line, font), {
          x: x + (firstLine ? firstLineIndent : 0),
          y: currentY,
          font,
          size: fontSize,
        })
        currentY -= lineHeight
        firstLine = false
        line = ''
      }
      words.forEach((word) => {
        const candidate = line ? `${line} ${word}` : word
        const availableWidth = maxWidth - (firstLine ? firstLineIndent : 0)
        if (line && font.widthOfTextAtSize(candidate, fontSize) > availableWidth) drawLine()
        line = line ? `${line} ${word}` : word
      })
      drawLine()
      return currentY
    }

    // Preserve the source document's six Module Introduction pages.
    for (let pageIndex = pdf.getPageCount() - 1; pageIndex >= 6; pageIndex -= 1) {
      pdf.removePage(pageIndex)
    }

    const studentName = getWebsiteValue('student_name', 'full_name')
    addTemplateField('module_intro_student_name_cover', studentName, 0, {
      x: 423, y: 233, width: 172, height: 16,
    }, { fontSize: 12 })
    addTemplateField('module_intro_student_address', getWebsiteValue('address'), 0, {
      x: 435, y: 206, width: 160, height: 16,
    }, { fontSize: 12 })

    const informationRows = [
      { key: 'track', value: getWebsiteValue('track'), bounds: { x: 92, y: 407, width: 428, height: 20 }, size: 14 },
      { key: 'strand', value: getWebsiteValue('strand'), bounds: { x: 92, y: 366, width: 428, height: 20 }, size: 14 },
      { key: 'specialization', value: getWebsiteValue('specialization'), bounds: { x: 92, y: 325, width: 428, height: 20 }, size: 14 },
    ]
    informationRows.forEach(({ key, value, bounds, size }) => {
      addTemplateField(`module_intro_${key}`, value, 1, bounds, {
        font: boldFont,
        fontSize: size,
        centered: true,
        replacePrintedText: true,
      })
    })
    const schoolName = String(
      coverData.school_name ?? user?.school ?? 'Western Cagayan School of Arts and Trades'
    )
    addTemplateField('module_intro_school_name', schoolName.toUpperCase(), 1, {
      x: 92, y: 252, width: 428, height: 20,
    }, { font: boldFont, fontSize: 18, centered: true, replacePrintedText: true })
    addTemplateField('module_intro_student_name_information', studentName, 1, {
      x: 75, y: 284, width: 462, height: 20,
    }, { font: boldFont, fontSize: 14 })

    const objectivesPage = sourcePages[2]
    objectivesPage.drawRectangle({ x: 0, y: 700, width: 612, height: 216, color: rgb(1, 1, 1) })
    let objectivesY = 902
    const objectiveParagraphs = [
      'One of the goals of the K to 12 Basic Education Program is for you to develop the competencies, work ethics, and values relevant in pursuing further education and/or joining the world of work.',
      "To become a productive citizen who contributes to our nation's development, Work Immersion is a required Senior High School subject that provides these opportunities:",
    ]
    objectiveParagraphs.forEach((paragraph) => {
      objectivesY = drawWrappedParagraph(objectivesPage, paragraph, {
        x: 72, y: objectivesY, maxWidth: 468, font: textFont, fontSize: 11.5, lineHeight: 14, firstLineIndent: 36,
      }) - 8
    })
    ;[
      '1. Become familiar with the workplace;',
      '2. Experience employment simulation; and',
      '3. Apply your Computer Systems Servicing competencies in an authentic work environment.',
    ].forEach((item) => {
      objectivesY = drawWrappedParagraph(objectivesPage, item, {
        x: 132, y: objectivesY, maxWidth: 408, font: textFont, fontSize: 11.5, lineHeight: 14,
      }) - 2
    })
    objectivesY -= 12
    drawWrappedParagraph(objectivesPage,
      'To achieve the above objectives, Work Immersion is a requirement for graduation from secondary education. Learners complete school-based work immersion simulation and home-based activities, then submit and present a portfolio to a panel at the end of the subject.',
      { x: 72, y: objectivesY, maxWidth: 468, font: textFont, fontSize: 11.5, lineHeight: 14, firstLineIndent: 36 },
    )

    const studentPhotoPath = entries.find((entry) => (
      entry.section === 'Module Introduction/Student 2x2 Photo'
    ))?.content
    await placeSavedImage(studentPhotoPath, 0, {
      x: 429, y: 291, width: 117, height: 117,
    })

    const { data: teacherData, error: teacherError } = await supabase
      .from('immersion_teacher')
      .select('teacher_name,teacher_email,teacher_phone,teacher_group_chat,teacher_messenger,teacher_photo_url')
      .eq('id', 1)
      .maybeSingle()
    if (teacherError) throw teacherError

    if (teacherData) {
      const teacherFields = [
        { name: 'module_intro_teacher_email', value: teacherData.teacher_email, x: 308, y: 704, width: 208 },
        { name: 'module_intro_teacher_phone', value: teacherData.teacher_phone, x: 261, y: 690, width: 255 },
        { name: 'module_intro_teacher_group_chat', value: teacherData.teacher_group_chat, x: 295, y: 676, width: 221 },
        { name: 'module_intro_teacher_messenger', value: teacherData.teacher_messenger, x: 292, y: 662, width: 224 },
      ]
      teacherFields.forEach(({ name, value, x, y, width }) => {
        addTemplateField(name, String(value || ''), 3, {
          x, y: y + 2, width, height: 18,
        }, { font: textFont, fontSize: 10, replacePrintedText: true })
      })
      addTemplateField(
        'module_intro_teacher_name_instructions',
        teacherData.teacher_name ? `${String(teacherData.teacher_name).replace(/\)$/, '')})` : '',
        3,
        { x: 351, y: 575, width: 110, height: 17 },
        { font: textFont, fontSize: 9, replacePrintedText: true },
      )
      if (teacherData.teacher_photo_url) {
        await placeSavedImage(teacherData.teacher_photo_url, 3, {
          x: 108, y: 645, width: 110.3, height: 113.8,
        })
      } else {
        sourcePages[3].drawRectangle({
          x: 108, y: 645, width: 110.3, height: 113.8, color: rgb(1, 1, 1),
        })
      }
    }

    const dutiesEntry = entries.find((entry) => (
      entry.section === 'Module Introduction/Student Duties Photo'
    ))
    const dutiesPhotoPath = dutiesEntry?.content?.photo_path
    const dutiesPage = sourcePages[4]
    const dutiesTitle = 'STUDENT DUTIES AND RESPONSIBILITIES'
    const dutiesTitleSize = 14
    const dutiesTitleWidth = boldFont.widthOfTextAtSize(dutiesTitle, dutiesTitleSize)
    dutiesPage.drawRectangle({ x: 0, y: 0, width: 612, height: 918, color: rgb(1, 1, 1) })
    dutiesPage.drawRectangle({ x: 0, y: 918, width: 612, height: 18, color: rgb(1, 1, 1) })
    dutiesPage.drawRectangle({ x: 72, y: 919, width: dutiesTitleWidth + 4, height: 17, color: rgb(1, 0.97, 0.2) })
    dutiesPage.drawText(dutiesTitle, {
      x: 72,
      y: 922,
      font: boldFont,
      size: dutiesTitleSize,
      color: rgb(0.06, 0.24, 0.85),
    })
    dutiesPage.drawText('Remember to:', {
      x: 72,
      y: 888,
      font: boldFont,
      size: 12,
      color: rgb(0, 0, 0),
    })
    const duties = [
      'Work through all the information and complete the activities in each section.',
      'Coordinate with your Work Immersion Teacher to supervise you at the school-based work simulation immersion venue in coordination with your schedule of school-based and home-based activities. He is there to support you and show you the correct way to do things.',
      'While in school or assigned community treat it as you are in a workplace. You will be given plenty of opportunities to ask questions and practice on the job. Make sure you practice your new skills during regular work shifts. This way, you will improve your speed, memory and your confidence.',
      'When you feel confident that you have had enough practice, ask your Immersion Teacher to evaluate you. The results of your evaluation will be recorded and will be part of your grade.',
      'Submit accomplished portfolio to your immersion teacher for checking and as reference for the issuance of your certificate of completion.',
    ]
    let dutiesY = 865
    duties.forEach((duty) => {
      dutiesPage.drawCircle({ x: 80, y: dutiesY + 3, size: 1.7, color: rgb(0, 0, 0) })
      dutiesY = drawWrappedParagraph(dutiesPage, duty, {
        x: 90, y: dutiesY, maxWidth: 448, font: textFont, fontSize: 11.5, lineHeight: 14,
      }) - 7
    })
    await placeSavedImage(dutiesPhotoPath, 4, {
      x: 72, y: Math.max(120, dutiesY - 130), width: 180, height: 120,
    })

    const howToEntry = entries.find((entry) => (
      entry.section === 'Module Introduction/How to Use This Work Immersion Module'
    ))
    const howToData = howToEntry?.content || {}
    const savedHowToText = typeof howToData?.text === 'string' ? howToData.text : ''
    const defaultHowToText = "This Work Immersion Learner's Manual in times of pandemic contains materials and activities related to developing your skills and knowledge required to gain relevant and practical industrial skills under the guidance of your immersion teacher. It will guide you through the accomplishment of the different documents and in accomplishing your immersion portfolio.\n\nIn this module, you are required to accomplish all the learner's output and submit the required documents. You must follow and perform the activities on your own. If you have questions, do not hesitate to ask for assistance from your immersion teacher with the following details."
    const normalizeForCompare = (value) => String(value).toLowerCase().replace(/[^a-z0-9]/g, '')
    if (typeof howToData?.text === 'string' && normalizeForCompare(savedHowToText) !== normalizeForCompare(defaultHowToText)) {
      const page = sourcePages[3]
      page.drawRectangle({ x: 0, y: 761, width: 612, height: 121, color: rgb(1, 1, 1) })
      const paragraphs = savedHowToText.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean)
      let fontSize = 12
      const buildLines = (text, size) => text.split(/\s+/).reduce((paragraphLines, word) => {
        const line = paragraphLines[paragraphLines.length - 1]
        const indent = paragraphLines.length === 1 ? 36 : 0
        const maxWidth = 468 - indent
        const candidate = line ? `${line} ${word}` : word
        if (line && textFont.widthOfTextAtSize(candidate, size) > maxWidth) paragraphLines.push(word)
        else paragraphLines[paragraphLines.length - 1] = candidate
        return paragraphLines
      }, [''])
      let wrappedParagraphs = paragraphs.map((paragraph) => buildLines(paragraph, fontSize))
      const countLines = () => wrappedParagraphs.reduce((sum, lines) => sum + lines.length, 0)
      while (fontSize > 8.5 && countLines() * fontSize * 1.15 + (paragraphs.length - 1) * 12 > 112) {
        fontSize -= 0.5
        wrappedParagraphs = paragraphs.map((paragraph) => buildLines(paragraph, fontSize))
      }
      let y = 868
      wrappedParagraphs.forEach((lines, paragraphIndex) => {
        lines.forEach((line, lineIndex) => {
          const indent = lineIndex === 0 ? 36 : 0
          page.drawText(toPdfSafeText(line, textFont), {
            x: 72 + indent,
            y,
            font: textFont,
            size: fontSize,
          })
          y -= fontSize * 1.15
        })
        if (paragraphIndex < wrappedParagraphs.length - 1) y -= 12
      })
    }

    const checklistEntry = entries.find((entry) => (
      entry.section === 'Module Introduction/Portfolio Checklist'
    ))
    const checklistDates = checklistEntry?.content?.dates || {}
    const checklistPage = sourcePages[5]
    const dateColumnX = 461.7
    const dateRows = [
      { key: 'Pre-immersion-0', y: 861 },
      { key: 'Pre-immersion-1', y: 840 },
      { key: 'Pre-immersion-2', y: 818 },
      { key: 'Pre-immersion-3', y: 750 },
      { key: 'Immersion Proper-0', y: 647 },
      { key: 'Immersion Proper-1', y: 593 },
      { key: 'Immersion Proper-2', y: 546 },
      { key: 'Immersion Proper-3', y: 482 },
      { key: 'Immersion Proper-4', y: 425 },
      { key: 'Post Immersion-0', y: 403 },
      { key: 'Post Immersion-1', y: 389 },
      { key: 'Post Immersion-2', y: 375 },
      { key: 'Post Immersion-3', y: 361 },
      { key: 'Post Immersion-4', y: 346 },
      { key: 'Post Immersion-5', y: 324 },
      { key: 'Post Immersion-6', y: 293 },
      { key: 'Post Immersion-7', y: 264 },
      { key: 'Post Immersion-8', y: 230 },
    ]
    dateRows.forEach(({ key, y }) => addDateToCell(checklistPage, checklistDates[key], dateColumnX, y))

    await appendPortfolioSupplementPages(pdf, entries, groupTitle, new Set([
      'Module Introduction/Cover Page',
      'Module Introduction/How to Use This Work Immersion Module',
      'Module Introduction/Student Duties Photo',
      'Module Introduction/Portfolio Checklist',
    ]), textFont, boldFont)
    return await pdf.save()
  }

  const templateFiles = {
    'Pre-Immersion': 'pre-immersion-template.pdf',
    'Immersion Proper': 'immersion-proper-template.pdf',
    'Post-Immersion': 'post-immersion-template.pdf',
  }
  const templateFile = templateFiles[groupTitle]
  if (templateFile) {
    const templateResponse = await fetch(`${import.meta.env.BASE_URL}${templateFile}`)
    if (!templateResponse.ok) {
      throw new Error(`The ${groupTitle} PDF template could not be loaded.`)
    }

    const templateBytes = await templateResponse.arrayBuffer()
    const pdf = await PDFDocument.load(templateBytes)
    const templateSource = await PDFDocument.load(templateBytes)
    if (groupTitle === 'Immersion Proper') {
      while (pdf.getPageCount() > 8) {
        pdf.removePage(pdf.getPageCount() - 1)
      }
      pdf.removePage(4)
      pdf.removePage(2)
    }
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold)
    const form = pdf.getForm()
    let sourcePages = pdf.getPages()
    const group = PORTFOLIO_PROGRESS_GROUPS.find((item) => item.title === groupTitle)
    const entryContent = (section) => entries.find((entry) => entry.section === section)?.content || {}
    let templateFieldNumber = 0
    const drawValue = (pageIndex, value, x, y, width, { size = 9, lineHeight = 12, maxLines = 20, page: targetPage, centered = true } = {}) => {
      const page = targetPage || sourcePages[pageIndex]
      if (!value || !page) return y
      const field = form.createTextField(`portfolio_template_${++templateFieldNumber}`)
      field.setText(toPdfSafeText(String(value).replace(/\s+/g, ' ').trim(), font))
      if (centered) field.setAlignment(TextAlignment.Center)
      let fontSize = size
      const safeValue = toPdfSafeText(String(value).replace(/\s+/g, ' ').trim(), font)
      while (fontSize > 5 && font.widthOfTextAtSize(safeValue, fontSize) > width - 4) fontSize -= 0.5
      field.addToPage(page, {
        // Keep the white field shallow so it sits on the printed writing line
        // without blanking the line across the whole answer area.
        x, y: y - 1, width, height: Math.max(9, fontSize + 1),
        borderWidth: 0,
        borderColor: rgb(1, 1, 1),
        backgroundColor: rgb(1, 1, 1),
        font,
        fontSize,
      })
      field.setFontSize(fontSize)
      field.updateAppearances(font)
      return y - lineHeight
    }
    const drawParagraph = (startPage, value, x, y, width, { size = 9, lineHeight = 13 } = {}) => {
      if (!value) return
      let pageIndex = startPage
      let line = ''
      const flushLine = () => {
        if (!line || !sourcePages[pageIndex]) return
        sourcePages[pageIndex].drawText(line, { x, y, font, size })
        y -= lineHeight
        line = ''
        if (y < 90 && pageIndex + 1 < sourcePages.length) {
          pageIndex += 1
          y = 890
        }
      }
      for (const word of toPdfSafeText(String(value), font).split(/\s+/).filter(Boolean)) {
        let remainingWord = word
        while (remainingWord && font.widthOfTextAtSize(remainingWord, size) > width) {
          if (line) flushLine()
          let splitAt = remainingWord.length
          while (splitAt > 1 && font.widthOfTextAtSize(remainingWord.slice(0, splitAt), size) > width) splitAt -= 1
          line = remainingWord.slice(0, splitAt)
          flushLine()
          remainingWord = remainingWord.slice(splitAt)
        }
        if (!remainingWord) continue
        const candidate = line ? `${line} ${remainingWord}` : remainingWord
        if (line && font.widthOfTextAtSize(candidate, size) > width) flushLine()
        line = line ? `${line} ${remainingWord}` : remainingWord
      }
      flushLine()
    }
    const drawTextBox = (pageIndex, value, bounds, size = 8) => {
      if (!value || !sourcePages[pageIndex]) return
      const field = form.createTextField(`portfolio_template_${++templateFieldNumber}`)
      field.enableMultiline()
      field.setText(toPdfSafeText(String(value), font))
      field.addToPage(sourcePages[pageIndex], {
        ...bounds,
        borderWidth: 0,
        borderColor: rgb(1, 1, 1),
        font,
        fontSize: size,
      })
      field.setFontSize(size)
      field.updateAppearances(font)
    }
    const drawParagraphBox = (pageIndex, value, bounds, { size = 8, lineHeight = 11, page: targetPage } = {}) => {
      const page = targetPage || sourcePages[pageIndex]
      if (!value || !page) return
      const words = toPdfSafeText(String(value), font).split(/\s+/).filter(Boolean)
      const maxLines = Math.max(1, Math.floor(bounds.height / lineHeight))
      const wrap = (fontSize) => {
        const lines = []
        let line = ''
        const pushLine = () => {
          if (line) lines.push(line)
          line = ''
        }
        for (let word of words) {
          while (word && font.widthOfTextAtSize(word, fontSize) > bounds.width) {
            pushLine()
            let splitAt = word.length
            while (splitAt > 1 && font.widthOfTextAtSize(word.slice(0, splitAt), fontSize) > bounds.width) splitAt -= 1
            lines.push(word.slice(0, splitAt))
            word = word.slice(splitAt)
          }
          if (!word) continue
          const candidate = line ? `${line} ${word}` : word
          if (line && font.widthOfTextAtSize(candidate, fontSize) > bounds.width) pushLine()
          line = line ? `${line} ${word}` : word
        }
        pushLine()
        return lines
      }
      let fontSize = size
      let lines = wrap(fontSize)
      while (fontSize > 4 && lines.length > maxLines) {
        fontSize = Math.max(4, fontSize - 0.5)
        lines = wrap(fontSize)
      }
      const yStart = bounds.y + bounds.height - lineHeight
      lines.slice(0, maxLines).forEach((line, index) => {
        page.drawText(line, {
          x: bounds.x,
          y: yStart - index * lineHeight,
          font,
          size: fontSize,
        })
      })
    }
    const drawSavedImage = async (path, pageIndex, bounds, targetPage) => {
      const page = targetPage || sourcePages[pageIndex]
      if (!path || !page) return
      const { data: signed, error: signedError } = await supabase.storage.from('portfolio-files').createSignedUrl(path, 3600)
      if (signedError) throw signedError
      const response = await fetch(signed.signedUrl)
      if (!response.ok) throw new Error('A saved portfolio image could not be loaded for the PDF.')
      const bitmap = await createImageBitmap(await response.blob())
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(bounds.width * 2)
      canvas.height = Math.round(bounds.height * 2)
      const context = canvas.getContext('2d')
      if (!context) throw new Error('A saved portfolio image could not be prepared for the PDF.')
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height)
      const imageWidth = bitmap.width * scale
      const imageHeight = bitmap.height * scale
      context.drawImage(bitmap, (canvas.width - imageWidth) / 2, (canvas.height - imageHeight) / 2, imageWidth, imageHeight)
      bitmap.close()
      const png = await new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('A saved portfolio image could not be prepared for the PDF.')), 'image/png'))
      const image = await pdf.embedPng(new Uint8Array(await png.arrayBuffer()))
      page.drawImage(image, bounds)
    }
    const profile = user || {}
    const checklist = entryContent('Pre-Immersion/Requirements Checklist')
    if (groupTitle === 'Pre-Immersion') {
      const pendingImages = []
      const clearSample = (pageIndex, x, y, width, height = 14) => sourcePages[pageIndex].drawRectangle({
        x, y, width, height, color: rgb(1, 1, 1),
      })
      // These fields contain sample answers in the supplied workbook PDF.
      // Clear only the answer area while retaining its printed labels and lines.
      ;[710, 696, 682, 668, 654, 640, 626, 612, 583].forEach((y) => clearSample(7, 148, y, 260, 14))
      clearSample(7, 149, 483, 390, 15)
      clearSample(7, 149, 441, 390, 15)
      ;[378, 349, 320].forEach((y) => clearSample(7, 102, y, 430, 15))
      const d = checklist.details || {}
      const detailFields = [
        ['studentName', 0, 148, 896, 205], ['gradeSection', 0, 440, 896, 130],
        ['track', 0, 106, 881, 75], ['strand', 0, 225, 881, 120], ['specialization', 0, 430, 881, 145],
        ['studentContact', 0, 135, 866, 220], ['lrn', 0, 402, 866, 165],
        ['parentGuardian', 0, 157, 850, 190], ['parentContact', 0, 430, 850, 145],
        ['classAdviser', 0, 145, 834, 195], ['adviserContact', 0, 430, 834, 145],
        ['immersionTeacher', 0, 202, 818, 170], ['teacherContact', 0, 432, 818, 145],
      ]
      for (const [key, page, x, y, width] of detailFields) drawValue(page, d[key] || (key === 'studentName' ? profile.full_name : ''), x, y, width, { size: 8 })
      const requirementLabels = [
        'Resume in prescribed format', 'Parents’ / Guardians’ Consent', 'List of Task/Activities',
        'Photocopy of the school ID', 'Photocopy of Insurance', 'Pre-Immersion Orientation', 'Initial Interview',
      ]
      requirementLabels.forEach((label, row) => {
        const y = 750 - row * 15
        const values = checklist.requirements || {}
        const read = (field) => values[`checklist-${label}-${field}`] ?? values[`${label}-${field}`]
        drawValue(0, read('date'), 270, y, 58, { size: 6 })
        if (read('remarks')) sourcePages[0].drawText('x', { x: 340, y, font, size: 8 })
        drawValue(0, read('inCharge'), 397, y, 72, { size: 6 })
        drawValue(0, read('signature'), 493, y, 84, { size: 6 })
      })
      const schedule = entryContent('Pre-Immersion/Class Schedule')
      const scheduleXs = [82, 178, 222, 305, 351, 394]
      const scheduleWidths = [92, 42, 80, 42, 40, 46]
      for (let row = 0; row < 10; row += 1) {
        const y = 513 - row * 15
        scheduleXs.forEach((x, column) => drawValue(0, schedule[`class-${row}-${column}`], x, y, scheduleWidths[column], { size: 6.5 }))
        drawValue(0, schedule[`immersion-time-${row}`], 536, y, 58, { size: 6.5 })
      }
      const essay = entryContent('Pre-Immersion/Essay on Workplace Conduct')
      drawValue(5, essay.title, 180, 920, 260, { size: 9, centered: true })
      drawParagraphBox(5, essay.essay, { x: 75, y: 330, width: 465, height: 555 }, { size: 7, lineHeight: 20 })
      const letter = entryContent('Pre-Immersion/Application Letter')
      const dateMatch = String(letter.date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
      const displayDate = dateMatch
        ? new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3])).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
        : letter.date
      sourcePages[6].drawRectangle({ x: 70, y: 726, width: 165, height: 18, color: rgb(1, 1, 1) })
      drawValue(6, displayDate, 74, 730, 240, { size: 9 })
      drawParagraphBox(6, letter.letter, { x: 74, y: 345, width: 465, height: 270 }, { size: 7, lineHeight: 24 })
      drawValue(6, letter.signature, 74, 220, 300, { size: 9 })
      const tasks = entryContent('Pre-Immersion/List of Task')
      drawValue(2, tasks.studentName, 168, 892, 158, { size: 8 })
      drawValue(2, tasks.focalPerson, 168, 708, 158, { size: 8 })
      drawValue(2, tasks.focalPersonContact, 410, 708, 130, { size: 8 })
      drawValue(3, tasks.studentSignature, 80, 620, 210, { size: 8 })
      drawValue(3, tasks.parentSignature, 310, 620, 220, { size: 8 })
      drawValue(3, tasks.teacherSignature, 80, 585, 210, { size: 8 })
      drawValue(3, tasks.supervisorSignature, 310, 585, 220, { size: 8 })
      const taskRows = [
        'Assemble Computer Hardware', 'Prepare Installers', 'Install Operating System and Drivers', 'Install Application Softwares',
        'Install Network Cables', 'Set-up Network Configuration', 'Set router WIFI or wireless access point', 'Set-up user access',
        'Configure network services', 'Perform Testing, documentation and pre deployment procedure', 'Plan and Prepare maintenance and repair',
        'Maintain computer systems and networks', 'Diagnose faults of computer system and networks', 'Rectify/ correct defects in computer system and networks',
      ]
      const taskRowPositions = [
        [2, 559], [2, 524], [2, 481], [2, 433], [2, 391], [2, 349], [2, 305],
        [2, 262], [2, 220], [2, 160], [2, 98], [3, 900], [3, 850], [3, 785],
      ]
      taskRows.forEach((competency, row) => {
        // This row is already printed as a fixed sample in both the website
        // and the workbook template; old saved drafts must not cover it.
        if (competency === 'Install Application Softwares') return
        const [pageIndex, y] = taskRowPositions[row]
        for (const [field, x, width] of [['tasks', 150, 130], ['time', 284, 76], ['schedule', 362, 98], ['remarks', 460, 74]]) {
          const value = tasks[`${competency}-${field}`]
          if (value) drawValue(pageIndex, value, x, y, width, { size: 6.5, lineHeight: 8 })
        }
      })
      const resume = entryContent('Pre-Immersion/Resume')
      for (const [key, x, y, width] of [
        ['completeName', 360, 872, 185], ['address', 360, 858, 185], ['contact', 360, 844, 185],
        ['messenger', 360, 830, 185], ['careerObjective', 72, 745, 470],
        ['age', 150, 715, 80], ['dateOfBirth', 150, 701, 145], ['gender', 150, 687, 100],
        ['civilStatus', 150, 673, 100], ['citizenship', 150, 659, 120], ['height', 150, 645, 90],
        ['weight', 150, 631, 90], ['religion', 150, 617, 150], ['father', 150, 603, 180], ['mother', 150, 589, 180],
        ['secondary', 150, 491, 380], ['primary', 150, 449, 380], ['eligibility-0', 105, 378, 300],
        ['eligibility-1', 105, 349, 300], ['eligibility-2', 105, 320, 300],
        ['workExperience-0', 105, 235, 300], ['workExperience-1', 105, 206, 300], ['workExperience-2', 105, 177, 300],
        ['seminars-0', 105, 106, 300], ['seminars-1', 105, 78, 300],
      ]) drawValue(7, resume[key], x, y, width, { size: 8 })
      for (const [key, y] of [['seminars-2', 909], ['skills-0', 839], ['skills-1', 810], ['skills-2', 782], ['references-0', 711], ['references-1', 682], ['references-2', 653]]) {
        drawValue(8, resume[key], 105, y, 300, { size: 8 })
      }
      drawValue(8, resume.signature, 74, 515, 180, { size: 8 })
      if (resume.photo_path) pendingImages.push(drawSavedImage(resume.photo_path, 7, { x: 75, y: 798, width: 165, height: 110 }))
      const consent = entryContent('Pre-Immersion/Parent Consent')
      if (consent.photo_path) {
        const consentAttachmentPage = pdf.addPage([sourcePages[1].getSize().width, sourcePages[1].getSize().height])
        consentAttachmentPage.drawText('PARENT CONSENT - UPLOADED COPY', {
          x: 72, y: sourcePages[1].getSize().height - 58, font: boldFont, size: 12,
        })
        pendingImages.push(drawSavedImage(consent.photo_path, 1, {
          x: 72, y: 100, width: 468, height: sourcePages[1].getSize().height - 200,
        }, consentAttachmentPage))
      }
      for (const title of ['Barangay Clearance', 'Police Clearance', 'Mayors Clearance', 'Health Clearance']) {
        const entry = entryContent(`Pre-Immersion/${title}`)
        const index = { 'Barangay Clearance': 9, 'Police Clearance': 10, 'Mayors Clearance': 11, 'Health Clearance': 12 }[title]
        ;(entry.steps || []).slice(0, 7).forEach((step, line) => drawValue(index, step, 108, 855 - line * 13, 250, { size: 8 }))
        drawValue(index, entry.prepared_by, 76, 190, 180, { size: 8 })
        const photoBounds = {
          'Barangay Clearance': { x: 72, y: 236, width: 486, height: 500 },
          'Police Clearance': { x: 72, y: 693, width: 486, height: 55 },
          'Mayors Clearance': { x: 72, y: 681, width: 486, height: 54 },
          'Health Clearance': { x: 72, y: 251, width: 486, height: 485 },
        }[title]
        if (entry.photo_path) {
          pendingImages.push(drawSavedImage(entry.photo_path, index, photoBounds))
          if (title === 'Police Clearance' || title === 'Mayors Clearance') {
            const { width, height } = sourcePages[index].getSize()
            const photoAttachmentPage = pdf.addPage([width, height])
            photoAttachmentPage.drawText(`${title.toUpperCase()} - PHOTO ATTACHMENT`, {
              x: 72, y: height - 58, font: boldFont, size: 12,
            })
            pendingImages.push(drawSavedImage(entry.photo_path, index, {
              x: 72, y: 100, width: width - 144, height: height - 200,
            }, photoAttachmentPage))
          }
        }
      }
      await Promise.all(pendingImages)
    } else if (groupTitle === 'Immersion Proper') {
      const pendingImages = []
      const narrative = entryContent('Immersion Proper/Narrative Report')
      drawValue(0, narrative.title, 155, 850, 340, { size: 9 })
      const narrativeLineYs = [883, 862, 842, 821, 800, 780, 759, 738, 718, 697, 676, 656, 635, 614, 594, 573, 552, 532, 511, 490, 470, 449, 428, 408, 387, 367, 346, 325]
      const narrativeFontSize = 8
      const narrativeTitle = toPdfSafeText(String(narrative.title || '').replace(/\s+/g, ' ').trim(), font)
      if (narrativeTitle) {
        const titleWidth = font.widthOfTextAtSize(narrativeTitle, narrativeFontSize)
        sourcePages[1].drawText(narrativeTitle, {
          x: 187 + (257 - titleWidth) / 2,
          y: 925,
          font,
          size: narrativeFontSize,
        })
      }
      const wrapNarrativeLines = (value, maxWidth) => {
        const safeText = toPdfSafeText(String(value || '').replace(/\s+/g, ' ').trim(), font)
        if (!safeText) return []
        const lines = []
        let line = ''
        const pushLine = () => {
          if (line) lines.push(line)
          line = ''
        }
        for (let word of safeText.split(' ')) {
          while (font.widthOfTextAtSize(word, narrativeFontSize) > maxWidth) {
            let splitAt = word.length
            while (splitAt > 1 && font.widthOfTextAtSize(word.slice(0, splitAt), narrativeFontSize) > maxWidth) splitAt -= 1
            const piece = word.slice(0, splitAt)
            word = word.slice(splitAt)
            if (line) pushLine()
            lines.push(piece)
          }
          if (!word) continue
          const candidate = line ? `${line} ${word}` : word
          if (line && font.widthOfTextAtSize(candidate, narrativeFontSize) > 465) pushLine()
          line = line ? `${line} ${word}` : word
        }
        pushLine()
        return lines
      }
      const narrativeLines = wrapNarrativeLines(narrative.report, 465)
      const drawNarrativePageLines = (page, lines) => {
        lines.forEach((line, index) => {
          page.drawText(line, {
            x: 74,
            y: narrativeLineYs[index] + 1,
            font,
            size: narrativeFontSize,
          })
        })
      }
      drawNarrativePageLines(sourcePages[1], narrativeLines.slice(0, narrativeLineYs.length))
      let narrativeOverflow = narrativeLines.slice(narrativeLineYs.length)
      let narrativeLastPage = sourcePages[1]
      while (narrativeOverflow.length) {
        const [reportTemplatePage] = await pdf.copyPages(templateSource, [1])
        narrativeLastPage = pdf.addPage(reportTemplatePage)
        if (narrativeTitle) {
          const continuedTitle = toPdfSafeText(`${narrative.title} (continued)`, font)
          const titleWidth = font.widthOfTextAtSize(continuedTitle, narrativeFontSize)
          narrativeLastPage.drawText(continuedTitle, {
            x: 187 + (257 - titleWidth) / 2,
            y: 925,
            font,
            size: narrativeFontSize,
          })
        }
        drawNarrativePageLines(narrativeLastPage, narrativeOverflow.slice(0, narrativeLineYs.length))
        narrativeOverflow = narrativeOverflow.slice(narrativeLineYs.length)
      }
      if (narrative.preparedBy) {
        drawValue(1, narrative.preparedBy, 78, 260, 280, { size: 8, page: narrativeLastPage })
      }
      const companyLineSets = [
        { key: 'natureOfBusiness', y: [813, 797, 781, 765, 750, 734, 718] },
        { key: 'descriptionOfServices', y: [648, 632, 617, 601, 585, 569, 553] },
        { key: 'targetClientele', y: [484, 468, 452, 436, 420, 405, 389] },
        { key: 'companyRules', y: [319, 303, 288, 272, 256, 240, 224] },
      ]
      const companyFontSize = 8.5
      const wrapCompanyAnswer = (value, maxWidth) => {
        const safeText = toPdfSafeText(String(value || '').replace(/\s+/g, ' ').trim(), font)
        if (!safeText) return []
        const lines = []
        let line = ''
        const pushLine = () => {
          if (line) lines.push(line)
          line = ''
        }
        for (let word of safeText.split(' ')) {
          while (font.widthOfTextAtSize(word, companyFontSize) > maxWidth) {
            let splitAt = word.length
            while (splitAt > 1 && font.widthOfTextAtSize(word.slice(0, splitAt), companyFontSize) > maxWidth) splitAt -= 1
            const piece = word.slice(0, splitAt)
            word = word.slice(splitAt)
            if (line) pushLine()
            lines.push(piece)
          }
          if (!word) continue
          const candidate = line ? `${line} ${word}` : word
          if (line && font.widthOfTextAtSize(candidate, companyFontSize) > maxWidth) pushLine()
          line = line ? `${line} ${word}` : word
        }
        pushLine()
        return lines
      }
      const companyAnswerLines = companyLineSets.map(({ key }) => ({
        key,
        lines: wrapCompanyAnswer(narrative[key], 465),
      }))
      const drawCompanyAnswerPage = (page, answerLines) => {
        answerLines.forEach(({ key, lines }) => {
          const lineSet = companyLineSets.find((section) => section.key === key)
          lines.slice(0, lineSet.y.length).forEach((line, index) => {
            page.drawText(line, {
              x: 88,
              y: lineSet.y[index],
              font,
              size: companyFontSize,
            })
          })
        })
      }
      drawCompanyAnswerPage(sourcePages[2], companyAnswerLines)
      let companyOverflow = companyAnswerLines.map(({ key, lines }) => ({ key, lines: lines.slice(7) }))
      while (companyOverflow.some(({ lines }) => lines.length)) {
        const [profileTemplatePage] = await pdf.copyPages(templateSource, [2])
        const continuationPage = pdf.addPage(profileTemplatePage)
        const continuationAnswers = companyOverflow.map(({ key, lines }) => ({ key, lines: lines.slice(0, 7) }))
        continuationPage.drawText('CONTINUED', {
          x: 472,
          y: 846,
          font: boldFont,
          size: 7,
        })
        drawCompanyAnswerPage(continuationPage, continuationAnswers)
        companyOverflow = companyOverflow.map(({ key, lines }) => ({ key, lines: lines.slice(7) }))
      }
      const map = entryContent('Immersion Proper/Work Immersion Map Location')
      if (map.photo_path) {
        const [mapTemplatePage] = sourcePages
        const { width: pageWidth, height: pageHeight } = mapTemplatePage.getSize()
        const photoAttachmentPage = pdf.addPage([pageWidth, pageHeight])
        const heading = 'WORK IMMERSION MAP / LOCATION PHOTO'
        const headingSize = 13
        photoAttachmentPage.drawText(heading, {
          x: (pageWidth - boldFont.widthOfTextAtSize(heading, headingSize)) / 2,
          y: pageHeight - 68,
          font: boldFont,
          size: headingSize,
        })
        photoAttachmentPage.drawText('Attached from the saved Work Immersion Map Location entry', {
          x: 72,
          y: pageHeight - 91,
          font,
          size: 9,
        })
        const photoFrame = { x: 72, y: 110, width: pageWidth - 144, height: pageHeight - 230 }
        photoAttachmentPage.drawRectangle({
          ...photoFrame,
          borderColor: rgb(0.72, 0.74, 0.78),
          borderWidth: 1,
        })
        pendingImages.push(drawSavedImage(map.photo_path, 4, {
          x: photoFrame.x + 8,
          y: photoFrame.y + 8,
          width: photoFrame.width - 16,
          height: photoFrame.height - 16,
        }, photoAttachmentPage))
      }
      const evaluation = entryContent('Immersion Proper/Evaluation Sheet')
      drawValue(3, evaluation.studentName, 110, 898, 430, { size: 8 })
      drawValue(3, evaluation.immersionSite, 110, 882, 430, { size: 8 })
      drawValue(3, evaluation.periodCovered, 110, 866, 430, { size: 8 })
      const ratingRowYs = [815, 770, 726, 681, 636, 591, 553, 514, 476, 437]
      const ratingColumnXs = { '5': 290, '4': 345, '3': 397, '2': 441, '1': 486 }
      ;(evaluation.ratings || []).forEach((rating, index) => {
        if (!rating) return
        const choiceX = ratingColumnXs[rating.choice]
        if (choiceX !== undefined) sourcePages[3].drawText('X', { x: choiceX, y: ratingRowYs[index], font, size: 8 })
        if (rating.score) drawValue(3, rating.score, 518, ratingRowYs[index], 43, { size: 8 })
      })
      drawValue(3, evaluation.ratingTotal, 199, 396, 34, { size: 7.5 })
      drawValue(3, evaluation.ratingAverage, 247, 396, 34, { size: 7.5 })
      drawValue(3, evaluation.overallRating, 409, 396, 75, { size: 7.5 })
      const comments = toPdfSafeText(String(evaluation.comments || ''), font)
      const commentLines = []
      let commentLine = ''
      for (const word of comments.split(/\s+/).filter(Boolean)) {
        const candidate = commentLine ? `${commentLine} ${word}` : word
        if (commentLine && font.widthOfTextAtSize(candidate, 8) > 475) {
          commentLines.push(commentLine)
          commentLine = word
        } else {
          commentLine = candidate
        }
      }
      if (commentLine) commentLines.push(commentLine)
      commentLines.slice(0, 8).forEach((line, index) => {
        sourcePages[3].drawText(line, { x: 72, y: 368 - index * 12, font, size: 8 })
      })
      const overflowingComments = commentLines.slice(8)
      const evaluationContinuationOffset = overflowingComments.length ? 1 : 0
      if (overflowingComments.length) {
        const [commentsTemplatePage] = await pdf.copyPages(templateSource, [5])
        const commentsContinuationPage = pdf.insertPage(4, commentsTemplatePage)
        commentsContinuationPage.drawText('WORK IMMERSION EVALUATION SHEET - CONTINUED', {
          x: 72,
          y: 900,
          font: boldFont,
          size: 12,
        })
        overflowingComments.forEach((line, index) => {
          commentsContinuationPage.drawText(line, {
            x: 72,
            y: 850 - index * 12,
            font,
            size: 8,
          })
        })
        sourcePages = pdf.getPages()
      }
      drawValue(3, evaluation.supervisorSignature, 90, 258, 190, { size: 8 })
      drawValue(3, evaluation.studentSignature, 330, 258, 190, { size: 8 })
      const dailyRecord = entryContent('Immersion Proper/Daily Time Record')
      const dailyPages = Array.isArray(dailyRecord.pages) ? dailyRecord.pages : []
      const dtrLayouts = [
        { pageIndex: 4 + evaluationContinuationOffset, dateRows: [820, 674, 542, 424], taskLines: [8, 7, 6, 6], taskLineHeight: 14, firstTaskLineOffsets: [25, 25, 25, 26], taskFontSize: 7.5 },
        { pageIndex: 5 + evaluationContinuationOffset, dateRows: [924, 786, 663, 555, 447], taskLines: [7, 7, 6, 6, 6], taskLineHeight: 16, firstTaskLineOffsets: [16, 14, 13, 14, 14], taskFontSize: 8 },
        { pageIndex: 8 + evaluationContinuationOffset, dateRows: [924, 780, 625], taskLines: [6, 6, 6], taskLineHeight: 21, firstTaskLineOffsets: [20, 31, 31], taskFontSize: 8.5 },
        { pageIndex: 9 + evaluationContinuationOffset, dateRows: [924, 793, 662, 531, 400, 269], taskLines: [5, 4, 4, 4, 4, 4], taskLineHeight: 20, firstTaskLineOffsets: [28, 28, 28, 28, 28, 28], taskFontSize: 8.5 },
        { pageIndex: 10 + evaluationContinuationOffset, dateRows: [924, 804, 642, 460, 298], taskLines: [4, 6, 7, 6, 6], taskLineHeight: 20, firstTaskLineOffsets: [28, 28, 28, 28, 28], taskFontSize: 8.5 },
      ]
      const dailyEntries = dailyPages.flatMap((recordPage, pageNumber) => (
        (Array.isArray(recordPage?.entries) ? recordPage.entries : []).map((record) => ({
          record: record || {},
          sourcePageNumber: pageNumber,
        }))
      ))
      const wrapDtrTaskLines = (value, maxWidth, size) => {
        const safeText = toPdfSafeText(String(value || '').replace(/\s+/g, ' ').trim(), font)
        if (!safeText) return []
        const lines = []
        let line = ''
        const pushLine = () => {
          if (line) lines.push(line)
          line = ''
        }
        for (let word of safeText.split(' ')) {
          while (font.widthOfTextAtSize(word, size) > maxWidth) {
            let splitAt = word.length
            while (splitAt > 1 && font.widthOfTextAtSize(word.slice(0, splitAt), size) > maxWidth) splitAt -= 1
            const piece = word.slice(0, splitAt)
            word = word.slice(splitAt)
            if (line) pushLine()
            lines.push(piece)
          }
          if (!word) continue
          const candidate = line ? `${line} ${word}` : word
          if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) pushLine()
          line = line ? `${line} ${word}` : word
        }
        pushLine()
        return lines
      }
      const drawDtrTaskLines = (page, lines, firstLineY, lineHeight, size) => {
        lines.forEach((line, index) => {
          page.drawText(line, {
            x: 74,
            y: firstLineY + 3 - index * lineHeight,
            font,
            size,
          })
        })
      }
      const drawDtrLineValue = (page, value, x, width, y) => {
        const safeValue = toPdfSafeText(String(value || '').replace(/\s+/g, ' ').trim(), font)
        if (!safeValue) return
        let size = 8
        while (size > 6 && font.widthOfTextAtSize(safeValue, size) > width - 4) size -= 0.5
        const textWidth = font.widthOfTextAtSize(safeValue, size)
        page.drawText(safeValue, {
          x: x + (width - textWidth) / 2,
          y,
          font,
          size,
        })
      }
      const dtrTaskContinuations = []
      let dailyEntryIndex = 0
      let dailyOutputPageNumber = 0
      while (dailyEntryIndex < dailyEntries.length) {
        const baseDtrLayout = dtrLayouts[dtrLayouts.length - 1]
        const layout = dtrLayouts[dailyOutputPageNumber] || {
          ...baseDtrLayout,
          pageIndex: sourcePages.length + dailyOutputPageNumber - dtrLayouts.length,
          copyFromPage: baseDtrLayout.pageIndex,
        }
        let page = sourcePages[layout.pageIndex]
        if (!page) {
          const [templatePage] = await pdf.copyPages(templateSource, [layout.copyFromPage])
          page = pdf.addPage(templatePage)
        }
        const recordsOnPage = Math.min(layout.dateRows.length, dailyEntries.length - dailyEntryIndex)
        for (let row = 0; row < recordsOnPage; row += 1) {
          const { record } = dailyEntries[dailyEntryIndex + row]
          const dateValue = String(record.date || '')
          const dateMatch = dateValue.match(/^(\d{4})-(\d{2})-(\d{2})$/)
          const displayDate = dateMatch ? `${dateMatch[2]}/${dateMatch[3]}/${dateMatch[1]}` : dateValue
          const dateY = layout.dateRows[row]
          drawDtrLineValue(page, displayDate, 315, 125, dateY)
          drawDtrLineValue(page, record.day, 460, 90, dateY)

          const lineCount = layout.taskLines[row]
          const lineHeight = layout.taskLineHeight
          const firstLineY = dateY - layout.firstTaskLineOffsets[row]
          const taskLines = wrapDtrTaskLines(record.tasks, 450, layout.taskFontSize)
          drawDtrTaskLines(page, taskLines.slice(0, lineCount), firstLineY, lineHeight, layout.taskFontSize)
          if (taskLines.length > lineCount) {
            dtrTaskContinuations.push({
              displayDate,
              day: String(record.day || ''),
              sourcePageNumber: dailyEntries[dailyEntryIndex + row].sourcePageNumber,
              lines: taskLines.slice(lineCount),
            })
          }
        }
        dailyEntryIndex += recordsOnPage
        const signatureEntry = dailyEntries[dailyEntryIndex - 1]
        const signaturePage = signatureEntry ? dailyPages[signatureEntry.sourcePageNumber] : null
        if (signaturePage?.preparedBy) {
          drawValue(layout.pageIndex, signaturePage.preparedBy, 75, 105, 180, { size: 8, page })
        }
        dailyOutputPageNumber += 1
      }
      while (dtrTaskContinuations.length) {
        const continuationLayout = dtrLayouts[dtrLayouts.length - 1]
        const [templatePage] = await pdf.copyPages(templateSource, [continuationLayout.pageIndex])
        const page = pdf.addPage(templatePage)
        let continuationSignaturePage = null
        for (let row = 0; row < continuationLayout.dateRows.length && dtrTaskContinuations.length; row += 1) {
          const continuation = dtrTaskContinuations[0]
          continuationSignaturePage = dailyPages[continuation.sourcePageNumber] || continuationSignaturePage
          const dateY = continuationLayout.dateRows[row]
          drawDtrLineValue(page, continuation.displayDate, 315, 125, dateY)
          const continuedDay = continuation.day ? `${continuation.day} (cont.)` : 'CONTINUED'
          drawDtrLineValue(page, continuedDay, 460, 90, dateY)
          const lineCount = continuationLayout.taskLines[row]
          const continuedLines = continuation.lines.splice(0, lineCount)
          drawDtrTaskLines(
            page,
            continuedLines,
            dateY - continuationLayout.firstTaskLineOffsets[row],
            continuationLayout.taskLineHeight,
            continuationLayout.taskFontSize,
          )
          if (!continuation.lines.length) dtrTaskContinuations.shift()
        }
        if (continuationSignaturePage?.preparedBy) {
          page.drawText(toPdfSafeText(continuationSignaturePage.preparedBy, font), {
            x: 75, y: 105, font, size: 8,
          })
        }
      }
      await Promise.all(pendingImages)
    } else if (groupTitle === 'Post-Immersion') {
      const pendingImages = []
      const report = entryContent('Post-Immersion/Written Report')
      drawValue(0, report.title, 150, 785, 340, { size: 9 })
      drawParagraphBox(1, report.report, { x: 73, y: 335, width: 465, height: 550 }, { size: 7, lineHeight: 20 })
      drawValue(1, report.preparedBy, 74, 300, 450, { size: 9 })
      const postEvaluation = entryContent('Post-Immersion/Evaluation')
      const vennXs = { school: 105, shared: 255, work: 405 }
      const vennYs = { knowledge: 668, skills: 589, attitude: 510 }
      for (const area of ['knowledge', 'skills', 'attitude']) {
        for (const part of ['school', 'shared', 'work']) {
          drawParagraphBox(5, postEvaluation[`${area}_${part}`], {
            x: vennXs[part], y: vennYs[area] - 22, width: 105, height: 40,
          }, { size: 6.5, lineHeight: 10 })
        }
      }
      const selfReflection = entryContent('Post-Immersion/Self Evaluation and Reflection')
      for (const [key, x, y, width] of [
        ['studentName', 205, 866, 360], ['trackStrand', 205, 838, 140], ['specialization', 435, 838, 130],
        ['trainingCompany', 205, 810, 360], ['companyAddress', 205, 775, 195], ['telephoneNumber', 480, 775, 85],
        ['contactPerson', 205, 733, 195], ['contactNumber', 480, 726, 85],
        ['inclusiveDateFrom', 240, 694, 100], ['inclusiveDateTo', 375, 694, 90], ['inclusiveDateYear', 485, 694, 60],
        ['evaluationDate', 205, 637, 360],
        ['studentSignature', 80, 120, 220], ['studentDate', 380, 105, 160],
      ]) drawValue(6, selfReflection[key], x, y, width, { size: 7.5 })
      for (const [key, x, width] of [
        ['workAssignment', 75, 125], ['department', 205, 90], ['position', 296, 80],
        ['otherDepartment', 378, 80], ['raterSupervisor', 460, 80],
      ]) {
        drawParagraphBox(6, selfReflection[key], { x, y: 646, width, height: 30 }, { size: 7, lineHeight: 9 })
      }
      // These website fields are multiline reflections. Use the corresponding
      // answer areas so complete saved responses remain visible in the export.
      for (const [key, y, height] of [
        ['dutiesBriefly', 559, 79], ['strongestPerformance', 506, 53], ['areasImproved', 452, 54],
        ['needsImprovement', 398, 54], ['challengingSituation', 358, 40], ['overcomeChallenge', 318, 40],
        ['learnedExperiences', 277, 41], ['trainingStationPandemic', 223, 54], ['suggestions', 184, 39],
      ]) {
        drawParagraphBox(6, selfReflection[key], { x: 205, y, width: 360, height }, { size: 7.5, lineHeight: 11 })
      }
      // The source workbook continues the self-reflection form on its final
      // page. These saved answers belong there rather than on the questions page.
      drawValue(7, selfReflection.acquiredTrainingHours, 210, 736, 180, { size: 8 })
      drawValue(7, selfReflection.dateOfCompletion, 380, 736, 105, { size: 8 })
      drawValue(7, selfReflection.totalPerformanceRating, 255, 708, 270, { size: 8 })
      drawParagraphBox(7, selfReflection.remarks, { x: 72, y: 555, width: 475, height: 120 }, { size: 8, lineHeight: 16 })
      drawValue(7, selfReflection.teacherSignature, 75, 515, 250, { size: 8 })
      drawValue(7, selfReflection.teacherDate, 95, 482, 120, { size: 8 })
      for (const [title, pageIndex] of [['Forms', 2], ['Sample', 3]]) {
        const entry = entryContent(`Post-Immersion/${title}`)
        if (entry.photo_path) pendingImages.push(drawSavedImage(entry.photo_path, pageIndex, { x: 76, y: 230, width: 460, height: 560 }))
        drawParagraph(pageIndex, entry.caption, 76, 195, 460, { size: 8, lineHeight: 11 })
      }
      const gallery = entryContent('Post-Immersion/Gallery')
      const galleryPages = [sourcePages[4]]
      for (const [index, item] of (gallery.items || []).entries()) {
        const pageNumber = Math.floor(index / 8)
        if (!galleryPages[pageNumber]) {
          const [galleryTemplatePage] = await pdf.copyPages(templateSource, [4])
          galleryPages[pageNumber] = pdf.addPage(galleryTemplatePage)
        }
        const page = galleryPages[pageNumber]
        const slot = index % 8
        const x = slot % 2 ? 335 : 75
        const y = 700 - Math.floor(slot / 2) * 155
        if (item.path) pendingImages.push(drawSavedImage(item.path, 4, { x, y, width: 200, height: 100 }, page))
        drawValue(4, item.caption, x, y - 12, 200, { size: 7, page })
      }
      const certificate = entryContent('Post-Immersion/Certificate')
      if (certificate.photo_path) {
        const certificatePage = pdf.addPage([612, 792])
        certificatePage.drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: rgb(1, 1, 1) })
        const certificateTitle = 'CERTIFICATE'
        certificatePage.drawText('CERTIFICATE', {
          x: (612 - boldFont.widthOfTextAtSize(certificateTitle, 18)) / 2,
          y: 740,
          font: boldFont,
          size: 18,
          color: rgb(0, 0, 0),
        })
        pendingImages.push(drawSavedImage(certificate.photo_path, 7, { x: 75, y: 170, width: 462, height: 530 }, certificatePage))
      }
      await Promise.all(pendingImages)
    }
    const handledSections = {
      'Pre-Immersion': ['Requirements Checklist', 'Class Schedule', 'Parent Consent', 'List of Task', 'Essay on Workplace Conduct', 'Application Letter', 'Resume', 'Barangay Clearance', 'Police Clearance', 'Mayors Clearance', 'Health Clearance'],
      'Immersion Proper': ['Narrative Report', 'Work Immersion Map Location', 'Evaluation Sheet', 'Daily Time Record'],
      'Post-Immersion': ['Written Report', 'Forms', 'Sample', 'Gallery', 'Evaluation', 'Self Evaluation and Reflection', 'Certificate'],
    }[groupTitle] || []
    await appendPortfolioSupplementPages(pdf, entries, groupTitle, new Set(handledSections.map((title) => groupTitle + '/' + title)), font, boldFont)
    return await pdf.save()
  }

  const pdf = await PDFDocument.create()
  const form = pdf.getForm()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold)
  const immersionFont = await pdf.embedFont(StandardFonts.TimesRoman)
  const immersionBoldFont = await pdf.embedFont(StandardFonts.TimesRomanBold)
  let fieldNumber = 0

  const addPage = (pageInfo, continuation = false) => {
    const isModuleIntroduction = pageInfo.group === 'Module Introduction'
    const page = pdf.addPage(isModuleIntroduction ? PageSizes.Legal : PageSizes.A4)
    const { width, height } = page.getSize()
    const left = isModuleIntroduction ? 72 : 44
    const right = isModuleIntroduction ? 52 : 44
    const contentWidth = width - left - right
    const pageFont = isModuleIntroduction ? immersionFont : font
    const pageBoldFont = isModuleIntroduction ? immersionBoldFont : boldFont
    const title = continuation ? `${pageInfo.title} (continued)` : pageInfo.title

    if (!isModuleIntroduction) {
      page.drawText(toPdfSafeText(pageInfo.group.toUpperCase(), pageBoldFont), {
        x: left,
        y: height - 42,
        font: pageBoldFont,
        size: 10,
        color: rgb(0.35, 0.35, 0.35),
      })
    }

    page.drawText(toPdfSafeText(isModuleIntroduction ? title.toUpperCase() : title, pageBoldFont), {
      x: left,
      y: height - (isModuleIntroduction ? 78 : 67),
      font: pageBoldFont,
      size: isModuleIntroduction ? 14 : 17,
      color: isModuleIntroduction ? rgb(0.21, 0.37, 0.57) : rgb(0, 0, 0),
    })
    return {
      page,
      left,
      contentWidth,
      pageFont,
      pageBoldFont,
      y: height - (isModuleIntroduction ? 108 : 96),
      isModuleIntroduction,
    }
  }

  const addModuleIntroductionCover = (coverData = {}) => {
    const page = pdf.addPage(PageSizes.Legal)
    const { width, height } = page.getSize()
    const panelX = width * 0.57
    const blueBandY = height * 0.36
    const blueBandHeight = 104

    page.drawRectangle({
      x: panelX,
      y: blueBandY + blueBandHeight,
      width: width - panelX,
      height: height - blueBandY - blueBandHeight,
      color: rgb(0.64, 0.08, 0.06),
    })
    page.drawRectangle({
      x: panelX,
      y: 0,
      width: width - panelX,
      height: blueBandY,
      color: rgb(0.02, 0.66, 0.33),
    })
    page.drawRectangle({
      x: panelX - 8,
      y: 0,
      width: 2,
      height: blueBandY,
      color: rgb(0.92, 0.70, 0.41),
    })
    page.drawRectangle({
      x: panelX - 3,
      y: 0,
      width: 2,
      height: blueBandY,
      color: rgb(0.92, 0.70, 0.41),
    })
    page.drawRectangle({
      x: 0,
      y: blueBandY,
      width,
      height: blueBandHeight,
      color: rgb(0.06, 0.15, 0.27),
    })
    page.drawText('2026', {
      x: panelX + 28,
      y: blueBandY + blueBandHeight + 54,
      font: immersionFont,
      size: 30,
      color: rgb(1, 1, 1),
    })
    const coverTitleLines = [
      'TVL ICT/CSS - SCHOOL-BASED',
      'WORK IMMERSION MANUAL',
    ]
    coverTitleLines.forEach((line, index) => {
      const size = 22
      const lineWidth = immersionFont.widthOfTextAtSize(line, size)
      page.drawText(line, {
        x: width - 22 - lineWidth,
        y: blueBandY + (index === 0 ? 67 : 37),
        font: immersionFont,
        size,
        color: rgb(1, 1, 1),
      })
    })

    const panelWidth = width - panelX
    const panelCardX = panelX + 12
    const panelCardWidth = panelWidth - 24
    const photoBox = {
      x: panelX + (panelWidth - 142) / 2,
      y: 210,
      width: 142,
      height: 140,
    }
    page.drawRectangle({
      ...photoBox,
      borderWidth: 2,
      borderColor: rgb(0.05, 0.05, 0.05),
      color: rgb(1, 1, 1),
    })
    page.drawText('2 x 2 Photo', {
      x: photoBox.x + 41,
      y: photoBox.y + 64,
      font: immersionFont,
      size: 12,
    })

    const identityCard = { x: panelCardX, y: 122, width: panelCardWidth, height: 78 }
    page.drawRectangle({
      ...identityCard,
      borderWidth: 1,
      borderColor: rgb(0.12, 0.12, 0.12),
      color: rgb(1, 1, 1),
    })
    page.drawText('Name:', {
      x: identityCard.x + 10,
      y: identityCard.y + 48,
      font: immersionBoldFont,
      size: 10,
    })
    page.drawLine({
      start: { x: identityCard.x + 52, y: identityCard.y + 46 },
      end: { x: identityCard.x + identityCard.width - 10, y: identityCard.y + 46 },
      thickness: 0.8,
      color: rgb(0.15, 0.15, 0.15),
    })
    page.drawText('Address:', {
      x: identityCard.x + 10,
      y: identityCard.y + 18,
      font: immersionBoldFont,
      size: 10,
    })
    page.drawLine({
      start: { x: identityCard.x + 56, y: identityCard.y + 16 },
      end: { x: identityCard.x + identityCard.width - 10, y: identityCard.y + 16 },
      thickness: 0.8,
      color: rgb(0.15, 0.15, 0.15),
    })

    const nameField = form.createTextField('module_intro_student_name')
    nameField.setText(String(coverData.student_name || ''))
    nameField.addToPage(page, {
      x: identityCard.x + 54,
      y: identityCard.y + 43,
      width: identityCard.width - 64,
      height: 20,
      borderWidth: 0,
      font: immersionFont,
      fontSize: 10,
    })
    nameField.setFontSize(10)
    nameField.updateAppearances(immersionFont)

    const addressField = form.createTextField('module_intro_student_address')
    addressField.setText(String(coverData.address || ''))
    addressField.addToPage(page, {
      x: identityCard.x + 58,
      y: identityCard.y + 12,
      width: identityCard.width - 68,
      height: 20,
      borderWidth: 0,
      font: immersionFont,
      fontSize: 10,
    })
    addressField.setFontSize(10)
    addressField.updateAppearances(immersionFont)

    const approvalCard = { x: panelCardX, y: 8, width: panelCardWidth, height: 104 }
    page.drawRectangle({
      ...approvalCard,
      borderWidth: 1,
      borderColor: rgb(0.12, 0.12, 0.12),
      color: rgb(1, 1, 1),
    })
    const approvalText = [
      { text: 'Prepared by:', y: 92, bold: true },
      { text: 'VIVENCIO P. PASCUAL, JR.', y: 79, bold: true },
      { text: 'Immersion Teacher / TVL Subject Coordinator', y: 67 },
      { text: 'Approved by:', y: 49, bold: true },
      { text: 'EXCELSIS G. PASTOR, PhD', y: 36, bold: true },
      { text: 'Principal II, WCSAT', y: 24 },
      { text: '1/19/2026', y: 10 },
    ]
    approvalText.forEach(({ text, y, bold }) => {
      const textWidth = (bold ? immersionBoldFont : immersionFont).widthOfTextAtSize(text, 8)
      page.drawText(text, {
        x: approvalCard.x + (approvalCard.width - textWidth) / 2,
        y,
        font: bold ? immersionBoldFont : immersionFont,
        size: 8,
      })
    })

    return {
      page,
      pageFont: immersionFont,
      pageBoldFont: immersionBoldFont,
      isModuleIntroduction: true,
      isCover: true,
    }
  }

  const addModuleIntroductionInformationPage = (fields) => {
    const page = pdf.addPage(PageSizes.Legal)
    const { width, height } = page.getSize()
    const left = 72
    const right = 52
    const contentWidth = width - left - right
    const normalizedFields = fields.map((field) => ({
      ...field,
      normalizedLabel: field.label.toLowerCase().replace(/[^a-z]/g, ''),
    }))
    const rows = [
      { label: 'Track:', key: 'track', fallback: 'TECHNICAL – VOCATIONAL – LIVELIHOOD (TVL)' },
      { label: 'Strand:', key: 'strand', fallback: 'INFORMATION AND COMMUNICATION TECHNOLOGY (ICT)' },
      { label: 'Specialization:', key: 'specialization', fallback: 'COMPUTER SYSTEMS SERVICING (CSS) NCII' },
      { label: 'Student’s Name:', key: 'studentname', fallback: '' },
      { label: '', key: 'schoolname', fallback: 'WESTERN CAGAYAN SCHOOL OF ARTS AND TRADES\nSENIOR HIGH SCHOOL\nCentro 03, Lasam, Cagayan' },
    ]
    const labelWidth = 176
    const rowHeight = 76
    let y = height - 106

    rows.forEach(({ label, key, fallback }, index) => {
      const field = normalizedFields.find((item) => item.normalizedLabel.includes(key))
      const value = field?.value || fallback
      page.drawRectangle({
        x: left,
        y: y - rowHeight,
        width: contentWidth,
        height: rowHeight,
        borderWidth: 1,
        borderColor: rgb(0.2, 0.2, 0.2),
      })
      page.drawRectangle({
        x: left,
        y: y - rowHeight,
        width: labelWidth,
        height: rowHeight,
        color: rgb(0.91, 0.93, 0.95),
      })
      page.drawLine({
        start: { x: left + labelWidth, y: y - rowHeight },
        end: { x: left + labelWidth, y },
        thickness: 1,
        color: rgb(0.2, 0.2, 0.2),
      })
      if (label) page.drawText(label, {
        x: left + 12,
        y: y - 42,
        font: immersionBoldFont,
        size: 12,
      })

      const valueX = left + labelWidth + 12
      const valueWidth = contentWidth - labelWidth - 24
      if (key === 'schoolname') {
        String(value).split('\n').forEach((line, lineIndex) => {
          const size = lineIndex === 0 ? 11 : 10
          const lineWidth = immersionBoldFont.widthOfTextAtSize(line, size)
          page.drawText(line, {
            x: valueX + Math.max(0, (valueWidth - lineWidth) / 2),
            y: y - 26 - lineIndex * 16,
            font: lineIndex === 2 ? immersionFont : immersionBoldFont,
            size,
          })
        })
      } else {
        const textField = form.createTextField(`module_intro_information_${index + 1}`)
        if (value) textField.setText(toPdfSafeText(value, immersionFont))
        textField.addToPage(page, {
          x: valueX,
          y: y - rowHeight + 14,
          width: valueWidth,
          height: rowHeight - 28,
          borderWidth: 0,
          font: immersionFont,
          fontSize: 11,
        })
        textField.setFontSize(11)
        textField.updateAppearances(immersionFont)
      }
      y -= rowHeight
    })
  }

  for (const pageInfo of pages) {
    const savedFields = getFillablePortfolioFields(pageInfo.savedContent)
    const fields = pageInfo.staticContent
      ? [
          ...pageInfo.staticContent.map((text) => ({ label: '', value: text, kind: 'static' })),
          ...savedFields,
        ]
      : savedFields
    if (!fields.length) fields.push({ label: 'Answer', value: '', kind: 'text' })
    const fillableFieldCount = fields.filter((field) => field.kind !== 'static').length

    const isIntroductionCover = pageInfo.group === 'Module Introduction' && pageInfo.title === 'Cover Page'
    if (isIntroductionCover) {
      const coverFields = savedFields.filter((field) => !field.label.toLowerCase().includes('photo'))
      addModuleIntroductionCover(pageInfo.savedContent || {})
      addModuleIntroductionInformationPage(coverFields)
      continue
    }

    let pageState = addPage(pageInfo)
    for (const field of fields) {
      const isStatic = field.kind === 'static'
      const isNote = field.kind === 'note'

      if (pageState.isCover && !isStatic) {
        const normalizedLabel = field.label.toLowerCase()
        const coverRows = normalizedLabel.includes('track')
          ? { row: 0, column: 0 }
          : normalizedLabel.includes('strand')
            ? { row: 0, column: 1 }
            : normalizedLabel.includes('specialization')
              ? { row: 1, column: 0 }
              : normalizedLabel.includes('student')
                ? { row: 1, column: 1 }
                : normalizedLabel.includes('school')
                  ? { row: 2, column: 0, wide: true }
                  : { row: 3, column: 0, wide: true }
        const columnGap = 22
        const columnWidth = (pageState.contentWidth - columnGap) / 2
        const x = pageState.left + (coverRows.column ? columnWidth + columnGap : 0)
        const fieldWidth = coverRows.wide ? pageState.contentWidth : columnWidth
        const rowTop = pageState.y - coverRows.row * 60
        pageState.page.drawText(toPdfSafeText(field.label, pageState.pageBoldFont), {
          x,
          y: rowTop,
          font: pageState.pageBoldFont,
          size: 10,
        })

        const fieldY = rowTop - (isNote ? 53 : 45)
        if (isNote) {
          pageState.page.drawRectangle({
            x,
            y: fieldY,
            width: fieldWidth,
            height: 42,
            borderWidth: 1,
            borderColor: rgb(0.55, 0.55, 0.55),
            color: rgb(1, 1, 1),
          })
          pageState.page.drawText(toPdfSafeText(field.value, pageState.pageFont), {
            x: x + 8,
            y: fieldY + 16,
            font: pageState.pageFont,
            size: 9,
            color: rgb(0.35, 0.35, 0.35),
          })
        } else {
          const textField = form.createTextField(`portfolio_field_${++fieldNumber}`)
          textField.enableMultiline()
          if (field.value) textField.setText(toPdfSafeText(field.value, pageState.pageFont))
          textField.addToPage(pageState.page, {
            x,
            y: fieldY,
            width: fieldWidth,
            height: 34,
            borderWidth: 1,
            font: pageState.pageFont,
            fontSize: 10,
          })
          textField.setFontSize(10)
          textField.updateAppearances(pageState.pageFont)
        }
        continue
      }

      let fieldHeight = 0
      if (!isStatic) {
        if (field.kind === 'checkbox') {
          fieldHeight = 16
        } else if (isNote) {
          fieldHeight = 48
        } else if (pageInfo.title === 'Cover Page') {
          fieldHeight = 36
        } else if (fillableFieldCount === 1) {
          fieldHeight = 520
        } else {
          fieldHeight = Math.max(54, Math.min(170, Math.floor(620 / fillableFieldCount) - 24))
        }
      }
      const requiredHeight = isStatic ? 48 : fieldHeight + 30

      if (pageState.y - requiredHeight < 48) {
        pageState = addPage(pageInfo, true)
      }

      if (isStatic) {
        pageState.y = drawPdfWrappedText(pageState.page, field.value, {
          x: pageState.left,
          y: pageState.y,
          maxWidth: pageState.contentWidth,
          font: pageState.pageFont,
          fontSize: pageState.isModuleIntroduction ? 12 : 10,
          lineHeight: pageState.isModuleIntroduction ? 18 : 14,
        }) - 8
        continue
      }

      if (field.label) {
        pageState.page.drawText(toPdfSafeText(field.label, pageState.pageBoldFont), {
          x: pageState.left,
          y: pageState.y - 14,
          font: pageState.pageBoldFont,
          size: 10,
        })
      }

      const fieldY = pageState.y - fieldHeight - 22
      if (field.kind === 'checkbox') {
        const checkbox = form.createCheckBox(`portfolio_field_${++fieldNumber}`)
        if (field.value === 'true') checkbox.check()
        checkbox.addToPage(pageState.page, {
          x: pageState.left,
          y: fieldY,
          width: 16,
          height: 16,
          borderWidth: 1,
        })
        pageState.y = fieldY - 16
        continue
      }

      if (isNote) {
        pageState.page.drawRectangle({
          x: pageState.left,
          y: fieldY,
          width: pageState.contentWidth,
          height: Math.min(fieldHeight, 48),
          borderWidth: 1,
          borderColor: rgb(0.7, 0.7, 0.7),
        })
        pageState.page.drawText(toPdfSafeText(field.value, pageState.pageFont), {
          x: pageState.left + 8,
          y: fieldY + 18,
          font: pageState.pageFont,
          size: 9,
          color: rgb(0.35, 0.35, 0.35),
        })
        pageState.y = fieldY - 14
        continue
      }

      const textField = form.createTextField(`portfolio_field_${++fieldNumber}`)
      textField.enableMultiline()
      if (field.value) textField.setText(toPdfSafeText(field.value, pageState.pageFont))
      textField.addToPage(pageState.page, {
        x: pageState.left,
        y: fieldY,
        width: pageState.contentWidth,
        height: fieldHeight,
        borderWidth: 1,
        font: pageState.pageFont,
        fontSize: pageState.isModuleIntroduction ? 10 : 9,
      })
      textField.setFontSize(pageState.isModuleIntroduction ? 10 : 9)
      textField.updateAppearances(pageState.pageFont)
      pageState.y = fieldY - 14
    }
  }

  return await pdf.save()
}

async function createPortfolioPdf(
  userId,
  {
    groupTitles = PORTFOLIO_PROGRESS_GROUPS.map((group) => group.title),
    filename = 'i-WORKFOLIO-Portfolio.pdf',
    portfolioEntries,
    download = true,
  } = {}
) {
  if (portfolioEntries === undefined) {
    const { data, error } = await supabase
      .from('portfolio_entries')
      .select('section,content')
      .eq('user_id', userId)
      .order('section')
    if (error) throw error
    portfolioEntries = data || []
  }

  const normalizedEntries = portfolioEntries.map((entry) => ({
    ...entry,
    content: normalizePortfolioExportContent(entry.content),
  }))
  const pages = getPortfolioExportPages(normalizedEntries, groupTitles)

  const html2pdfModule = await import('html2pdf.js')
  const html2pdf = html2pdfModule.default
  const container = document.createElement('div')
  container.className = 'portfolio-export'

  
for (const pageInfo of pages) {
  const page = document.createElement('section')
  page.className = 'portfolio-export-page'

  const content = document.createElement('main')
  content.className = 'portfolio-export-content'

  const title = String(pageInfo.title || '').trim()
  const normalizedTitle = title.toLowerCase()
  const isCover = normalizedTitle === 'cover page'
  const isChecklist = normalizedTitle.includes('checklist')
  const isReflection =
    normalizedTitle.includes('reflection') ||
    normalizedTitle.includes('evaluation')
  const isReport =
    normalizedTitle.includes('report') ||
    normalizedTitle.includes('essay') ||
    normalizedTitle.includes('narrative')
  const isGallery =
    normalizedTitle.includes('picture') ||
    normalizedTitle.includes('gallery') ||
    normalizedTitle.includes('sample output')

  content.classList.add(
    isCover ? 'portfolio-export-cover' : 'portfolio-export-form'
  )

  if (!isCover) {
    const groupHeading = document.createElement('p')
    groupHeading.className = 'portfolio-export-group'
    groupHeading.textContent = pageInfo.group || 'Work Immersion'
    content.append(groupHeading)
  }

  const heading = document.createElement('h1')
  heading.textContent = isCover
    ? 'TVL ICT/CSS'
    : title

  content.append(heading)

  if (isCover) {
    const coverSubtitle = document.createElement('p')
    coverSubtitle.className = 'portfolio-export-cover-subtitle'
    coverSubtitle.textContent = 'SCHOOL-BASED WORK IMMERSION MANUAL'
    content.append(coverSubtitle)
  }

  if (pageInfo.staticContent) {
    pageInfo.staticContent.forEach((text) => {
      const paragraph = document.createElement('p')
      paragraph.className = 'portfolio-export-answer'
      paragraph.textContent = text
      content.append(paragraph)
    })
  }

  const savedContent = pageInfo.savedContent

  if (savedContent !== null && savedContent !== undefined) {
    await appendPortfolioExportValue(
  content,
  'Answer',
  savedContent,
  pageInfo.section || pageInfo.title
)
  } else if (!pageInfo.staticContent) {
    const emptyState = document.createElement('p')
    emptyState.className = 'portfolio-export-empty'

    if (isChecklist) {
      emptyState.textContent =
        'Complete the required items in this checklist.'
    } else if (isReflection || isReport) {
      emptyState.textContent =
        'Write your response in the space provided.'
    } else if (isGallery) {
      emptyState.textContent =
        'Add your photos or sample outputs for this section.'
    } else {
      emptyState.textContent =
        'No saved information for this section yet.'
    }

    content.append(emptyState)
  }

  page.append(content)
  container.append(page)
}


  const style = document.createElement('style')
  style.textContent = `
    .portfolio-export {
      width: 7.45in;
      color: #000;
      background: #fff;
      font: 11pt "Times New Roman", Times, serif;
    }
    .portfolio-export-page {
      box-sizing: border-box;
      width: 7.45in;
      min-height: 10.2in;
      display: flex;
      flex-direction: column;
      padding: 0;
      background: #fff;
      page-break-after: always;
      break-after: page;
    }
    .portfolio-export-content { flex: 1; padding: 0.15in 0; overflow-wrap: anywhere; }
    .portfolio-export-group { margin: 0 0 0.06in; color: #555; font-size: 9pt; text-align: center; text-transform: uppercase; }
    .portfolio-export-content h1 { margin: 0 0 0.16in; font-size: 15pt; text-align: center; }
    .portfolio-export-answer { margin: 0 0 0.1in; white-space: pre-wrap; line-height: 1.45; }
    .portfolio-export-answer strong { font-weight: bold; }
    .portfolio-export-empty { margin: 0; color: #555; font-style: italic; }
    .portfolio-export-upload { display: block; max-width: 5.5in; max-height: 5.5in; object-fit: contain; }
    @media print { .portfolio-export-page:last-child { page-break-after: auto; break-after: auto; } }
  `
  container.prepend(style)
  container.style.position = 'fixed'
  container.style.left = '-10000px'
  container.style.top = '0'
  document.body.append(container)

  try {
    const pdfWorker = html2pdf()
      .set({
        filename,
        margin: [0.35, 0.4, 0.35, 0.4],
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
        jsPDF: { unit: 'in', format: 'a4', orientation: 'portrait' },
        pagebreak: { mode: ['css', 'legacy'] },
      })
      .from(container)

    if (download) {
      await pdfWorker.save()
      return null
    }

    return await pdfWorker.outputPdf('blob')
  } finally {
    container.remove()
  }
}

function requestPdfSaveLocation(filename) {
  if (typeof window.showSaveFilePicker !== 'function') return null

  try {
    return window.showSaveFilePicker({
      suggestedName: filename,
      types: [{
        description: 'PDF document',
        accept: { 'application/pdf': ['.pdf'] },
      }],
    }).then(
      (handle) => ({ handle }),
      (error) => ({ error })
    )
  } catch (error) {
    return Promise.resolve({ error })
  }
}

async function savePdfBlob(blob, filename, saveRequest) {
  if (saveRequest) {
    const result = await saveRequest
    if (result.error) {
      if (result.error.name === 'AbortError') return false
      // Some embedded browsers expose showSaveFilePicker but reject it at
      // runtime. Fall through to the regular browser download in that case.
    } else {
      try {
        const writable = await result.handle.createWritable()
        await writable.write(blob)
        await writable.close()
        return true
      } catch (error) {
        if (error?.name === 'AbortError') return false
        // The browser can also reject a file handle after showing its picker.
        // The anchor download below works in those environments.
      }
    }
  }

  const downloadUrl = URL.createObjectURL(blob)
  const downloadLink = document.createElement('a')
  downloadLink.href = downloadUrl
  downloadLink.download = filename
  downloadLink.style.display = 'none'
  document.body.append(downloadLink)
  downloadLink.click()
  downloadLink.remove()
  window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 60000)
  return true
}

function SettingsPage({
  user,
  teacherMode = false,
}) {
  const [darkMode, setDarkMode] =
    useState(false)
  const [shareEmail, setShareEmail] = useState('')
  const [sharingPortfolio, setSharingPortfolio] = useState(false)
  const [portfolioShareError, setPortfolioShareError] = useState('')
  const [portfolioShareSuccess, setPortfolioShareSuccess] = useState('')
  const [deleteDialog, setDeleteDialog] = useState(null)
  const [deletePassword, setDeletePassword] = useState('')
  const [showDeletePassword, setShowDeletePassword] = useState(false)
  const [deleteOtp, setDeleteOtp] = useState('')
  const [deleteRequestId, setDeleteRequestId] = useState('')
  const [deleteError, setDeleteError] = useState('')
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [deleteResendSeconds, setDeleteResendSeconds] = useState(60)
  const [deleteFinalConfirmed, setDeleteFinalConfirmed] = useState(false)

  const maskedEmail = (() => {
    const email = user?.email || ''
    const [name, domain] = email.split('@')
    if (!name || !domain) return email
    return `${name.slice(0, 2)}${'*'.repeat(Math.max(2, name.length - 2))}@${domain}`
  })()

  useEffect(() => {
    if (deleteDialog !== 'otp' || deleteResendSeconds <= 0) return undefined
    const timer = window.setTimeout(() => {
      setDeleteResendSeconds((seconds) => seconds - 1)
    }, 1000)
    return () => window.clearTimeout(timer)
  }, [deleteDialog, deleteResendSeconds])

  const closeDeleteDialog = () => {
    setDeleteDialog(null)
    setDeletePassword('')
    setDeleteOtp('')
    setDeleteRequestId('')
    setDeleteError('')
    setDeleteLoading(false)
    setDeleteResendSeconds(60)
    setDeleteFinalConfirmed(false)
  }

  const sendDeletionOtp = async () => {
    if (!user?.email) throw new Error('Your verified account email could not be found.')
    const { error } = await supabase.auth.signInWithOtp({
      email: user.email,
      options: { shouldCreateUser: false },
    })
    if (error) throw error
  }

  const handleDeletePassword = async (event) => {
    event.preventDefault()
    setDeleteError('')
    if (!deletePassword) {
      setDeleteError('Enter your current password.')
      return
    }
    setDeleteLoading(true)
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: user.email,
        password: deletePassword,
      })
      if (error || data.user?.id !== user.id) throw error || new Error('Password verification failed.')

      const { data: requestData, error: requestError } =
        await supabase.functions.invoke('delete-account', {
          body: { action: 'prepare' },
        })
      if (requestError) throw requestError
      await sendDeletionOtp()
      setDeleteRequestId(requestData.requestId)
      setDeleteResendSeconds(60)
      setDeleteDialog('otp')
      setDeletePassword('')
    } catch (error) {
      setDeleteError(error?.message || 'Password verification failed.')
    } finally {
      setDeleteLoading(false)
    }
  }

  const handleDeleteOtp = async (event) => {
    event.preventDefault()
    setDeleteError('')
    if (!/^\d{6}$/.test(deleteOtp)) {
      setDeleteError('Enter the 6-digit verification code.')
      return
    }
    setDeleteLoading(true)
    try {
      const { error } = await supabase.functions.invoke('delete-account', {
        body: {
          action: 'verify-email',
          requestId: deleteRequestId,
          email: user.email,
          otp: deleteOtp,
        },
      })
      if (error) throw error
      setDeleteOtp('')
      setDeleteDialog('final')
    } catch (error) {
      const message = error?.message || ''
      setDeleteError(/expired/i.test(message)
        ? 'This verification code has expired. Request a new code.'
        : /token|code/i.test(message)
          ? 'The verification code is incorrect or invalid.'
          : message || 'Unable to verify the code.')
    } finally {
      setDeleteLoading(false)
    }
  }

  const handleResendDeletionOtp = async () => {
    if (deleteResendSeconds > 0) return
    setDeleteError('')
    setDeleteLoading(true)
    try {
      await sendDeletionOtp()
      setDeleteOtp('')
      setDeleteResendSeconds(60)
    } catch (error) {
      setDeleteError(error?.message || 'Unable to resend the verification code.')
    } finally {
      setDeleteLoading(false)
    }
  }

  const handlePermanentDeletion = async () => {
    if (!deleteFinalConfirmed) {
      setDeleteError('Confirm the permanent deletion checkbox before continuing.')
      return
    }
    setDeleteLoading(true)
    setDeleteError('')
    try {
      const { error } = await supabase.functions.invoke('delete-account', {
        body: { action: 'delete', requestId: deleteRequestId },
      })
      if (error) throw error
      await supabase.auth.signOut()
      window.alert('Your account has been permanently deleted.')
      window.location.reload()
    } catch (error) {
      setDeleteError(error?.message || 'Unable to delete your account. Please try again.')
      setDeleteLoading(false)
    }
  }

  const [
    loadingSettings,
    setLoadingSettings,
  ] = useState(true)

  useEffect(() => {
    const loadSettings =
      async () => {
        if (!user?.id) return

        const { data, error } =
          await supabase
            .from('profiles')
            .select('dark_mode')
            .eq(
              'id',
              user.id
            )
            .single()

        if (error) {
          console.error(
            'LOAD SETTINGS ERROR:',
            error
          )

          setLoadingSettings(
            false
          )

          return
        }

        if (data) {
          setDarkMode(
            data.dark_mode ??
              false
          )

          document.documentElement.classList.toggle(
            'dark-mode',
            data.dark_mode ===
              true
          )
        }

        setLoadingSettings(
          false
        )
      }

    loadSettings()
  }, [user?.id])

  const updateSetting = async (
    column,
    value,
    setter
  ) => {
    setter(value)

    if (!user?.id) return

    const { error } =
      await supabase
        .from('profiles')
        .update({
          [column]: value,
        })
        .eq(
          'id',
          user.id
        )

    if (error) {
      console.error(
        'SAVE SETTING ERROR:',
        error
      )

      setter(!value)

      alert(
        `Failed to save setting: ${error.message}`
      )
    }
  }

  const handleDarkMode =
    async () => {
      const newValue =
        !darkMode

      setDarkMode(
        newValue
      )

      document.documentElement.classList.toggle(
        'dark-mode',
        newValue
      )

      if (!user?.id) return

      const { error } =
        await supabase
          .from('profiles')
          .update({
            dark_mode:
              newValue,
          })
          .eq(
            'id',
            user.id
          )

      if (error) {
        console.error(
          'DARK MODE ERROR:',
          error
        )

        setDarkMode(
          !newValue
        )

        document.documentElement.classList.toggle(
          'dark-mode',
          !newValue
        )

        alert(
          `Failed to save dark mode: ${error.message}`
        )
      }
    }

  const handleSharePortfolio = async (event) => {
    event.preventDefault()
    const recipientEmail = shareEmail.trim()
    if (!user?.id) {
      setPortfolioShareError('Your account could not be identified. Please log in again.')
      return
    }
    if (!/^[^\s@]+@gmail\.com$/i.test(recipientEmail)) {
      setPortfolioShareError('Enter a valid Gmail address.')
      return
    }

    setSharingPortfolio(true)
    setPortfolioShareError('')
    setPortfolioShareSuccess('')
    try {
      const portfolioPdf = await createPortfolioPdf(user.id, {
        filename: 'i-WORKFOLIO-Portfolio.pdf',
        download: false,
      })
      const path = `${user.id}/shares/portfolio-${Date.now()}.pdf`
      const { error: uploadError } = await supabase.storage
        .from('portfolio-files')
        .upload(path, portfolioPdf, { contentType: 'application/pdf', upsert: false })
      if (uploadError) throw uploadError

      const { data: signed, error: signedError } = await supabase.storage
        .from('portfolio-files')
        .createSignedUrl(path, 7 * 24 * 60 * 60)
      if (signedError) throw signedError

      const { error: sendError } = await supabase.functions.invoke('share-portfolio', {
        body: { recipientEmail, portfolioUrl: signed.signedUrl },
      })
      if (sendError) throw sendError

      setPortfolioShareSuccess(`Portfolio link sent to ${recipientEmail}. The link expires in 7 days.`)
    } catch (error) {
      console.error('Share portfolio failed:', error)
      setPortfolioShareError(error?.message || 'Could not send the portfolio link.')
    } finally {
      setSharingPortfolio(false)
    }
  }

  if (loadingSettings) {
    return (
      <div className="dashboard-section">
        <p>
          Loading settings...
        </p>
      </div>
    )
  }

  return (
    <div className="dashboard-section">

      <p className="eyebrow">
        {teacherMode ? 'TEACHER' : 'STUDENT'} DASHBOARD / SETTINGS
      </p>

      <h1>
        Settings
      </h1>

      <p>Manage your preferences.</p>

      {!teacherMode && (
      <div className="settings-section">

        <div className="settings-section-header">

          <h2>
            Share Portfolio
          </h2>

          <p>
            Email a link to all four portfolio folders. The link expires in 7 days.
          </p>

        </div>

        <form className="settings-share-form" onSubmit={handleSharePortfolio}>
          <label htmlFor="portfolio-share-email">Recipient Gmail address</label>
          <div className="settings-share-controls">
            <input
              id="portfolio-share-email"
              type="email"
              value={shareEmail}
              onChange={(event) => {
                setShareEmail(event.target.value)
                setPortfolioShareError('')
                setPortfolioShareSuccess('')
              }}
              placeholder="name@gmail.com"
              autoComplete="email"
              required
              disabled={sharingPortfolio}
            />
            <button
              className="settings-action-btn"
              type="submit"
              disabled={sharingPortfolio}
            >
              <Send size={16} />
              {sharingPortfolio ? 'Sending...' : 'Share'}
            </button>
          </div>
        </form>

        {portfolioShareError && (
          <p className="settings-export-error" role="alert">
            {portfolioShareError}
          </p>
        )}
        {portfolioShareSuccess && (
          <p className="settings-share-success" role="status">
            {portfolioShareSuccess}
          </p>
        )}

      </div>
      )}

      <div className="settings-section">
        <div className="settings-section-header">
          <h2>Account</h2>
        </div>
        <div className="settings-info">
          <div className="settings-info-item">
            <span>Email</span>
            <strong>{user?.email || '—'}</strong>
          </div>
          <div className="settings-info-item">
            <span>Account Status</span>
            <strong>Active</strong>
          </div>
        </div>
      </div>

      <div className="settings-section">

        <div className="settings-section-header">

          <h2>
            Appearance
          </h2>

        </div>

        <SettingToggle
          label="Dark Mode"
          description="When off, follows your device theme."
          checked={darkMode}
          onChange={
            handleDarkMode
          }
        />

      </div>

      <div className="settings-danger">

        <div>

          <h2>
            Danger Zone
          </h2>

          <p>
            Permanently delete your account and all associated data.
          </p>

        </div>

        <button
          className="delete-account-btn"
          onClick={() => setDeleteDialog('password')}
        >
          Delete Account
        </button>

      </div>

      {deleteDialog && (
        <div className="account-delete-overlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeDeleteDialog()
        }}>
          <div className="account-delete-modal" role="dialog" aria-modal="true" aria-labelledby="delete-account-title">
            <button className="account-delete-close" type="button" onClick={closeDeleteDialog} aria-label="Close">
              <X size={20} />
            </button>

            {deleteDialog === 'password' && (
              <form onSubmit={handleDeletePassword}>
                <p className="account-delete-kicker">ACCOUNT SECURITY</p>
                <h2 id="delete-account-title">Delete Account</h2>
                <p>Enter your current password to begin the account deletion process.</p>
                <label htmlFor="delete-account-password">Current password</label>
                <div className="account-delete-password">
                  <input
                    id="delete-account-password"
                    type={showDeletePassword ? 'text' : 'password'}
                    value={deletePassword}
                    onChange={(event) => setDeletePassword(event.target.value)}
                    autoComplete="current-password"
                    disabled={deleteLoading}
                  />
                  <button type="button" onClick={() => setShowDeletePassword((visible) => !visible)}>
                    {showDeletePassword ? 'Hide' : 'Show'}
                  </button>
                </div>
                {deleteError && <p className="account-delete-error" role="alert">{deleteError}</p>}
                <div className="account-delete-actions">
                  <button type="button" className="account-delete-secondary" onClick={closeDeleteDialog}>Cancel</button>
                  <button type="submit" className="account-delete-danger" disabled={deleteLoading}>
                    {deleteLoading ? 'Verifying...' : 'Continue'}
                  </button>
                </div>
              </form>
            )}

            {deleteDialog === 'otp' && (
              <form onSubmit={handleDeleteOtp}>
                <p className="account-delete-kicker">EMAIL VERIFICATION</p>
                <h2 id="delete-account-title">Verify Your Email</h2>
                <p>Enter the 6-digit code sent to <strong>{maskedEmail}</strong>.</p>
                <label htmlFor="delete-account-otp">Verification code</label>
                <input
                  id="delete-account-otp"
                  className="account-delete-otp"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={deleteOtp}
                  onChange={(event) => setDeleteOtp(event.target.value.replace(/\D/g, '').slice(0, 6))}
                  disabled={deleteLoading}
                />
                {deleteError && <p className="account-delete-error" role="alert">{deleteError}</p>}
                <button type="button" className="account-delete-resend" onClick={handleResendDeletionOtp} disabled={deleteResendSeconds > 0 || deleteLoading}>
                  Resend Code {deleteResendSeconds > 0 ? `(${deleteResendSeconds}s)` : ''}
                </button>
                <div className="account-delete-actions">
                  <button type="button" className="account-delete-secondary" onClick={closeDeleteDialog}>Cancel</button>
                  <button type="submit" className="account-delete-danger" disabled={deleteLoading}>
                    {deleteLoading ? 'Verifying...' : 'Verify Code'}
                  </button>
                </div>
              </form>
            )}

            {deleteDialog === 'final' && (
              <div>
                <p className="account-delete-kicker account-delete-warning">FINAL WARNING</p>
                <h2 id="delete-account-title">Permanently delete account?</h2>
                <p className="account-delete-warning-text">
                  Are you absolutely sure you want to permanently delete your account? This action cannot be undone.
                </p>
                <label className="account-delete-confirm">
                  <input
                    type="checkbox"
                    checked={deleteFinalConfirmed}
                    onChange={(event) => setDeleteFinalConfirmed(event.target.checked)}
                    disabled={deleteLoading}
                  />
                  <span>I understand that this permanently deletes my account and data.</span>
                </label>
                {deleteError && <p className="account-delete-error" role="alert">{deleteError}</p>}
                <div className="account-delete-actions">
                  <button type="button" className="account-delete-secondary" onClick={closeDeleteDialog}>Cancel</button>
                  <button type="button" className="account-delete-danger" onClick={handlePermanentDeletion} disabled={deleteLoading}>
                    {deleteLoading ? 'Deleting...' : 'Permanently Delete Account'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  )
}

/* =========================
   SETTING TOGGLE
========================= */

function SettingToggle({
  label,
  description,
  checked,
  onChange,
}) {
  return (
    <div className="setting-row">

      <div className="setting-row-text">

        <strong>
          {label}
        </strong>

        {description && (
          <span>
            {description}
          </span>
        )}

      </div>

      <button
        type="button"
        className={`setting-toggle ${
          checked ? 'on' : ''
        }`}
        onClick={onChange}
        aria-label={`Toggle ${label}`}
      >
        <span></span>
      </button>

    </div>
  )
}

/* =========================
   MY PORTFOLIO
========================= */


const STUDENT_DUTIES_PHOTO_SECTION = 'Module Introduction/Student Duties Photo'

const PORTFOLIO_CHECKLIST_SECTIONS = [
  {
    number: 'I.',
    title: 'Pre-immersion',
    learnerOutputGroups: [
      {
        type: 'numbered',
        items: [
          'Enrolment Form',
          'Essay on the how to conduct oneself inside the work during the Immersion period',
          'Application Letter Addressed to the Principal',
          'Résumé',
          'Flow Chart of securing clearance documents',
        ],
      },
      {
        type: 'bullet',
        items: [
          'Barangay Clearance',
          'Police Clearance',
          'Mayors, Clearance',
          'Health Certificate',
        ],
      },
      {
        type: 'numbered',
        start: 6,
        items: ['Immersion List of Task', 'Duly Signed Parents’ Consent'],
      },
    ],
    documents: [
      'Essay',
      'Resume',
      'Application Letter',
      'Flow chart of securing Clearance Documents\nSigned List of Task\nParents Consent',
    ],
  },
  {
    number: 'II.',
    title: 'Immersion Proper',
    learnerOutputGroups: [
      {
        type: 'numbered',
        items: [
          'Agency organizational chart',
          'Work process flow charts.',
          'Work Immersion Map (google maps)',
          'Picture of Work (with caption)',
          'Picture with the personnel in the work simulation.',
          'Written narrative on the profile of the school as work simulation area(may contain charts, photos, or illustrations)',
          'Written report, journal or diary on the activities performed daily.',
          'Immersion Teacher/supervisor’s task rating.',
          'Accomplished Daily Time Record (DTR)',
          'Essay about the work/task.',
        ],
      },
    ],
    documents: [
      '-WCSAT Organization Chart\n-Work Simulation process flow chart',
      '-Narrative Report, journal or diaries with pictures and captions',
      '-Work Immersion Map Location (Home as the point of origin)',
      'Daily Task Record/Journal/Diaries\nDaily Time Record',
      'Evaluation Task Rating',
    ],
  },
  {
    number: 'III.',
    title: 'Post Immersion',
    learnerOutputGroups: [
      { type: 'numbered', items: ['Portfolio'] },
      {
        type: 'lettered',
        items: [
          'accomplished forms',
          'pictures of work site and nonwritten output/ projects with captions',
          'illustrations of activities performed (as needed)',
          'weekly diary (narrative/ account of learnings and achievements, issues faced and corresponding resolutions)',
          'sample written output (if any)',
          'Work Immersion highlights',
          'other relevant pictures/ documents',
          'Final Evaluation Rating',
        ],
      },
      {
        type: 'numbered',
        start: 2,
        items: ['gallery', 'updated résumé', 'reflection paper'],
      },
    ],
    documents: [
      'Written Report',
      'Accomplished Forms',
      'Sample Output',
      'Gallery',
      'Venn Diagram',
      'Updated Forms',
      'Self Evaluation',
      'Certificate of Completion',
      'DTR',
    ],
  },
]

function PortfolioChecklistPage({ user }) {
  const [dates, setDates] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const datesRef = useRef({})
  const CHECKLIST_SECTION = 'Module Introduction/Portfolio Checklist'

  useEffect(() => {
    let cancelled = false

    const loadChecklistDates = async () => {
      if (!user?.id) {
        setLoading(false)
        setErrorMessage('Your account could not be identified. Please log in again.')
        return
      }

      setLoading(true)
      setErrorMessage('')
      datesRef.current = {}
      setDates({})
      setHasUnsavedChanges(false)

      try {
        const { data, error } = await loadPortfolioEntry(supabase, user.id, CHECKLIST_SECTION)

        if (error) throw error

        let content = data?.content
        if (typeof content === 'string') {
          content = JSON.parse(content)
        }
        const savedDates = content?.dates || {}
        if (typeof savedDates !== 'object' || Array.isArray(savedDates)) {
          throw new Error('Saved checklist dates have an invalid format.')
        }

        if (!cancelled) {
          datesRef.current = savedDates
          setDates(savedDates)
          setHasUnsavedChanges(false)
        }
      } catch (error) {
        console.error('Load Portfolio Checklist dates failed:', error)
        if (!cancelled) {
          setErrorMessage(error?.message || 'Could not load saved checklist dates.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadChecklistDates()
    return () => { cancelled = true }
  }, [user?.id])

  const handleDateChange = (dateKey, value) => {
    const nextDates = { ...datesRef.current, [dateKey]: value }
    datesRef.current = nextDates
    setDates(nextDates)
    setHasUnsavedChanges(true)
    setErrorMessage('')
    setStatusMessage('')

  }

  const handleSaveDates = async () => {
    if (!user?.id) {
      setErrorMessage('Your account could not be identified. Please log in again.')
      return
    }
    setSaving(true)
    setErrorMessage('')
    setStatusMessage('')
    const datesToSave = { ...datesRef.current }

    try {
      const { error } = await savePortfolioEntry(supabase, {
        user_id: user.id,
        section: CHECKLIST_SECTION,
        content: { dates: datesToSave },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,section' })

      if (error) throw error
      setHasUnsavedChanges(false)
      setStatusMessage('Checklist saved. Your dates will remain after reopening this page.')
    } catch (error) {
      console.error('Save Portfolio Checklist failed:', error)
      setErrorMessage(error?.message || 'Could not save the checklist.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="module-card" style={{ fontWeight: 700 }}>
      <h2>WORK IMMERSION PORTFOLIO CHECKLIST</h2>
      <div className="checklist-table">
        <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', background: '#fff', color: '#000', fontWeight: 700 }}>
          <colgroup>
            <col style={{ width: '42%' }} />
            <col style={{ width: '38%' }} />
            <col style={{ width: '20%' }} />
          </colgroup>
          <thead>
            <tr>
              {['LEARNER’S OUTPUT', 'Documents Required', 'Date Accomplished'].map((heading) => (
                <th
                  key={heading}
                  scope="col"
                  style={{
                    padding: '14px 12px',
                    border: '1px solid #d1d5db',
                    background: '#fff',
                    textAlign: 'left',
                    verticalAlign: 'middle',
                    fontWeight: 700,
                    color: '#000',
                  }}
                >
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          {PORTFOLIO_CHECKLIST_SECTIONS.map((section) => (
            <tbody key={section.title}>
              <tr>
                <th
                  colSpan={3}
                  scope="rowgroup"
                  style={{
                    padding: '12px',
                    border: '1px solid #d1d5db',
                    background: '#fff',
                    textAlign: 'left',
                    fontWeight: 700,
                    color: '#000',
                  }}
                >
                  {section.number} {section.title}
                </th>
              </tr>
              {section.documents.map((document, documentIndex) => {
                const dateKey = `${section.title}-${documentIndex}`
                return (
                  <tr key={dateKey}>
                    {documentIndex === 0 && (
                      <td
                        rowSpan={section.documents.length}
                        style={{
                          padding: 12,
                          border: '1px solid #d1d5db',
                          verticalAlign: 'top',
                          lineHeight: 1.5,
                          fontWeight: 700,
                          color: '#000',
                        }}
                      >
                        {section.learnerOutputGroups.map((group, groupIndex) => {
                          const List = group.type === 'bullet' ? 'ul' : 'ol'
                          return (
                            <List
                              key={`${section.title}-output-group-${groupIndex}`}
                              start={group.type === 'numbered' ? group.start : undefined}
                              type={group.type === 'lettered' ? 'a' : undefined}
                              style={{ margin: '0 0 8px', paddingLeft: 24 }}
                            >
                              {group.items.map((output) => (
                                <li key={output} style={{ marginBottom: 4 }}>{output}</li>
                              ))}
                            </List>
                          )
                        })}
                      </td>
                    )}
                    <td
                      style={{
                        padding: 12,
                        border: '1px solid #d1d5db',
                        verticalAlign: 'middle',
                        whiteSpace: 'pre-line',
                        lineHeight: 1.5,
                        fontWeight: 700,
                        color: '#000',
                      }}
                    >
                      {document}
                    </td>
                    <td style={{ padding: 10, border: '1px solid #d1d5db', verticalAlign: 'middle', color: '#000' }}>
                      <input
                        type="date"
                        aria-label={`Date accomplished for ${document.replace(/\n/g, ', ')}`}
                        value={dates[dateKey] || ''}
                        onChange={(event) => handleDateChange(dateKey, event.target.value)}
                        disabled={loading || saving || !user?.id}
                        style={{
                          width: '100%',
                          minWidth: 0,
                          boxSizing: 'border-box',
                          padding: '8px',
                          border: '1px solid #d1d5db',
                          borderRadius: 4,
                          background: '#fff',
                          font: 'inherit',
                          fontWeight: 700,
                          color: '#000',
                        }}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          ))}
        </table>
      </div>
      {loading && <p role="status">Loading saved dates...</p>}
      <button
        type="button"
        className="primary-btn"
        onClick={handleSaveDates}
        disabled={loading || saving || !user?.id || !hasUnsavedChanges}
        style={{
          marginTop: 16,
          color: '#000',
          padding: '12px 28px',
          fontSize: 16,
          fontWeight: 700,
          border: '2px solid #000',
        }}
      >
        {saving ? 'Saving...' : 'Save'}
      </button>
      {saving && <p role="status">Saving checklist...</p>}
      {errorMessage && <p role="alert" style={{ color: '#b91c1c' }}>{errorMessage}</p>}
      {statusMessage && !saving && <p role="status" style={{ color: '#166534' }}>{statusMessage}</p>}
    </div>
  )
}

function RequirementsChecklistPage({ user, onBack }) {
  const [formValues, setFormValues] = useState({ details: {}, requirements: {} })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const CHECKLIST_SECTION = 'Pre-Immersion/Requirements Checklist'
  const requirements = [
    'Resume in prescribed format',
    'Parents’ / Guardians’ Consent',
    'List of Task/Activities',
    'Photocopy of the school ID',
    'Photocopy of Insurance',
    'Pre-Immersion Orientation',
    'Initial Interview',
  ]
  const detailRows = [
    [
      { key: 'studentName', label: 'Student Name:' },
      { key: 'gradeSection', label: 'Grade/Section:' },
    ],
    [
      { key: 'track', label: 'Track:' },
      { key: 'strand', label: 'Strand:' },
      { key: 'specialization', label: 'Specialization:' },
    ],
    [
      { key: 'studentContact', label: 'Contact No.' },
      { key: 'lrn', label: 'LRN #' },
    ],
    [
      { key: 'parentGuardian', label: 'Parent/Guardian:' },
      { key: 'parentContact', label: 'Contact No.:' },
    ],
    [
      { key: 'classAdviser', label: 'Class Adviser:' },
      { key: 'adviserContact', label: 'Contact No.:' },
    ],
    [
      { key: 'immersionTeacher', label: 'Work Immersion Teacher:' },
      { key: 'teacherContact', label: 'Contact No.:' },
    ],
  ]
  const classScheduleColumns = ['Subject', 'Units', 'Grade/Section', 'Time', 'Days', 'Room']

  useEffect(() => {
    let cancelled = false

    const loadChecklist = async () => {
      if (!user?.id) {
        setLoading(false)
        setErrorMessage('Your account could not be identified. Please log in again.')
        return
      }

      setLoading(true)
      setErrorMessage('')
      setFormValues({ details: {}, requirements: {} })

      try {
        const { data, error } = await loadPortfolioEntry(supabase, user.id, CHECKLIST_SECTION)

        if (error) throw error

        let content = data?.content
        if (typeof content === 'string') {
          content = JSON.parse(content)
        }

        if (content !== undefined && content !== null) {
          if (
            typeof content !== 'object' ||
            Array.isArray(content) ||
            typeof content.details !== 'object' ||
            Array.isArray(content.details) ||
            typeof content.requirements !== 'object' ||
            Array.isArray(content.requirements)
          ) {
            throw new Error('Saved checklist data has an invalid format.')
          }
          if (!cancelled) {
            setFormValues({
              details: content.details,
              requirements: content.requirements,
            })
          }
        }
      } catch (error) {
        console.error('Load Pre-Immersion Requirements Checklist failed:', error)
        if (!cancelled) {
          setErrorMessage(error?.message || 'Could not load saved checklist information.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadChecklist()
    return () => { cancelled = true }
  }, [user?.id])

  const updateFormValue = (group, key, value) => {
    setFormValues((current) => ({
      ...current,
      [group]: { ...current[group], [key]: value },
    }))
    setErrorMessage('')
    setStatusMessage('')
  }

  const handleSave = async () => {
    if (!user?.id) {
      setErrorMessage('Your account could not be identified. Please log in again.')
      return
    }

    setSaving(true)
    setErrorMessage('')
    setStatusMessage('')

    try {
      const { error } = await savePortfolioEntry(supabase, {
        user_id: user.id,
        section: CHECKLIST_SECTION,
        content: formValues,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,section' })

      if (error) throw error
      setStatusMessage('Checklist saved. Your information will remain when you reopen this page.')
    } catch (error) {
      console.error('Save Pre-Immersion Requirements Checklist failed:', error)
      setErrorMessage(error?.message || 'Could not save the checklist information.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="dashboard-section requirements-checklist-page class-schedule-page">
      <button
        type="button"
        className="portfolio-back-button"
        onClick={onBack}
      >
        ← Back to Pre-Immersion
      </button>

      <article className="requirements-checklist-document">
        <h1>PRE-IMMERSION REQUIREMENTS CHECKLIST</h1>

        <div className="requirements-checklist-details">
          {detailRows.map((row, rowIndex) => (
            <div
              className={`requirements-checklist-detail-row${row.length === 3 ? ' three-columns' : ''}`}
              key={rowIndex}
            >
              {row.map(({ key, label }) => (
                <label key={key}>
                  <span>{label}</span>
                  <input
                    type="text"
                    aria-label={label}
                    value={formValues.details[key] || ''}
                    disabled={loading || saving || !user?.id}
                    onChange={(event) => updateFormValue('details', key, event.target.value)}
                  />
                </label>
              ))}
            </div>
          ))}
        </div>

        <div className="requirements-checklist-table-wrap">
          <table className="requirements-checklist-table">
            <thead>
              <tr>
                <th scope="col">REQUIREMENTS</th>
                <th scope="col">Date Accomplished</th>
                <th scope="col">Remarks</th>
                <th scope="col">In-Charge</th>
                <th scope="col">Signature</th>
              </tr>
            </thead>
            <tbody>
              {requirements.map((requirement) => (
                <tr key={requirement}>
                  <td>{requirement}</td>
                  {['date', 'remarks', 'inCharge', 'signature'].map((field) => {
                    const key = `checklist-${requirement}-${field}`
                    return (
                      <td
                        key={field}
                        className={field === 'remarks' ? 'requirements-checklist-remark-cell' : undefined}
                      >
                        <input
                          className={field === 'remarks' ? 'requirements-checklist-remark-checkbox' : undefined}
                          type={field === 'date' ? 'date' : field === 'remarks' ? 'checkbox' : 'text'}
                          aria-label={`${field === 'date' ? 'Date accomplished' : field === 'inCharge' ? 'In-Charge' : field === 'remarks' ? 'Remarks' : field} for ${requirement}`}
                          checked={field === 'remarks'
                            ? Boolean(formValues.requirements[key] ?? formValues.requirements[`${requirement}-${field}`])
                            : undefined}
                          value={field === 'remarks' ? undefined : formValues.requirements[key] ?? formValues.requirements[`${requirement}-${field}`] ?? ''}
                          disabled={loading || saving || !user?.id}
                          onChange={(event) => updateFormValue(
                            'requirements',
                            key,
                            field === 'remarks' ? event.target.checked : event.target.value,
                          )}
                        />
                      </td>
                    )
                  })}
                </tr>
              ))}
              <tr>
                <td colSpan={5} className="requirements-checklist-legend-row">
                  Legend: &nbsp;&nbsp; √ Meets the criteria
                  &nbsp;&nbsp;&nbsp;&nbsp; ○Meet some aspect
                  &nbsp;&nbsp;&nbsp;&nbsp; ● Did not meet the criteria
                  &nbsp;&nbsp;&nbsp;&nbsp; × Did not comply
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="class-schedule-table-wrap requirements-checklist-schedule">
          <table className="class-schedule-table">
            <thead>
              <tr>
                <th colSpan={6}>
                  Class Schedule for the Current Semester(Refer to your class program)
                </th>
                <th className="class-schedule-separator" aria-hidden="true" />
                <th colSpan={2}>
                  Time Alloted for Work Immersion(Refer to the class immersion schedule)
                </th>
              </tr>
              <tr>
                {classScheduleColumns.map((column) => (
                  <th scope="col" key={column}>{column}</th>
                ))}
                <th className="class-schedule-separator" aria-hidden="true" />
                <th scope="col">Day/Date</th>
                <th scope="col">Time</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 10 }, (_, rowIndex) => (
                <tr key={rowIndex + 1}>
                  {classScheduleColumns.map((column, columnIndex) => {
                    const key = `class-${rowIndex}-${columnIndex}`
                    return (
                      <td key={column}>
                        <input
                          type="text"
                          aria-label={`${column}, schedule row ${rowIndex + 1}`}
                          value={formValues.requirements[key] || ''}
                          disabled={loading || saving || !user?.id}
                          onChange={(event) => updateFormValue('requirements', key, event.target.value)}
                        />
                      </td>
                    )
                  })}
                  <td className="class-schedule-separator" />
                  <td>{rowIndex + 1}</td>
                  <td>
                    <input
                      type="text"
                      aria-label={`Work immersion time, schedule row ${rowIndex + 1}`}
                      value={formValues.requirements[`immersion-time-${rowIndex}`] || ''}
                      disabled={loading || saving || !user?.id}
                      onChange={(event) => updateFormValue(
                        'requirements',
                        `immersion-time-${rowIndex}`,
                        event.target.value,
                      )}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <section className="class-schedule-certification">
          <p>
            This is to certify that the above student have completed the pre-immersion
            requirements and is recommended to endorse his/her application in:
          </p>
          <div className="class-schedule-certification-line company-name-line">
            <strong>Company Name:</strong>
            <input
              className="class-schedule-certification-input"
              type="text"
              aria-label="Company Name"
              value={formValues.requirements.certificationCompanyName ?? 'WESTERN CAGAYAN SCHOOL OF ARTS AND TRADES –'}
              disabled={loading || saving || !user?.id}
              onChange={(event) => updateFormValue('requirements', 'certificationCompanyName', event.target.value)}
            />
          </div>
          <label className="class-schedule-certification-line">
            <strong>Company Address:</strong>
            <input
              className="class-schedule-certification-input"
              type="text"
              aria-label="Company Address"
              value={formValues.requirements.certificationCompanyAddress ?? 'Centro 03, Lasam, Cagayan'}
              disabled={loading || saving || !user?.id}
              onChange={(event) => updateFormValue('requirements', 'certificationCompanyAddress', event.target.value)}
            />
          </label>
          <div className="class-schedule-certification-line contact-person-line">
            <strong>Contact Person:</strong>
            <input
              className="class-schedule-certification-input"
              type="text"
              aria-label="Contact Person"
              value={formValues.requirements.certificationContactPerson ?? 'DANIEL T. AUIDAN, PhD.'}
              disabled={loading || saving || !user?.id}
              onChange={(event) => updateFormValue('requirements', 'certificationContactPerson', event.target.value)}
            />
            <strong>Telephone No./s:</strong>
            <input
              className="class-schedule-certification-input telephone-input"
              type="text"
              aria-label="Company contact telephone number"
              value={formValues.requirements.certificationContact ?? ''}
              disabled={loading || saving || !user?.id}
              onChange={(event) => updateFormValue('requirements', 'certificationContact', event.target.value)}
            />
          </div>
          <label className="class-schedule-certification-line position-line">
            <strong>Position:</strong>
            <input
              className="class-schedule-certification-input"
              type="text"
              aria-label="Position"
              value={formValues.requirements.certificationPosition ?? 'Principal III, WCSAT.'}
              disabled={loading || saving || !user?.id}
              onChange={(event) => updateFormValue('requirements', 'certificationPosition', event.target.value)}
            />
          </label>
          <div className="class-schedule-certification-line">
            <strong>Endorsed by:</strong>
            <input
              className="class-schedule-certification-input"
              type="text"
              aria-label="Endorsed by"
              value={formValues.requirements.certificationEndorsedBy ?? 'VIVENCIO P. PASCUAL, JR.'}
              disabled={loading || saving || !user?.id}
              onChange={(event) => updateFormValue('requirements', 'certificationEndorsedBy', event.target.value)}
            />
          </div>
          <div className="class-schedule-certification-continuation endorser-role-continuation">
            Work Immersion Teacher
          </div>
        </section>
      </article>

      {loading && <p role="status">Loading saved checklist...</p>}
      {errorMessage && <p role="alert" className="requirements-checklist-error">{errorMessage}</p>}
      {statusMessage && !saving && <p role="status" className="requirements-checklist-status">{statusMessage}</p>}
      <button
        type="button"
        className="class-schedule-save"
        onClick={handleSave}
        disabled={loading || saving || !user?.id}
      >
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  )
}

function ParentConsentPage({ user, onBack }) {
  const [selectedPhoto, setSelectedPhoto] = useState(null)
  const [selectedPhotoUrl, setSelectedPhotoUrl] = useState('')
  const [savedPhoto, setSavedPhoto] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const CONSENT_SECTION = 'Pre-Immersion/Parent Consent'

  useEffect(() => {
    let cancelled = false

    const loadSavedConsent = async () => {
      if (!user?.id) {
        setLoading(false)
        setErrorMessage('Your account could not be identified. Please log in again.')
        return
      }

      setLoading(true)
      setErrorMessage('')

      try {
        const { data, error } = await loadPortfolioEntry(supabase, user.id, CONSENT_SECTION)
        if (error) throw error

        let content = data?.content
        if (typeof content === 'string') content = JSON.parse(content)
        const photoPath = content?.photo_path
        if (!photoPath) {
          if (!cancelled) setSavedPhoto(null)
          return
        }

        const { data: signed, error: signedError } = await getPortfolioSignedUrl(user.id, photoPath)
        if (signedError) throw signedError
        if (!cancelled) setSavedPhoto({ path: photoPath, url: signed.signedUrl })
      } catch (error) {
        console.error('Load Parent Consent photo failed:', error)
        if (!cancelled) setErrorMessage(error?.message || 'Could not load the saved consent photo.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadSavedConsent()
    return () => { cancelled = true }
  }, [user?.id])

  useEffect(() => {
    if (!selectedPhoto) {
      setSelectedPhotoUrl('')
      return undefined
    }
    const objectUrl = URL.createObjectURL(selectedPhoto)
    setSelectedPhotoUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [selectedPhoto])

  const handleSelectPhoto = (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setErrorMessage('Please select an image file.')
      return
    }
    setSelectedPhoto(file)
    setErrorMessage('')
    setStatusMessage('')
  }

  const handleSavePhoto = async () => {
    if (!selectedPhoto) {
      setErrorMessage('Select a photo of the signed consent before saving.')
      return
    }
    if (!user?.id) {
      setErrorMessage('Your account could not be identified. Please log in again.')
      return
    }

    setSaving(true)
    setErrorMessage('')
    setStatusMessage('')
    let uploadedPath = ''

    try {
      const safeName = selectedPhoto.name.replace(/[^a-zA-Z0-9._-]/g, '_')
      uploadedPath = `${user.id}/parent-consent/${Date.now()}-${safeName}`
      await savePortfolioPhoto(user.id, uploadedPath, selectedPhoto)

      const { data: signed, error: signedError } = await getPortfolioSignedUrl(user.id, uploadedPath)
      if (signedError) throw signedError

      const { error: saveError } = await savePortfolioEntry(supabase, {
        user_id: user.id,
        section: CONSENT_SECTION,
        content: { photo_path: uploadedPath },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,section' })
      if (saveError) throw saveError

      setSavedPhoto({ path: uploadedPath, url: signed.signedUrl })
      setSelectedPhoto(null)
      setStatusMessage('Signed Parent Consent photo saved.')
    } catch (error) {
      console.error('Save Parent Consent photo failed:', error)
      if (uploadedPath) {
        const { error: cleanupError } = await supabase.storage
          .from('portfolio-files')
          .remove([uploadedPath])
        if (cleanupError) {
          console.error('Could not remove the unsaved Parent Consent photo:', cleanupError)
        }
      }
      setErrorMessage(error?.message || 'Could not save the signed consent photo.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="dashboard-section parent-consent-page">
      <button
        type="button"
        className="portfolio-back-button"
        onClick={onBack}
      >
        ← Back to Pre-Immersion
      </button>

      <p className="eyebrow">STUDENT DASHBOARD / MY PORTFOLIO / PRE-IMMERSION</p>
      <h1>Parent Consent</h1>
      <p>Download the Parent Consent form below.</p>
      <a
        className="primary-btn parent-consent-download"
        href="/Parent%20Consent.docx"
        download="Parent Consent.docx"
      >
        Download Parent Consent
      </a>
      <section className="parent-consent-upload">
        <h2>Upload the signed Consent here.</h2>
        <label className="parent-consent-upload-box">
          {selectedPhotoUrl || savedPhoto?.url ? (
            <img
              src={selectedPhotoUrl || savedPhoto.url}
              alt="Preview of signed Parent Consent"
            />
          ) : (
            <>
              <span className="parent-consent-upload-icon">+</span>
              <span>{loading ? 'Loading saved consent...' : 'Choose a photo of the signed consent'}</span>
              <span className="parent-consent-upload-hint">JPG, PNG, or other image formats</span>
            </>
          )}
          <input
            type="file"
            accept="image/*"
            hidden
            disabled={loading || saving || !user?.id}
            onChange={handleSelectPhoto}
          />
        </label>
        {errorMessage && <p role="alert" className="parent-consent-message error">{errorMessage}</p>}
        {statusMessage && <p role="status" className="parent-consent-message">{statusMessage}</p>}
        <button
          type="button"
          className="parent-consent-save"
          onClick={handleSavePhoto}
          disabled={loading || saving || !user?.id}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </section>
    </div>
  )
}

function ListOfTaskPage({ user, onBack }) {
  const [answers, setAnswers] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const TASK_LIST_SECTION = 'Pre-Immersion/List of Task'
  const taskRows = [
    ['Assemble Computer Hardware', '', '', '', ''],
    ['Prepare Installers', '', '', '', ''],
    ['Install Operating System and Drivers', '', '', '', ''],
    [
      'Install Application Softwares',
      'Install and use MS Office\nInstall and use Photoshop',
      '8 hrs\n8 hrs',
      'Jan 22, 2025\nJan 23, 2025',
      'Completed',
    ],
    ['Install Network Cables', '', '', '', ''],
    ['Set-up Network Configuration', '', '', '', ''],
    ['Set router WIFI or wireless access point', '', '', '', ''],
    ['Set-up user access', '', '', '', ''],
    ['Configure network services', '', '', '', ''],
    ['Perform Testing, documentation and pre deployment procedure', '', '', '', ''],
    ['Plan and Prepare maintenance and repair', '', '', '', ''],
    ['Maintain computer systems and networks', '', '', '', ''],
    ['Diagnose faults of computer system and networks', '', '', '', ''],
    ['Rectify/ correct defects in computer system and networks', '', '', '', ''],
  ]
  const updateAnswer = (key, value) => {
    setAnswers((current) => ({ ...current, [key]: value }))
    setErrorMessage('')
    setStatusMessage('')
  }
  const answerBox = (key, label, className = '') => (
    <input
      className={`task-list-answer ${className}`.trim()}
      type="text"
      aria-label={label}
      value={answers[key] || ''}
      disabled={loading || saving || !user?.id}
      onChange={(event) => updateAnswer(key, event.target.value)}
    />
  )

  useEffect(() => {
    let cancelled = false

    const loadTaskList = async () => {
      if (!user?.id) {
        setLoading(false)
        setErrorMessage('Your account could not be identified. Please log in again.')
        return
      }

      setLoading(true)
      setErrorMessage('')
      setAnswers({})

      try {
        const { data, error } = await loadPortfolioEntry(supabase, user.id, TASK_LIST_SECTION)
        if (error) throw error

        let content = data?.content
        if (typeof content === 'string') content = JSON.parse(content)
        if (content !== undefined && content !== null) {
          if (typeof content !== 'object' || Array.isArray(content)) {
            throw new Error('Saved List of Task data has an invalid format.')
          }
          if (!cancelled) setAnswers(content)
        }
      } catch (error) {
        console.error('Load Pre-Immersion List of Task failed:', error)
        if (!cancelled) {
          setErrorMessage(error?.message || 'Could not load saved task list answers.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadTaskList()
    return () => { cancelled = true }
  }, [user?.id])

  const handleSave = async () => {
    if (!user?.id) {
      setErrorMessage('Your account could not be identified. Please log in again.')
      return
    }

    setSaving(true)
    setErrorMessage('')
    setStatusMessage('')

    try {
      const { error } = await savePortfolioEntry(supabase, {
        user_id: user.id,
        section: TASK_LIST_SECTION,
        content: answers,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,section' })
      if (error) throw error
      setStatusMessage('List of Task saved. Your answers will remain when you reopen this panel.')
    } catch (error) {
      console.error('Save Pre-Immersion List of Task failed:', error)
      setErrorMessage(error?.message || 'Could not save the task list answers.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="dashboard-section task-list-page">
      <button
        type="button"
        className="portfolio-back-button"
        onClick={onBack}
      >
        ← Back to Pre-Immersion
      </button>

      <article className="task-list-document">
        <h1>LIST OF TASKS / ACTIVITIES</h1>

        <div className="task-list-table-wrap">
          <table className="task-list-info-table">
            <tbody>
              <tr>
                <th>Name of Student</th>
                <td>{answerBox('studentName', 'Name of Student')}</td>
                <th>Grade and Section</th>
                <td>Grade 12 – ICT</td>
              </tr>
              <tr>
                <th>School</th>
                <td>Western Cagayan School of Arts and Trades</td>
                <th>Immersion Venue</th>
                <td>WCSAT – Immersion Work Simulation, 2nd Floor ICT Building.</td>
              </tr>
              <tr>
                <th>Track</th>
                <td>TVL</td>
                <th>Strand / Specializaton</th>
                <td>ICT / CSS</td>
              </tr>
              <tr>
                <th>Duration of Work Immersion</th>
                <td colSpan={3}>Total               - 240 Hrs</td>
              </tr>
              <tr>
                <th>School Parnerships Focal Person</th>
                <td>{answerBox('focalPerson', 'School Partnerships Focal Person')}</td>
                <th>Contact Number</th>
                <td>{answerBox('focalPersonContact', 'Focal Person Contact Number')}</td>
              </tr>
              <tr>
                <th>Work Immersion Teacher</th>
                <td>VIVENCIO P. PASCUAL, JR</td>
                <th>Contact Number</th>
                <td>09953856114</td>
              </tr>
            </tbody>
          </table>
        </div>

        <h2>LIST OF TASKS / ACTIVITIES</h2>
        <div className="task-list-table-wrap">
          <table className="task-list-activities-table">
            <thead>
              <tr>
                <th scope="col">Competencies</th>
                <th scope="col">Tasks / Activities</th>
                <th scope="col">Time Allotment(hr)</th>
                <th scope="col">Actual Schedule(Refer to the given schedule below)</th>
                <th scope="col">Remarks</th>
              </tr>
            </thead>
            <tbody>
              {taskRows.map(([competency, tasks, time, schedule, remarks]) => (
                <tr key={competency}>
                  <td>{competency}</td>
                  {[tasks, time, schedule, remarks].map((value, fieldIndex) => {
                    const field = ['tasks', 'time', 'schedule', 'remarks'][fieldIndex]
                    const key = `${competency}-${field}`
                    return (
                      <td key={field}>
                        {value || answerBox(key, `${field} for ${competency}`)}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="task-list-notice">
          Students shall not be given other activities outside of those previously agreed upon,
          which are anchored on the stated competencies.
        </p>
        <p className="task-list-certified">Certified true and correct:</p>

        <div className="task-list-table-wrap">
          <table className="task-list-signature-table">
            <tbody>
              <tr>
                <td>
                  {answerBox('studentSignature', 'Student signature over printed name')}
                  <br />
                  Student’s Signature Over Printed Name
                </td>
                <td>
                  {answerBox('parentSignature', 'Parent signature over printed name')}
                  <br />
                  Parent’s Signature Over Printed Name
                </td>
              </tr>
              <tr>
                <td>
                  {answerBox('teacherSignature', 'Work Immersion Teacher signature', 'task-list-signature-line')}
                  <br />
                  VIVENCIO P. PASCUAL, JR
                  <br />
                  Work Immersion Teacher Signature Over Printed
                </td>
                <td>
                  {answerBox('supervisorSignature', 'Work Immersion Supervisor signature', 'task-list-signature-line')}
                  <br />
                  EXCELSIS G. PASTOR, PhD.
                  <br />
                  Work Immersion Supervisor Signature Over Printed
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </article>
      {loading && <p role="status">Loading saved task list...</p>}
      {errorMessage && <p role="alert" className="task-list-message error">{errorMessage}</p>}
      {statusMessage && !saving && <p role="status" className="task-list-message">{statusMessage}</p>}
      <button
        type="button"
        className="task-list-save"
        onClick={handleSave}
        disabled={loading || saving || !user?.id}
      >
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  )
}

function WorkplaceConductEssayPage({ user, onBack }) {
  const [answers, setAnswers] = useState({ title: '', essay: '', preparedBy: '' })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const ESSAY_SECTION = 'Pre-Immersion/Essay on Workplace Conduct'
  const guideQuestions = [
    'Paragraph 1: What are the questions that you ask yourself when you were informed that you will undergo work immersion and where did you get the answers to your questions?',
    'Paragraph 2: What are the behaviors expected from you in your work immersion?',
    'List characteristics of a responsible employee',
    'Describe ways you can get along with your supervisor / immersion teacher',
    'Describe ways you can get along with co-workers / fellow immersionists',
    'Describe ways you can get along with customers',
    'Describe work rules for your job.',
    'Paragraph 3: Name at least top 5 rules and regulation in your work immersion venue that you should strictly follow?',
    'Paragraph 4: Discuss your understanding on the terms and conditions of work immersion simulation in times of pandemic.',
    'Paragraph 5: Discuss the required credentials for your work immersion and its importance?',
    'Paragraph 5: Why is there a need for Portfolio presentation at the end of Work Immersion? What should be the content of a work Immersion Portfolio?',
  ]

  useEffect(() => {
    let cancelled = false

    const loadEssay = async () => {
      if (!user?.id) {
        setLoading(false)
        setErrorMessage('Your account could not be identified. Please log in again.')
        return
      }

      setLoading(true)
      setErrorMessage('')
      setAnswers({ title: '', essay: '', preparedBy: '' })

      try {
        const { data, error } = await loadPortfolioEntry(supabase, user.id, ESSAY_SECTION)
        if (error) throw error

        let content = data?.content
        if (typeof content === 'string') content = JSON.parse(content)
        if (content !== undefined && content !== null) {
          if (typeof content !== 'object' || Array.isArray(content)) {
            throw new Error('Saved essay data has an invalid format.')
          }
          if (!cancelled) {
            setAnswers({
              title: typeof content.title === 'string' ? content.title : '',
              essay: typeof content.essay === 'string' ? content.essay : '',
              preparedBy: typeof content.preparedBy === 'string' ? content.preparedBy : '',
            })
          }
        }
      } catch (error) {
        console.error('Load Workplace Conduct Essay failed:', error)
        if (!cancelled) {
          setErrorMessage(error?.message || 'Could not load the saved essay.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadEssay()
    return () => { cancelled = true }
  }, [user?.id])

  const updateAnswer = (field, value) => {
    setAnswers((current) => ({ ...current, [field]: value }))
    setErrorMessage('')
    setStatusMessage('')
  }

  const handleSave = async () => {
    if (!user?.id) {
      setErrorMessage('Your account could not be identified. Please log in again.')
      return
    }

    setSaving(true)
    setErrorMessage('')
    setStatusMessage('')

    try {
      const { error } = await savePortfolioEntry(supabase, {
        user_id: user.id,
        section: ESSAY_SECTION,
        content: answers,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,section' })
      if (error) throw error
      setStatusMessage('Essay saved. Your answers will remain when you reopen this panel.')
    } catch (error) {
      console.error('Save Workplace Conduct Essay failed:', error)
      setErrorMessage(error?.message || 'Could not save the essay.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="dashboard-section workplace-essay-page">
      <button
        type="button"
        className="portfolio-back-button"
        onClick={onBack}
      >
        ← Back to Pre-Immersion
      </button>

      <article className="workplace-essay-document">
        <h1>Pre-immersion Requirements</h1>
        <h2>ESSAY</h2>
        <p className="workplace-essay-instructions">
          Write an essay on how to conduct oneself inside the workplace during the Immersion period.
          Create your own title, use the format on the box and guide questions below to complete your essay.
        </p>

        <label className="workplace-essay-title-field">
          <span>Title</span>
          <input
            type="text"
            value={answers.title}
            disabled={loading || saving || !user?.id}
            onChange={(event) => updateAnswer('title', event.target.value)}
            aria-label="Essay title"
          />
        </label>

        <div className="workplace-essay-questions">
          {guideQuestions.map((question, index) => (
            <p key={`${index}-${question}`}>{question}</p>
          ))}
        </div>

        <label className="workplace-essay-body-field">
          <span>Title / Essay</span>
          <textarea
            value={answers.essay}
            disabled={loading || saving || !user?.id}
            onChange={(event) => updateAnswer('essay', event.target.value)}
            aria-label="Write your essay"
            rows={18}
          />
        </label>
    
        <div className="workplace-essay-prepared-by">
          <strong>Prepared by:</strong>
          <input
            type="text"
            value={answers.preparedBy}
            disabled={loading || saving || !user?.id}
            onChange={(event) => updateAnswer('preparedBy', event.target.value)}
            aria-label="Student’s Name and Signature"
          />
          <span>Student’s Name and Signature</span>
        </div>
      </article>

      {loading && <p role="status">Loading saved essay...</p>}
      {errorMessage && <p role="alert" className="workplace-essay-message error">{errorMessage}</p>}
      {statusMessage && !saving && <p role="status" className="workplace-essay-message">{statusMessage}</p>}
      <button
        type="button"
        className="workplace-essay-save"
        onClick={handleSave}
        disabled={loading || saving || !user?.id}
      >
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  )
}

function ApplicationLetterPage({ user, onBack }) {
  const [answers, setAnswers] = useState({ date: '', letter: '', signature: '' })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const LETTER_SECTION = 'Pre-Immersion/Application Letter'

  useEffect(() => {
    let cancelled = false

    const loadLetter = async () => {
      if (!user?.id) {
        setLoading(false)
        setErrorMessage('Your account could not be identified. Please log in again.')
        return
      }

      setLoading(true)
      setErrorMessage('')
      setAnswers({ date: '', letter: '', signature: '' })

      try {
        const { data, error } = await loadPortfolioEntry(supabase, user.id, LETTER_SECTION)
        if (error) throw error

        let content = data?.content
        if (typeof content === 'string') content = JSON.parse(content)
        if (content !== undefined && content !== null) {
          if (typeof content !== 'object' || Array.isArray(content)) {
            throw new Error('Saved application letter data has an invalid format.')
          }
          if (!cancelled) {
            setAnswers({
              date: typeof content.date === 'string' ? content.date : '',
              letter: typeof content.letter === 'string' ? content.letter : '',
              signature: typeof content.signature === 'string' ? content.signature : '',
            })
          }
        }
      } catch (error) {
        console.error('Load Application Letter failed:', error)
        if (!cancelled) {
          setErrorMessage(error?.message || 'Could not load the saved application letter.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadLetter()
    return () => { cancelled = true }
  }, [user?.id])

  const updateAnswer = (field, value) => {
    setAnswers((current) => ({ ...current, [field]: value }))
    setErrorMessage('')
    setStatusMessage('')
  }

  const handleSave = async () => {
    if (!user?.id) {
      setErrorMessage('Your account could not be identified. Please log in again.')
      return
    }

    setSaving(true)
    setErrorMessage('')
    setStatusMessage('')

    try {
      const { error } = await savePortfolioEntry(supabase, {
        user_id: user.id,
        section: LETTER_SECTION,
        content: answers,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,section' })
      if (error) throw error
      setStatusMessage('Application letter saved. Your entries will remain when you reopen this panel.')
    } catch (error) {
      console.error('Save Application Letter failed:', error)
      setErrorMessage(error?.message || 'Could not save the application letter.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="dashboard-section application-letter-page">
      <button
        type="button"
        className="portfolio-back-button"
        onClick={onBack}
      >
        ← Back to Pre-Immersion
      </button>

      <article className="application-letter-document">
        <h1>APPLICATION LETTER</h1>

        <label className="application-letter-date">
          <strong>DATE:</strong>
          <input
            type="date"
            aria-label="Date"
            value={answers.date}
            disabled={loading || saving || !user?.id}
            onChange={(event) => updateAnswer('date', event.target.value)}
          />
        </label>

        <div className="application-letter-recipient">
          <strong>EXCLESIS G. PASTOR, PhD.</strong>
          <span>Principal III,</span>
          <span>Western Cagayan School of Arts and Trades</span>
          <span>Centro 03, Lasam, Cagayan</span>
        </div>

        <p className="application-letter-salutation">Sir:</p>
        <textarea
          className="application-letter-body"
          aria-label="Application letter"
          value={answers.letter}
          disabled={loading || saving || !user?.id}
          onChange={(event) => updateAnswer('letter', event.target.value)}
        />

        <div className="application-letter-closing">
          <p>Very truly yours,</p>
          <input
            type="text"
            aria-label="Name and signature"
            value={answers.signature}
            disabled={loading || saving || !user?.id}
            onChange={(event) => updateAnswer('signature', event.target.value)}
          />
          <span>Name and Signature</span>
        </div>
      </article>

      {loading && <p role="status">Loading saved application letter...</p>}
      {errorMessage && <p role="alert" className="application-letter-message error">{errorMessage}</p>}
      {statusMessage && !saving && <p role="status" className="application-letter-message">{statusMessage}</p>}
      <button
        type="button"
        className="application-letter-save"
        onClick={handleSave}
        disabled={loading || saving || !user?.id}
      >
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  )
}

function ResumePage({ user, onBack }) {
  const [values, setValues] = useState({})
  const [selectedPhoto, setSelectedPhoto] = useState(null)
  const [savedPhoto, setSavedPhoto] = useState(null)
  const [photoPreview, setPhotoPreview] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const RESUME_SECTION = 'Pre-Immersion/Resume'

  const personalInformation = [
    ['age', 'Age'],
    ['dateOfBirth', 'Date of Birth'],
    ['gender', 'Gender'],
    ['civilStatus', 'Civil Status'],
    ['citizenship', 'Citizenship'],
    ['height', 'Height'],
    ['weight', 'Weight'],
    ['religion', 'Religion'],
    ['father', 'Father'],
    ['mother', 'Mother'],
  ]

  const resumeSections = [
    ['eligibility', 'ELIGIBILITY'],
    ['workExperience', 'WORK EXPERIENCE'],
    ['seminars', 'SEMINAR/TRAININGS ATTENDED'],
    ['skills', 'SKILLS AND INTEREST'],
    ['references', 'CHARACTER REFERENCE'],
  ]

  useEffect(() => {
    let cancelled = false

    const loadResume = async () => {
      if (!user?.id) {
        setLoading(false)
        setErrorMessage('Your account could not be identified. Please log in again.')
        return
      }

      setLoading(true)
      setErrorMessage('')
      setValues({})
      setSavedPhoto(null)

      try {
        const { data, error } = await loadPortfolioEntry(supabase, user.id, RESUME_SECTION)
        if (error) throw error

        let content = data?.content
        if (typeof content === 'string') content = JSON.parse(content)
        if (content !== undefined && content !== null) {
          if (typeof content !== 'object' || Array.isArray(content)) {
            throw new Error('Saved resume data has an invalid format.')
          }
          const { photo_path: photoPath, ...savedValues } = content
          if (!cancelled) setValues(savedValues)
          if (photoPath) {
            const { data: signed, error: signedError } = await getPortfolioSignedUrl(user.id, photoPath)
            if (signedError) throw signedError
            if (!cancelled) setSavedPhoto({ path: photoPath, url: signed.signedUrl })
          }
        }
      } catch (error) {
        console.error('Load Pre-Immersion Resume failed:', error)
        if (!cancelled) {
          setErrorMessage(error?.message || 'Could not load the saved resume.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadResume()
    return () => { cancelled = true }
  }, [user?.id])

  useEffect(() => {
    if (!selectedPhoto) {
      setPhotoPreview('')
      return undefined
    }
    const objectUrl = URL.createObjectURL(selectedPhoto)
    setPhotoPreview(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [selectedPhoto])

  const updateValue = (key, value) => {
    setValues((current) => ({ ...current, [key]: value }))
    setErrorMessage('')
    setStatusMessage('')
  }

  const handlePhotoSelect = (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setErrorMessage('Please choose an image file.')
      return
    }
    setSelectedPhoto(file)
    setErrorMessage('')
    setStatusMessage('')
  }

  const handleSave = async () => {
    if (!user?.id) {
      setErrorMessage('Your account could not be identified. Please log in again.')
      return
    }

    setSaving(true)
    setErrorMessage('')
    setStatusMessage('')
    let uploadedPath = ''
    let uploadedPhotoUrl = ''

    try {
      let photoPath = savedPhoto?.path || null
      if (selectedPhoto) {
        const safeName = selectedPhoto.name.replace(/[^a-zA-Z0-9._-]/g, '_')
        uploadedPath = `${user.id}/resume/${Date.now()}-${safeName}`
        await savePortfolioPhoto(user.id, uploadedPath, selectedPhoto)
        const { data: signed, error: signedError } = await getPortfolioSignedUrl(user.id, uploadedPath)
        if (signedError) throw signedError
        uploadedPhotoUrl = signed.signedUrl
        photoPath = uploadedPath
      }

      const { error } = await savePortfolioEntry(supabase, {
        user_id: user.id,
        section: RESUME_SECTION,
        content: { ...values, photo_path: photoPath },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,section' })
      if (error) throw error

      if (uploadedPath) {
        setSavedPhoto({ path: uploadedPath, url: uploadedPhotoUrl })
        setSelectedPhoto(null)
      }
      setStatusMessage('Resume saved. Your entries will remain when you reopen this panel.')
    } catch (error) {
      console.error('Save Pre-Immersion Resume failed:', error)
      if (uploadedPath) {
        const { error: cleanupError } = await supabase.storage
          .from('portfolio-files')
          .remove([uploadedPath])
        if (cleanupError) {
          console.error('Could not remove the unsaved resume photo:', cleanupError)
        }
      }
      setErrorMessage(error?.message || 'Could not save the resume.')
    } finally {
      setSaving(false)
    }
  }

  const textField = (key, label, className = '') => (
    <label className={`resume-field ${className}`.trim()} key={key}>
      <span>{label}</span>
      <input
        type="text"
        aria-label={label}
        value={values[key] || ''}
        disabled={loading || saving || !user?.id}
        onChange={(event) => updateValue(key, event.target.value)}
      />
    </label>
  )

  return (
    <div className="dashboard-section resume-page">
      <button
        type="button"
        className="portfolio-back-button"
        onClick={onBack}
      >
        ← Back to Pre-Immersion
      </button>

      <article className="resume-document">
        <h1>RESUME</h1>
        <div className="resume-header">
          <div className="resume-header-details">
            {textField('completeName', 'Complete Name', 'resume-name-field')}
            {textField('address', 'Address')}
            {textField('contact', 'Contact')}
            {textField('messenger', 'Messenger Account')}
          </div>
          <label className="resume-photo-box">
            {photoPreview || savedPhoto?.url ? (
              <img src={photoPreview || savedPhoto.url} alt="Resume 2x2 photo" />
            ) : (
              <>
                <span>2x2 Picture</span>
                <span>Click to upload</span>
              </>
            )}
            <input
              type="file"
              accept="image/*"
              hidden
              disabled={loading || saving || !user?.id}
              onChange={handlePhotoSelect}
            />
          </label>
        </div>

        <section className="resume-section">
          <h2>CAREER OBJECTIVE/S:</h2>
          <textarea
            aria-label="Career objective"
            value={values.careerObjective || ''}
            disabled={loading || saving || !user?.id}
            onChange={(event) => updateValue('careerObjective', event.target.value)}
          />
        </section>

        <section className="resume-section">
          <h2>PERSONAL INFORMATION:</h2>
          <div className="resume-personal-grid">
            {personalInformation.map(([key, label]) => textField(key, `${label}:`))}
          </div>
        </section>

        <section className="resume-section">
          <h2>EDUCATIONAL BACKGROUND:</h2>
          {textField('secondary', 'Secondary:')}
          {textField('primary', 'Primary:')}
        </section>

        {resumeSections.map(([key, title]) => (
          <section className="resume-section" key={key}>
            <h2>{title}:</h2>
            {[0, 1, 2].map((line) => textField(
              `${key}-${line}`,
              `${title} entry ${line + 1}`,
              'resume-line-field',
            ))}
          </section>
        ))}

        <p className="resume-certification">
          I hereby certify that the above information are true and correct to the best of my
          knowledge and beliefs.
        </p>
        <div className="resume-signature">
          {textField('signature', 'Signature Over Printed name/Applicant', 'resume-signature-field')}
          <span>Signature Over Printed name/Applicant</span>
        </div>
      </article>

      {loading && <p role="status">Loading saved resume...</p>}
      {errorMessage && <p role="alert" className="resume-message error">{errorMessage}</p>}
      {statusMessage && !saving && <p role="status" className="resume-message">{statusMessage}</p>}
      <button
        type="button"
        className="resume-save"
        onClick={handleSave}
        disabled={loading || saving || !user?.id}
      >
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  )
}

function BarangayClearancePage({ user, onBack }) {
  const [steps, setSteps] = useState(Array(7).fill(''))
  const [preparedBy, setPreparedBy] = useState('')
  const [selectedPhoto, setSelectedPhoto] = useState(null)
  const [selectedPhotoUrl, setSelectedPhotoUrl] = useState('')
  const [savedPhoto, setSavedPhoto] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const CLEARANCE_SECTION = 'Pre-Immersion/Barangay Clearance'

  useEffect(() => {
    let cancelled = false

    const loadClearance = async () => {
      if (!user?.id) {
        setLoading(false)
        setErrorMessage('Your account could not be identified. Please log in again.')
        return
      }

      setLoading(true)
      setErrorMessage('')
      try {
        const { data, error } = await loadPortfolioEntry(supabase, user.id, CLEARANCE_SECTION)
        if (error) throw error

        let content = data?.content
        if (typeof content === 'string') content = JSON.parse(content)
        if (content) {
          if (typeof content !== 'object' || Array.isArray(content)) {
            throw new Error('Saved Barangay Clearance data has an invalid format.')
          }
          const savedSteps = Array.isArray(content.steps) ? content.steps : []
          if (!cancelled) {
            setSteps(Array.from({ length: 7 }, (_, index) => savedSteps[index] || ''))
            setPreparedBy(content.prepared_by || '')
          }
          if (content.photo_path) {
            const { data: signed, error: signedError } = await getPortfolioSignedUrl(user.id, content.photo_path)
            if (signedError) throw signedError
            if (!cancelled) {
              setSavedPhoto({ path: content.photo_path, url: signed.signedUrl })
            }
          } else if (!cancelled) {
            setSavedPhoto(null)
          }
        } else if (!cancelled) {
          setSteps(Array(7).fill(''))
          setPreparedBy('')
          setSavedPhoto(null)
        }
      } catch (error) {
        console.error('Load Pre-Immersion Barangay Clearance failed:', error)
        if (!cancelled) {
          setErrorMessage(error?.message || 'Could not load the saved Barangay Clearance.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadClearance()
    return () => { cancelled = true }
  }, [user?.id])

  useEffect(() => {
    if (!selectedPhoto) {
      setSelectedPhotoUrl('')
      return undefined
    }
    const objectUrl = URL.createObjectURL(selectedPhoto)
    setSelectedPhotoUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [selectedPhoto])

  const handlePhotoSelect = (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setErrorMessage('Please select an image file.')
      return
    }
    setSelectedPhoto(file)
    setErrorMessage('')
    setStatusMessage('')
  }

  const handleSave = async () => {
    if (!user?.id) {
      setErrorMessage('Your account could not be identified. Please log in again.')
      return
    }

    setSaving(true)
    setErrorMessage('')
    setStatusMessage('')
    let uploadedPath = ''

    try {
      let photoPath = savedPhoto?.path || null
      let photoUrl = ''
      if (selectedPhoto) {
        const safeName = selectedPhoto.name.replace(/[^a-zA-Z0-9._-]/g, '_')
        uploadedPath = `${user.id}/barangay-clearance/${Date.now()}-${safeName}`
        await savePortfolioPhoto(user.id, uploadedPath, selectedPhoto)

        const { data: signed, error: signedError } = await getPortfolioSignedUrl(user.id, uploadedPath)
        if (signedError) throw signedError
        photoUrl = signed.signedUrl
        photoPath = uploadedPath
      }

      const { error } = await savePortfolioEntry(supabase, {
        user_id: user.id,
        section: CLEARANCE_SECTION,
        content: { steps, prepared_by: preparedBy, photo_path: photoPath },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,section' })
      if (error) throw error

      if (uploadedPath) {
        setSavedPhoto({ path: uploadedPath, url: photoUrl })
        setSelectedPhoto(null)
      }
      setStatusMessage('Barangay Clearance saved.')
    } catch (error) {
      console.error('Save Pre-Immersion Barangay Clearance failed:', error)
      if (uploadedPath) {
        const { error: cleanupError } = await supabase.storage
          .from('portfolio-files')
          .remove([uploadedPath])
        if (cleanupError) {
          console.error('Could not remove the unsaved Barangay Clearance photo:', cleanupError)
        }
      }
      setErrorMessage(error?.message || 'Could not save the Barangay Clearance.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="dashboard-section barangay-clearance-page">
      <button
        type="button"
        className="portfolio-back-button"
        onClick={onBack}
      >
        ← Back to Pre-Immersion
      </button>

      <p className="eyebrow">STUDENT DASHBOARD / MY PORTFOLIO / PRE-IMMERSION</p>
      <article className="barangay-clearance-document">
        <h1>PROCESS IN SECURING BARANGAY CLEARANCE</h1>
        <p className="barangay-clearance-instruction">
          Write the steps in securing barangay clearance
        </p>
        <h2>STEPS:</h2>
        <ol className="barangay-clearance-steps">
          {steps.map((step, index) => (
            <li key={index}>
              <textarea
                aria-label={`Step ${index + 1}`}
                value={step}
                disabled={loading || saving || !user?.id}
                onChange={(event) => {
                  const nextSteps = [...steps]
                  nextSteps[index] = event.target.value
                  setSteps(nextSteps)
                  setErrorMessage('')
                  setStatusMessage('')
                }}
              />
            </li>
          ))}
        </ol>
        <section className="barangay-clearance-photo-section">
          <h2>Sample Barangay Clearance</h2>
          <p>Upload you Baragay Clearance in here.</p>
          <label className="barangay-clearance-upload-box">
            {selectedPhotoUrl || savedPhoto?.url ? (
              <img
                src={selectedPhotoUrl || savedPhoto.url}
                alt="Uploaded Barangay Clearance"
              />
            ) : (
              <>
                <span className="barangay-clearance-upload-icon">+</span>
                <span>Click to upload a photo of your Barangay Clearance</span>
                <span className="barangay-clearance-upload-hint">JPG, PNG, or other image formats</span>
              </>
            )}
            <input
              type="file"
              accept="image/*"
              hidden
              disabled={loading || saving || !user?.id}
              onChange={handlePhotoSelect}
            />
          </label>
        </section>
        <div className="barangay-clearance-prepared-by">
          <label htmlFor="barangay-clearance-prepared-by">Prepared by:</label>
          <input
            id="barangay-clearance-prepared-by"
            type="text"
            value={preparedBy}
            disabled={loading || saving || !user?.id}
            onChange={(event) => {
              setPreparedBy(event.target.value)
              setErrorMessage('')
              setStatusMessage('')
            }}
          />
          <span>Name/Signature</span>
        </div>
      </article>

      {loading && <p role="status">Loading saved Barangay Clearance...</p>}
      {errorMessage && <p role="alert" className="barangay-clearance-message error">{errorMessage}</p>}
      {statusMessage && !saving && <p role="status" className="barangay-clearance-message">{statusMessage}</p>}
      <button
        type="button"
        className="barangay-clearance-save"
        onClick={handleSave}
        disabled={loading || saving || !user?.id}
      >
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  )
}

function PoliceClearancePage({ user, onBack }) {
  const [steps, setSteps] = useState(Array(7).fill(''))
  const [preparedBy, setPreparedBy] = useState('')
  const [selectedPhoto, setSelectedPhoto] = useState(null)
  const [selectedPhotoUrl, setSelectedPhotoUrl] = useState('')
  const [savedPhoto, setSavedPhoto] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const CLEARANCE_SECTION = 'Pre-Immersion/Police Clearance'

  useEffect(() => {
    let cancelled = false

    const loadClearance = async () => {
      if (!user?.id) {
        setLoading(false)
        setErrorMessage('Your account could not be identified. Please log in again.')
        return
      }

      setLoading(true)
      setErrorMessage('')
      try {
        const { data, error } = await loadPortfolioEntry(supabase, user.id, CLEARANCE_SECTION)
        if (error) throw error

        let content = data?.content
        if (typeof content === 'string') content = JSON.parse(content)
        if (content) {
          if (typeof content !== 'object' || Array.isArray(content)) {
            throw new Error('Saved Police Clearance data has an invalid format.')
          }
          const savedSteps = Array.isArray(content.steps) ? content.steps : []
          if (!cancelled) {
            setSteps(Array.from({ length: 7 }, (_, index) => savedSteps[index] || ''))
            setPreparedBy(content.prepared_by || '')
          }
          if (content.photo_path) {
            const { data: signed, error: signedError } = await getPortfolioSignedUrl(user.id, content.photo_path)
            if (signedError) throw signedError
            if (!cancelled) {
              setSavedPhoto({ path: content.photo_path, url: signed.signedUrl })
            }
          } else if (!cancelled) {
            setSavedPhoto(null)
          }
        } else if (!cancelled) {
          setSteps(Array(7).fill(''))
          setPreparedBy('')
          setSavedPhoto(null)
        }
      } catch (error) {
        console.error('Load Pre-Immersion Police Clearance failed:', error)
        if (!cancelled) {
          setErrorMessage(error?.message || 'Could not load the saved Police Clearance.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadClearance()
    return () => { cancelled = true }
  }, [user?.id])

  useEffect(() => {
    if (!selectedPhoto) {
      setSelectedPhotoUrl('')
      return undefined
    }
    const objectUrl = URL.createObjectURL(selectedPhoto)
    setSelectedPhotoUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [selectedPhoto])

  const handlePhotoSelect = (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setErrorMessage('Please select an image file.')
      return
    }
    setSelectedPhoto(file)
    setErrorMessage('')
    setStatusMessage('')
  }

  const handleSave = async () => {
    if (!user?.id) {
      setErrorMessage('Your account could not be identified. Please log in again.')
      return
    }

    setSaving(true)
    setErrorMessage('')
    setStatusMessage('')
    let uploadedPath = ''

    try {
      let photoPath = savedPhoto?.path || null
      let photoUrl = ''
      if (selectedPhoto) {
        const safeName = selectedPhoto.name.replace(/[^a-zA-Z0-9._-]/g, '_')
        uploadedPath = `${user.id}/police-clearance/${Date.now()}-${safeName}`
        await savePortfolioPhoto(user.id, uploadedPath, selectedPhoto)

        const { data: signed, error: signedError } = await getPortfolioSignedUrl(user.id, uploadedPath)
        if (signedError) throw signedError
        photoUrl = signed.signedUrl
        photoPath = uploadedPath
      }

      const { error } = await savePortfolioEntry(supabase, {
        user_id: user.id,
        section: CLEARANCE_SECTION,
        content: { steps, prepared_by: preparedBy, photo_path: photoPath },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,section' })
      if (error) throw error

      if (uploadedPath) {
        setSavedPhoto({ path: uploadedPath, url: photoUrl })
        setSelectedPhoto(null)
      }
      setStatusMessage('Police Clearance saved.')
    } catch (error) {
      console.error('Save Pre-Immersion Police Clearance failed:', error)
      if (uploadedPath) {
        const { error: cleanupError } = await supabase.storage
          .from('portfolio-files')
          .remove([uploadedPath])
        if (cleanupError) {
          console.error('Could not remove the unsaved Police Clearance photo:', cleanupError)
        }
      }
      setErrorMessage(error?.message || 'Could not save the Police Clearance.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="dashboard-section police-clearance-page">
      <button
        type="button"
        className="portfolio-back-button"
        onClick={onBack}
      >
        ← Back to Pre-Immersion
      </button>

      <p className="eyebrow">STUDENT DASHBOARD / MY PORTFOLIO / PRE-IMMERSION</p>
      <article className="police-clearance-document">
        <h1>PROCESS IN SECURING POLICE CLEARANCE</h1>
        <p className="police-clearance-instruction">
          Write the steps in securing police clearance.
        </p>
        <h2>STEPS:</h2>
        <ol className="police-clearance-flow">
          {steps.map((step, index) => (
            <li className="police-clearance-flow-item" key={index}>
              <textarea
                aria-label={`Step ${index + 1}`}
                value={step}
                disabled={loading || saving || !user?.id}
                onChange={(event) => {
                  const nextSteps = [...steps]
                  nextSteps[index] = event.target.value
                  setSteps(nextSteps)
                  setErrorMessage('')
                  setStatusMessage('')
                }}
              />
            </li>
          ))}
        </ol>
        <section className="police-clearance-photo-section">
          <h2>Sample Police Clearance</h2>
          <p>Upload your Police Clearance here.</p>
          <label className="police-clearance-upload-box">
            {selectedPhotoUrl || savedPhoto?.url ? (
              <img
                src={selectedPhotoUrl || savedPhoto.url}
                alt="Uploaded Police Clearance"
              />
            ) : (
              <>
                <span className="police-clearance-upload-icon">+</span>
                <span>Click to upload a photo of your Police Clearance</span>
                <span className="police-clearance-upload-hint">JPG, PNG, or other image formats</span>
              </>
            )}
            <input
              type="file"
              accept="image/*"
              hidden
              disabled={loading || saving || !user?.id}
              onChange={handlePhotoSelect}
            />
          </label>
        </section>
        <div className="police-clearance-prepared-by">
          <label htmlFor="police-clearance-prepared-by">Prepared by:</label>
          <input
            id="police-clearance-prepared-by"
            type="text"
            value={preparedBy}
            disabled={loading || saving || !user?.id}
            onChange={(event) => {
              setPreparedBy(event.target.value)
              setErrorMessage('')
              setStatusMessage('')
            }}
          />
          <span>Name/Signature</span>
        </div>
      </article>

      {loading && <p role="status">Loading saved Police Clearance...</p>}
      {errorMessage && <p role="alert" className="police-clearance-message error">{errorMessage}</p>}
      {statusMessage && !saving && <p role="status" className="police-clearance-message">{statusMessage}</p>}
      <button
        type="button"
        className="police-clearance-save"
        onClick={handleSave}
        disabled={loading || saving || !user?.id}
      >
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  )
}

function MayorsClearancePage({ user, onBack }) {
  const [steps, setSteps] = useState(Array(7).fill(''))
  const [preparedBy, setPreparedBy] = useState('')
  const [selectedPhoto, setSelectedPhoto] = useState(null)
  const [selectedPhotoUrl, setSelectedPhotoUrl] = useState('')
  const [savedPhoto, setSavedPhoto] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const CLEARANCE_SECTION = 'Pre-Immersion/Mayors Clearance'

  useEffect(() => {
    let cancelled = false

    const loadClearance = async () => {
      if (!user?.id) {
        setLoading(false)
        setErrorMessage('Your account could not be identified. Please log in again.')
        return
      }

      setLoading(true)
      setErrorMessage('')
      try {
        const { data, error } = await loadPortfolioEntry(supabase, user.id, CLEARANCE_SECTION)
        if (error) throw error

        let content = data?.content
        if (typeof content === 'string') content = JSON.parse(content)
        if (content) {
          if (typeof content !== 'object' || Array.isArray(content)) {
            throw new Error('Saved Mayor’s Clearance data has an invalid format.')
          }
          const savedSteps = Array.isArray(content.steps) ? content.steps : []
          if (!cancelled) {
            setSteps(Array.from({ length: 7 }, (_, index) => savedSteps[index] || ''))
            setPreparedBy(content.prepared_by || '')
          }
          if (content.photo_path) {
            const { data: signed, error: signedError } = await getPortfolioSignedUrl(user.id, content.photo_path)
            if (signedError) throw signedError
            if (!cancelled) {
              setSavedPhoto({ path: content.photo_path, url: signed.signedUrl })
            }
          } else if (!cancelled) {
            setSavedPhoto(null)
          }
        } else if (!cancelled) {
          setSteps(Array(7).fill(''))
          setPreparedBy('')
          setSavedPhoto(null)
        }
      } catch (error) {
        console.error('Load Pre-Immersion Mayor’s Clearance failed:', error)
        if (!cancelled) {
          setErrorMessage(error?.message || 'Could not load the saved Mayor’s Clearance.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadClearance()
    return () => { cancelled = true }
  }, [user?.id])

  useEffect(() => {
    if (!selectedPhoto) {
      setSelectedPhotoUrl('')
      return undefined
    }
    const objectUrl = URL.createObjectURL(selectedPhoto)
    setSelectedPhotoUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [selectedPhoto])

  const handlePhotoSelect = (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setErrorMessage('Please select an image file.')
      return
    }
    setSelectedPhoto(file)
    setErrorMessage('')
    setStatusMessage('')
  }

  const handleSave = async () => {
    if (!user?.id) {
      setErrorMessage('Your account could not be identified. Please log in again.')
      return
    }

    setSaving(true)
    setErrorMessage('')
    setStatusMessage('')
    let uploadedPath = ''

    try {
      let photoPath = savedPhoto?.path || null
      let photoUrl = ''
      if (selectedPhoto) {
        const safeName = selectedPhoto.name.replace(/[^a-zA-Z0-9._-]/g, '_')
        uploadedPath = `${user.id}/mayors-clearance/${Date.now()}-${safeName}`
        await savePortfolioPhoto(user.id, uploadedPath, selectedPhoto)

        const { data: signed, error: signedError } = await getPortfolioSignedUrl(user.id, uploadedPath)
        if (signedError) throw signedError
        photoUrl = signed.signedUrl
        photoPath = uploadedPath
      }

      const { error } = await savePortfolioEntry(supabase, {
        user_id: user.id,
        section: CLEARANCE_SECTION,
        content: { steps, prepared_by: preparedBy, photo_path: photoPath },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,section' })
      if (error) throw error

      if (uploadedPath) {
        setSavedPhoto({ path: uploadedPath, url: photoUrl })
        setSelectedPhoto(null)
      }
      setStatusMessage('Mayor’s Clearance saved.')
    } catch (error) {
      console.error('Save Pre-Immersion Mayor’s Clearance failed:', error)
      if (uploadedPath) {
        const { error: cleanupError } = await supabase.storage
          .from('portfolio-files')
          .remove([uploadedPath])
        if (cleanupError) {
          console.error('Could not remove the unsaved Mayor’s Clearance photo:', cleanupError)
        }
      }
      setErrorMessage(error?.message || 'Could not save the Mayor’s Clearance.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="dashboard-section police-clearance-page">
      <button
        type="button"
        className="portfolio-back-button"
        onClick={onBack}
      >
        ← Back to Pre-Immersion
      </button>

      <p className="eyebrow">STUDENT DASHBOARD / MY PORTFOLIO / PRE-IMMERSION</p>
      <article className="police-clearance-document">
        <h1>PROCESS IN SECURING MAYOR’S CLEARANCE</h1>
        <p className="police-clearance-instruction">
          Write the steps in securing Mayor’s clearance.
        </p>
        <h2>STEPS:</h2>
        <ol className="police-clearance-flow">
          {steps.map((step, index) => (
            <li className="police-clearance-flow-item" key={index}>
              <textarea
                aria-label={`Step ${index + 1}`}
                value={step}
                disabled={loading || saving || !user?.id}
                onChange={(event) => {
                  const nextSteps = [...steps]
                  nextSteps[index] = event.target.value
                  setSteps(nextSteps)
                  setErrorMessage('')
                  setStatusMessage('')
                }}
              />
            </li>
          ))}
        </ol>
        <section className="police-clearance-photo-section">
          <h2>Sample Mayor’s Clearance</h2>
          <p>Upload your Mayor’s Clearance here.</p>
          <label className="police-clearance-upload-box">
            {selectedPhotoUrl || savedPhoto?.url ? (
              <img
                src={selectedPhotoUrl || savedPhoto.url}
                alt="Uploaded Mayor’s Clearance"
              />
            ) : (
              <>
                <span className="police-clearance-upload-icon">+</span>
                <span>Click to upload a photo of your Mayor’s Clearance</span>
                <span className="police-clearance-upload-hint">JPG, PNG, or other image formats</span>
              </>
            )}
            <input
              type="file"
              accept="image/*"
              hidden
              disabled={loading || saving || !user?.id}
              onChange={handlePhotoSelect}
            />
          </label>
        </section>
        <div className="police-clearance-prepared-by">
          <label htmlFor="mayors-clearance-prepared-by">Prepared by:</label>
          <input
            id="mayors-clearance-prepared-by"
            type="text"
            value={preparedBy}
            disabled={loading || saving || !user?.id}
            onChange={(event) => {
              setPreparedBy(event.target.value)
              setErrorMessage('')
              setStatusMessage('')
            }}
          />
          <span>Name/Signature</span>
        </div>
      </article>

      {loading && <p role="status">Loading saved Mayor’s Clearance...</p>}
      {errorMessage && <p role="alert" className="police-clearance-message error">{errorMessage}</p>}
      {statusMessage && !saving && <p role="status" className="police-clearance-message">{statusMessage}</p>}
      <button
        type="button"
        className="police-clearance-save"
        onClick={handleSave}
        disabled={loading || saving || !user?.id}
      >
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  )
}

function HealthClearancePage({ user, onBack }) {
  const [steps, setSteps] = useState(Array(7).fill(''))
  const [preparedBy, setPreparedBy] = useState('')
  const [selectedPhoto, setSelectedPhoto] = useState(null)
  const [selectedPhotoUrl, setSelectedPhotoUrl] = useState('')
  const [savedPhoto, setSavedPhoto] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const CLEARANCE_SECTION = 'Pre-Immersion/Health Clearance'

  useEffect(() => {
    let cancelled = false

    const loadClearance = async () => {
      if (!user?.id) {
        setLoading(false)
        setErrorMessage('Your account could not be identified. Please log in again.')
        return
      }

      setLoading(true)
      setErrorMessage('')
      try {
        const { data, error } = await loadPortfolioEntry(supabase, user.id, CLEARANCE_SECTION)
        if (error) throw error

        let content = data?.content
        if (typeof content === 'string') content = JSON.parse(content)
        if (content) {
          if (typeof content !== 'object' || Array.isArray(content)) {
            throw new Error('Saved Health Clearance data has an invalid format.')
          }
          const savedSteps = Array.isArray(content.steps) ? content.steps : []
          if (!cancelled) {
            setSteps(Array.from({ length: 7 }, (_, index) => savedSteps[index] || ''))
            setPreparedBy(content.prepared_by || '')
          }
          if (content.photo_path) {
            const { data: signed, error: signedError } = await getPortfolioSignedUrl(user.id, content.photo_path)
            if (signedError) throw signedError
            if (!cancelled) {
              setSavedPhoto({ path: content.photo_path, url: signed.signedUrl })
            }
          } else if (!cancelled) {
            setSavedPhoto(null)
          }
        } else if (!cancelled) {
          setSteps(Array(7).fill(''))
          setPreparedBy('')
          setSavedPhoto(null)
        }
      } catch (error) {
        console.error('Load Pre-Immersion Health Clearance failed:', error)
        if (!cancelled) {
          setErrorMessage(error?.message || 'Could not load the saved Health Clearance.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadClearance()
    return () => { cancelled = true }
  }, [user?.id])

  useEffect(() => {
    if (!selectedPhoto) {
      setSelectedPhotoUrl('')
      return undefined
    }
    const objectUrl = URL.createObjectURL(selectedPhoto)
    setSelectedPhotoUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [selectedPhoto])

  const handlePhotoSelect = (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setErrorMessage('Please select an image file.')
      return
    }
    setSelectedPhoto(file)
    setErrorMessage('')
    setStatusMessage('')
  }

  const handleSave = async () => {
    if (!user?.id) {
      setErrorMessage('Your account could not be identified. Please log in again.')
      return
    }

    setSaving(true)
    setErrorMessage('')
    setStatusMessage('')
    let uploadedPath = ''

    try {
      let photoPath = savedPhoto?.path || null
      let photoUrl = ''
      if (selectedPhoto) {
        const safeName = selectedPhoto.name.replace(/[^a-zA-Z0-9._-]/g, '_')
        uploadedPath = `${user.id}/health-clearance/${Date.now()}-${safeName}`
        await savePortfolioPhoto(user.id, uploadedPath, selectedPhoto)

        const { data: signed, error: signedError } = await getPortfolioSignedUrl(user.id, uploadedPath)
        if (signedError) throw signedError
        photoUrl = signed.signedUrl
        photoPath = uploadedPath
      }

      const { error } = await savePortfolioEntry(supabase, {
        user_id: user.id,
        section: CLEARANCE_SECTION,
        content: { steps, prepared_by: preparedBy, photo_path: photoPath },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,section' })
      if (error) throw error

      if (uploadedPath) {
        setSavedPhoto({ path: uploadedPath, url: photoUrl })
        setSelectedPhoto(null)
      }
      setStatusMessage('Health Clearance saved.')
    } catch (error) {
      console.error('Save Pre-Immersion Health Clearance failed:', error)
      if (uploadedPath) {
        const { error: cleanupError } = await supabase.storage
          .from('portfolio-files')
          .remove([uploadedPath])
        if (cleanupError) {
          console.error('Could not remove the unsaved Health Clearance photo:', cleanupError)
        }
      }
      setErrorMessage(error?.message || 'Could not save the Health Clearance.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="dashboard-section police-clearance-page">
      <button
        type="button"
        className="portfolio-back-button"
        onClick={onBack}
      >
        ← Back to Pre-Immersion
      </button>

      <p className="eyebrow">STUDENT DASHBOARD / MY PORTFOLIO / PRE-IMMERSION</p>
      <article className="police-clearance-document">
        <h1>PROCESS IN SECURING HEALTH CERTIFICATE</h1>
        <p className="police-clearance-instruction">
          Write the steps in securing Health Certificate.
        </p>
        <h2>STEPS:</h2>
        <ol className="police-clearance-flow">
          {steps.map((step, index) => (
            <li className="police-clearance-flow-item" key={index}>
              <textarea
                aria-label={`Step ${index + 1}`}
                value={step}
                disabled={loading || saving || !user?.id}
                onChange={(event) => {
                  const nextSteps = [...steps]
                  nextSteps[index] = event.target.value
                  setSteps(nextSteps)
                  setErrorMessage('')
                  setStatusMessage('')
                }}
              />
            </li>
          ))}
        </ol>
        <section className="police-clearance-photo-section">
          <h2>Sample Health Certificate</h2>
          <p>Upload your Health Clearance here.</p>
          <label className="police-clearance-upload-box">
            {selectedPhotoUrl || savedPhoto?.url ? (
              <img
                src={selectedPhotoUrl || savedPhoto.url}
                alt="Uploaded Health Certificate"
              />
            ) : (
              <>
                <span className="police-clearance-upload-icon">+</span>
                <span>Click to upload a photo of your Health Clearance</span>
                <span className="police-clearance-upload-hint">JPG, PNG, or other image formats</span>
              </>
            )}
            <input
              type="file"
              accept="image/*"
              hidden
              disabled={loading || saving || !user?.id}
              onChange={handlePhotoSelect}
            />
          </label>
        </section>
        <div className="police-clearance-prepared-by">
          <label htmlFor="health-clearance-prepared-by">Prepared by:</label>
          <input
            id="health-clearance-prepared-by"
            type="text"
            value={preparedBy}
            disabled={loading || saving || !user?.id}
            onChange={(event) => {
              setPreparedBy(event.target.value)
              setErrorMessage('')
              setStatusMessage('')
            }}
          />
          <span>Name/Signature</span>
        </div>
      </article>

      {loading && <p role="status">Loading saved Health Clearance...</p>}
      {errorMessage && <p role="alert" className="police-clearance-message error">{errorMessage}</p>}
      {statusMessage && !saving && <p role="status" className="police-clearance-message">{statusMessage}</p>}
      <button
        type="button"
        className="police-clearance-save"
        onClick={handleSave}
        disabled={loading || saving || !user?.id}
      >
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  )
}

function ClassSchedulePage({ user, onBack }) {
  const [scheduleValues, setScheduleValues] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const SCHEDULE_SECTION = 'Pre-Immersion/Class Schedule'
  const classScheduleColumns = ['Subject', 'Units', 'Grade/Section', 'Time', 'Days', 'Room']

  useEffect(() => {
    let cancelled = false

    const loadSchedule = async () => {
      if (!user?.id) {
        setLoading(false)
        setErrorMessage('Your account could not be identified. Please log in again.')
        return
      }

      setLoading(true)
      setErrorMessage('')
      setScheduleValues({})

      try {
        const { data, error } = await loadPortfolioEntry(supabase, user.id, SCHEDULE_SECTION)

        if (error) throw error

        let content = data?.content
        if (typeof content === 'string') {
          content = JSON.parse(content)
        }
        if (content !== undefined && content !== null) {
          if (typeof content !== 'object' || Array.isArray(content)) {
            throw new Error('Saved class schedule has an invalid format.')
          }
          if (!cancelled) setScheduleValues(content)
        }
      } catch (error) {
        console.error('Load Pre-Immersion Class Schedule failed:', error)
        if (!cancelled) {
          setErrorMessage(error?.message || 'Could not load the saved class schedule.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadSchedule()
    return () => { cancelled = true }
  }, [user?.id])

  const updateScheduleValue = (key, value) => {
    setScheduleValues((current) => ({ ...current, [key]: value }))
    setErrorMessage('')
    setStatusMessage('')
  }

  const handleSaveSchedule = async () => {
    if (!user?.id) {
      setErrorMessage('Your account could not be identified. Please log in again.')
      return
    }

    setSaving(true)
    setErrorMessage('')
    setStatusMessage('')

    try {
      const { error } = await savePortfolioEntry(supabase, {
        user_id: user.id,
        section: SCHEDULE_SECTION,
        content: scheduleValues,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,section' })

      if (error) throw error
      setStatusMessage('Class schedule saved. Your entries will remain when you reopen this panel.')
    } catch (error) {
      console.error('Save Pre-Immersion Class Schedule failed:', error)
      setErrorMessage(error?.message || 'Could not save the class schedule.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="dashboard-section class-schedule-page">
      <button
        type="button"
        className="portfolio-back-button"
        onClick={onBack}
      >
        ← Back to Pre-Immersion
      </button>

      <p className="class-schedule-instructions">Enter your class schedule below.</p>

      <div className="class-schedule-table-wrap">
        <table className="class-schedule-table">
          <thead>
            <tr>
              <th colSpan={6}>
                Class Schedule for the Current Semester(Refer to your class program)
              </th>
              <th className="class-schedule-separator" aria-hidden="true" />
              <th colSpan={2}>
                Time Alloted for Work Immersion(Refer to the class immersion schedule)
              </th>
            </tr>
            <tr>
              <th scope="col">Subject</th>
              <th scope="col">Units</th>
              <th scope="col">Grade/Section</th>
              <th scope="col">Time</th>
              <th scope="col">Days</th>
              <th scope="col">Room</th>
              <th className="class-schedule-separator" aria-hidden="true" />
              <th scope="col">Day/Date</th>
              <th scope="col">Time</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 10 }, (_, rowIndex) => (
              <tr key={rowIndex + 1}>
                {classScheduleColumns.map((column, columnIndex) => {
                  const key = `class-${rowIndex}-${columnIndex}`
                  return (
                    <td key={column}>
                      <input
                        type="text"
                        aria-label={`${column}, schedule row ${rowIndex + 1}`}
                        value={scheduleValues[key] || ''}
                        disabled={loading || saving || !user?.id}
                        onChange={(event) => updateScheduleValue(key, event.target.value)}
                      />
                    </td>
                  )
                })}
                <td className="class-schedule-separator" />
                <td>{rowIndex + 1}</td>
                <td>
                  <input
                    type="text"
                    aria-label={`Work immersion time, schedule row ${rowIndex + 1}`}
                    value={scheduleValues[`immersion-time-${rowIndex}`] || ''}
                    disabled={loading || saving || !user?.id}
                    onChange={(event) => updateScheduleValue(`immersion-time-${rowIndex}`, event.target.value)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {loading && <p role="status">Loading saved class schedule...</p>}
      {errorMessage && <p role="alert" className="class-schedule-message">{errorMessage}</p>}
      {statusMessage && !saving && <p role="status" className="class-schedule-message">{statusMessage}</p>}
      <section className="class-schedule-certification">
        <p>
          This is to certify that the above student
          <br />
          have completed the pre-immersion requirements and is recommended to endorse
          <br />
          his/her application in:
        </p>

        <p>
          <strong>Company Name:</strong>
          <br />
          WESTERN CAGAYAN SCHOOL OF ARTS AND TRADES –
          <br />
          &nbsp;&nbsp;&nbsp;&nbsp;In-School/Community
          <br />
          Based Work Immersion.
        </p>

        <p>
          <strong>Company Address:</strong> Centro 03, Lasam, Cagayan
        </p>

        <p>
          <strong>Contact Person:</strong> DANIEL T. AUIDAN, PhD., Telephone No./s : __________
        </p>

        <p>
          <strong>Position:</strong>
          <br />
          Principal III, WCSAT.
        </p>

        <p>
          <strong>Endorsed by</strong>: VIVENCIO P. PASCUAL, JR.
          <br />
          &nbsp;&nbsp;&nbsp;&nbsp;Work Immersion Teacher
        </p>
      </section>
      <button
        type="button"
        className="class-schedule-save"
        onClick={handleSaveSchedule}
        disabled={loading || saving || !user?.id}
      >
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  )
}

function StudentDutiesContent({ user }) {
  const [selectedPhoto, setSelectedPhoto] = useState(null)
  const [selectedPhotoUrl, setSelectedPhotoUrl] = useState('')
  const [savedPhoto, setSavedPhoto] = useState(null)
  const [photoLoading, setPhotoLoading] = useState(true)
  const [photoSaving, setPhotoSaving] = useState(false)
  const [photoError, setPhotoError] = useState('')
  const [photoMessage, setPhotoMessage] = useState('')
  useEffect(() => {
    let cancelled = false

    const loadSavedPhoto = async () => {
      if (!user?.id) {
        setPhotoLoading(false)
        return
      }

      setPhotoLoading(true)
      setPhotoError('')
      setSavedPhoto(null)

      try {
        const { data, error } = await loadPortfolioEntry(supabase, user.id, STUDENT_DUTIES_PHOTO_SECTION)

        if (error) throw error

        let content = data?.content
        if (typeof content === 'string') {
          try {
            content = JSON.parse(content)
          } catch {
            content = {}
          }
        }

        const photoPath = content?.photo_path
        if (!photoPath) {
          if (!cancelled) setSavedPhoto(null)
          return
        }

        const { data: signed, error: signedError } = await getPortfolioSignedUrl(user.id, photoPath)

        if (signedError) throw signedError
        if (!cancelled) setSavedPhoto({ path: photoPath, url: signed.signedUrl })
      } catch (error) {
        console.error('Load Student Duties photo failed:', error)
        if (!cancelled) setPhotoError(error?.message || 'Could not load the saved photo.')
      } finally {
        if (!cancelled) setPhotoLoading(false)
      }
    }

    loadSavedPhoto()
    return () => { cancelled = true }
  }, [user?.id])

  useEffect(() => {
    if (!selectedPhoto) {
      setSelectedPhotoUrl('')
      return undefined
    }
    const objectUrl = URL.createObjectURL(selectedPhoto)
    setSelectedPhotoUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [selectedPhoto])

  const photoPreviewUrl = selectedPhotoUrl || savedPhoto?.url

  const handleSavePhoto = async () => {
    if (!selectedPhoto) return
    if (!user?.id) {
      setPhotoError('Please log in again before saving a photo.')
      return
    }
    if (!selectedPhoto.type.startsWith('image/')) {
      setPhotoError('Please select an image file.')
      return
    }

    setPhotoSaving(true)
    setPhotoError('')
    setPhotoMessage('')
    let uploadedPath = ''

    try {
      const safeName = selectedPhoto.name.replace(/[^a-zA-Z0-9._-]/g, '_')
      uploadedPath = `${user.id}/student-duties/${Date.now()}-${safeName}`

      await savePortfolioPhoto(user.id, uploadedPath, selectedPhoto)

      const { data: signed, error: signedError } = await getPortfolioSignedUrl(user.id, uploadedPath)
      if (signedError) throw signedError

      const { error: saveError } = await savePortfolioEntry(supabase, {
        user_id: user.id,
        section: STUDENT_DUTIES_PHOTO_SECTION,
        content: { photo_path: uploadedPath },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,section' })
      if (saveError) throw saveError

      setSavedPhoto({ path: uploadedPath, url: signed.signedUrl })
      setSelectedPhoto(null)
      setPhotoMessage('Photo saved successfully.')
    } catch (error) {
      console.error('Save Student Duties photo failed:', error)
      if (uploadedPath) {
        const { error: cleanupError } = await supabase.storage
          .from('portfolio-files')
          .remove([uploadedPath])
        if (cleanupError) {
          console.error('Could not remove the unsaved Student Duties photo:', cleanupError)
        }
      }
      setPhotoError(error?.message || 'Could not save the photo.')
    } finally {
      setPhotoSaving(false)
    }
  }

  return (
    <div className="module-card">
      <h2>STUDENT DUTIES AND RESPONSIBILITIES</h2>
      <h3>Remember to:</h3>
      <ul>
        <li>Work through all the information and complete the activities in each section.</li>
        <li>
          Coordinate with your Work Immersion Teacher to supervise you at the
          school-based work simulation immersion venue in coordination with your
          schedule of school-based and home-based activities. He is there to
          support you and show you the correct way to do things.
        </li>
        <li>
          While in school or assigned community treat it as you are in a
          workplace. You will be given plenty of opportunities to ask questions
          and practice on the job. Make sure you practice your new skills during
          regular work shifts. This way, you will improve your speed, memory and
          your confidence.
        </li>
        <li>
          When you feel confident that you have had enough practice, ask your
          Immersion Teacher to evaluate you. The results of your evaluation will
          be recorded and will be part of your grade.
        </li>
        <li>
          Submit accomplished portfolio to your immersion teacher for checking
          and as reference for the issuance of your certificate of completion.
        </li>
      </ul>
      <a
        className="primary-btn"
        href="/Work%20Immersion%20-%20Parent%20Consent%20Template.docx"
        download="Work Immersion - Parent Consent Template.docx"
        style={{ display: 'inline-flex', textDecoration: 'none', marginTop: 12 }}
      >
        Download Parent Consent Template
      </a>
      <div style={{ marginTop: 24 }}>
        <h3>Upload a Photo</h3>
        {photoLoading ? (
          <p>Loading saved photo...</p>
        ) : (
          <>
            <label
              htmlFor="student-duties-photo"
              style={{
                display: 'grid',
                placeItems: 'center',
                gap: 10,
                minHeight: 180,
                padding: 16,
                border: '1px dashed #94a3b8',
                borderRadius: 10,
                cursor: photoSaving ? 'wait' : 'pointer',
                textAlign: 'center',
              }}
            >
              {photoPreviewUrl ? (
                <img
                  src={photoPreviewUrl}
                  alt="Selected or saved student duties photo"
                  style={{ maxWidth: '100%', maxHeight: 280, objectFit: 'contain' }}
                />
              ) : (
                <span>Select a photo to upload</span>
              )}
              <input
                id="student-duties-photo"
                type="file"
                accept="image/*"
                disabled={photoSaving}
                onChange={(event) => {
                  setSelectedPhoto(event.target.files?.[0] || null)
                  setPhotoError('')
                  setPhotoMessage('')
                  event.target.value = ''
                }}
              />
            </label>
            <button
              type="button"
              className="primary-btn"
              onClick={handleSavePhoto}
              disabled={!selectedPhoto || photoSaving}
              style={{ marginTop: 12 }}
            >
              {photoSaving ? 'Saving...' : 'Save Photo'}
            </button>
          </>
        )}
        {photoError && <p role="alert" style={{ color: '#b91c1c' }}>{photoError}</p>}
        {photoMessage && <p role="status" style={{ color: '#166534' }}>{photoMessage}</p>}
      </div>
    </div>
  )
}

const STUDENT_ID_SECTION = 'Module Introduction/Student ID Photos'

function StudentIdPage({ user }) {
  const [selectedFront, setSelectedFront] = useState(null)
  const [selectedBack, setSelectedBack] = useState(null)
  const [frontPreviewUrl, setFrontPreviewUrl] = useState('')
  const [backPreviewUrl, setBackPreviewUrl] = useState('')
  const frontPreviewUrlRef = useRef('')
  const backPreviewUrlRef = useRef('')
  const [savedFront, setSavedFront] = useState(null)
  const [savedBack, setSavedBack] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [statusMessage, setStatusMessage] = useState('')

  useEffect(() => () => {
    if (frontPreviewUrlRef.current) URL.revokeObjectURL(frontPreviewUrlRef.current)
    if (backPreviewUrlRef.current) URL.revokeObjectURL(backPreviewUrlRef.current)
  }, [])

  const handleSelectPhoto = (side, event) => {
    const file = event.target.files?.[0] || null
    const previewRef = side === 'front' ? frontPreviewUrlRef : backPreviewUrlRef
    const setPreview = side === 'front' ? setFrontPreviewUrl : setBackPreviewUrl
    const setSelected = side === 'front' ? setSelectedFront : setSelectedBack

    if (previewRef.current) URL.revokeObjectURL(previewRef.current)
    previewRef.current = file ? URL.createObjectURL(file) : ''
    setPreview(previewRef.current)
    setSelected(file)
    setErrorMessage('')
    setStatusMessage('')
  }

  useEffect(() => {
    let cancelled = false

    const loadSavedPhotos = async () => {
      if (!user?.id) {
        setLoading(false)
        setErrorMessage('Your account could not be identified. Please log in again.')
        return
      }

      setLoading(true)
      setErrorMessage('')
      setSavedFront(null)
      setSavedBack(null)

      try {
        const { data, error } = await loadPortfolioEntry(supabase, user.id, STUDENT_ID_SECTION)
        if (error) throw error

        let content = data?.content
        if (typeof content === 'string') content = JSON.parse(content)
        const frontPath = content?.front_path || ''
        const backPath = content?.back_path || ''

        const [front, back] = await Promise.all(
          [frontPath, backPath].map(async (path) => {
            if (!path) return null
            const { data: signed, error: signedError } = await getPortfolioSignedUrl(user.id, path)
            if (signedError) throw signedError
            return { path, url: signed.signedUrl }
          })
        )

        if (!cancelled) {
          setSavedFront(front)
          setSavedBack(back)
        }
      } catch (error) {
        console.error('Load Student ID photos failed:', error)
        if (!cancelled) setErrorMessage(error?.message || 'Could not load saved ID photos.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadSavedPhotos()
    return () => { cancelled = true }
  }, [user?.id])

  const handleSavePhotos = async () => {
    if (!selectedFront && !selectedBack) return
    if (!user?.id) {
      setErrorMessage('Please log in again before saving photos.')
      return
    }

    const selectedPhotos = [
      { side: 'front', file: selectedFront },
      { side: 'back', file: selectedBack },
    ].filter(({ file }) => file)
    const invalidPhoto = selectedPhotos.find(({ file }) => !file.type.startsWith('image/'))
    if (invalidPhoto) {
      setErrorMessage('Please select image files only.')
      return
    }

    setSaving(true)
    setErrorMessage('')
    setStatusMessage('')
    const uploadedPaths = []

    try {
      const nextPhotos = {
        front_path: savedFront?.path || '',
        back_path: savedBack?.path || '',
      }
      const signedPhotos = {}

      for (const { side, file } of selectedPhotos) {
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
        const path = `${user.id}/student-id/${side}-${Date.now()}-${safeName}`
        await savePortfolioPhoto(user.id, path, file)
        uploadedPaths.push(path)

        const { data: signed, error: signedError } = await getPortfolioSignedUrl(user.id, path)
        if (signedError) throw signedError

        nextPhotos[`${side}_path`] = path
        signedPhotos[side] = { path, url: signed.signedUrl }
      }

      const { error: saveError } = await savePortfolioEntry(supabase, {
        user_id: user.id,
        section: STUDENT_ID_SECTION,
        content: nextPhotos,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,section' })
      if (saveError) throw saveError

      if (signedPhotos.front) setSavedFront(signedPhotos.front)
      if (signedPhotos.back) setSavedBack(signedPhotos.back)
      if (selectedFront && frontPreviewUrlRef.current) {
        URL.revokeObjectURL(frontPreviewUrlRef.current)
        frontPreviewUrlRef.current = ''
        setFrontPreviewUrl('')
      }
      if (selectedBack && backPreviewUrlRef.current) {
        URL.revokeObjectURL(backPreviewUrlRef.current)
        backPreviewUrlRef.current = ''
        setBackPreviewUrl('')
      }
      setSelectedFront(null)
      setSelectedBack(null)
      setStatusMessage('Student ID photos saved successfully.')
    } catch (error) {
      console.error('Save Student ID photos failed:', error)
      if (uploadedPaths.length) {
        const { error: cleanupError } = await supabase.storage
          .from('portfolio-files')
          .remove(uploadedPaths)
        if (cleanupError) {
          console.error('Could not remove unsaved Student ID photos:', cleanupError)
        }
      }
      setErrorMessage(error?.message || 'Could not save Student ID photos.')
    } finally {
      setSaving(false)
    }
  }

  const photoBoxStyle = {
    display: 'grid',
    placeItems: 'center',
    gap: 12,
    minHeight: 220,
    padding: 16,
    border: '1px dashed #94a3b8',
    borderRadius: 10,
    cursor: saving ? 'wait' : 'pointer',
    textAlign: 'center',
  }

  return (
    <div className="module-card">
      <h2>STUDENT ID</h2>
      <p>Upload photos of the front and back of your Student ID.</p>
      {loading ? (
        <p role="status">Loading saved ID photos...</p>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
            {[
              { side: 'front', label: 'Front of Student ID', saved: savedFront, preview: frontPreviewUrl },
              { side: 'back', label: 'Back of Student ID', saved: savedBack, preview: backPreviewUrl },
            ].map(({ side, label, saved, preview }) => (
              <label key={side} htmlFor={`student-id-${side}`} style={photoBoxStyle}>
                <strong>{label}</strong>
                {preview || saved?.url ? (
                  <img
                    src={preview || saved.url}
                    alt={label}
                    style={{ maxWidth: '100%', maxHeight: 260, objectFit: 'contain' }}
                  />
                ) : (
                  <span>Select a photo</span>
                )}
                <input
                  id={`student-id-${side}`}
                  type="file"
                  accept="image/*"
                  hidden
                  disabled={saving}
                  onChange={(event) => {
                    handleSelectPhoto(side, event)
                    event.target.value = ''
                  }}
                />
              </label>
            ))}
          </div>
          <button
            type="button"
            className="primary-btn"
            onClick={handleSavePhotos}
            disabled={saving || (!selectedFront && !selectedBack)}
            style={{
              marginTop: 16,
              padding: '12px 28px',
              fontSize: 16,
              fontWeight: 700,
              color: '#000',
              border: '2px solid #000',
            }}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </>
      )}
      {errorMessage && <p role="alert" style={{ color: '#b91c1c' }}>{errorMessage}</p>}
      {statusMessage && <p role="status" style={{ color: '#166534' }}>{statusMessage}</p>}
    </div>
  )
}

function MyPortfolio({ user }) {
  const [howToUseText, setHowToUseText] = useState("This Work Immersion Learner's Manual in times of pandemic contains materials and activities related to developing your skills and knowledge required to gain relevant and practical industrial skills under the guidance of your immersion teacher. It will guide you through the accomplishment of the different documents and in accomplishing your immersion portfolio.\n\nIn this module, you are required to accomplish all the learner's output and submit the required documents. You must follow and perform the activities on your own. If you have questions, do not hesitate to ask for assistance from your immersion teacher with the following details.")
  const [howToUseDraft, setHowToUseDraft] = useState(howToUseText)
  const [howToUseEditing, setHowToUseEditing] = useState(false)
  const [howToUseImages, setHowToUseImages] = useState([])
  const [howToUseLoading, setHowToUseLoading] = useState(true)
  const [howToUseSaving, setHowToUseSaving] = useState(false)
  const [howToUseError, setHowToUseError] = useState('')
  const [howToUseMessage, setHowToUseMessage] = useState('')
  const HOW_TO_USE_SECTION = 'Module Introduction/How to Use This Work Immersion Module'

  useEffect(() => {
    let cancelled = false
    const loadHowToUse = async () => {
      console.log('LOAD HOW TO USE STARTED')
      if (!user?.id) return
      setHowToUseLoading(true)
      setHowToUseError('')
      try {
        const { data, error } = await loadPortfolioEntry(supabase, user.id, HOW_TO_USE_SECTION)
        if (error) throw error
        if (!data?.content) return
       let saved = data.content

if (typeof saved === 'string') {
  try {
    saved = JSON.parse(saved)
  } catch {
    saved = { text: saved, images: [] }
  }
}

// Handle JSON stored as a string inside the JSONB column
if (typeof saved === 'string') {
  try {
    saved = JSON.parse(saved)
  } catch {
    saved = { text: saved, images: [] }
  }
}
        if (!cancelled) {
          if (typeof saved?.text === 'string') {
            setHowToUseText(saved.text)
            setHowToUseDraft(saved.text)
          }
          const images = Array.isArray(saved?.images) ? saved.images : []
          if (!cancelled) setHowToUseImages(images.filter((item) => item?.path))
        }
      } catch (error) {
        console.error('Load How to Use content failed:', error)
        if (!cancelled) setHowToUseError(error?.message || 'Unable to load saved text and photos.')
      } finally {
        if (!cancelled) setHowToUseLoading(false)
      }
    }
    loadHowToUse()
    return () => { cancelled = true }
  },[user?.id])
   
  
  const saveHowToUse = async (textValue = howToUseText, imageItems = howToUseImages) => {
    if (!user?.id) throw new Error('Please log in again before saving.')
    const content = JSON.stringify({
      text: textValue,
      images: imageItems.map(({ path, name }) => ({ path, name }))
    })
    const { error } = await savePortfolioEntry(supabase, {
      user_id: user.id,
      section: HOW_TO_USE_SECTION,
      content,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,section' })
    if (error) throw error
  }

  
const handleSaveHowToUse = async () => {
  setHowToUseSaving(true)
  setHowToUseError('')
  setHowToUseMessage('')

  try {
    await saveHowToUse(howToUseDraft, howToUseImages)
    setHowToUseText(howToUseDraft)
    setHowToUseEditing(false)
    setHowToUseMessage('Information saved.')
  } catch (error) {
    console.error('Save How to Use content failed:', error)
    setHowToUseError(
      error?.message || 'Unable to save. Please try again.'
    )
  } finally {
    setHowToUseSaving(false)
  }
}


  const [openFolder,setOpenFolder,] = useState(null)

  useEffect(() => {
  const loadTeacher = async () => {
    const { data, error } = await supabase
      .from('immersion_teacher')
      .select('*')
      .eq('id', 1)
      .single()

    if (error) {
      console.error('Teacher load error:', error.message)
      setTeacherLoading(false)
      return
    }

    setTeacherName(data.teacher_name || '')
    setTeacherEmail(data.teacher_email || '')
    setTeacherPhone(data.teacher_phone || '')
    setTeacherGroupChat(data.teacher_group_chat || '')
    setTeacherMessenger(data.teacher_messenger || '')
    
if (data.teacher_photo_url) {
  const { data: signedData, error: signedError } =
    await supabase.storage
      .from('portfolio-files')
      .createSignedUrl(data.teacher_photo_url, 3600)

  if (signedError) {
    console.error('Teacher photo load error:', signedError.message)
    setTeacherPhoto('')
  } else {setTeacherPhoto(signedData.signedUrl)
  }
} else {setTeacherPhoto('')
}


    setTeacherLoading(false)
  }

  loadTeacher()
}, [])


const [teacherPhoto, setTeacherPhoto] = useState('')
const [teacherName, setTeacherName] = useState('')
const [teacherEmail, setTeacherEmail] = useState('')
const [teacherPhone, setTeacherPhone] = useState('')
const [teacherGroupChat, setTeacherGroupChat] = useState('')
const [teacherMessenger, setTeacherMessenger] = useState('')
const [teacherLoading, setTeacherLoading] = useState(true)

const [openModule, setOpenModule] = useState(null)

useEffect(() => {
  const loadTeacher = async () => {
    try {
      const { data, error } = await supabase
        .from('immersion_teacher')
        .select('*')
        .eq('id', 1)
        .single()

      if (error) throw error

      setTeacherName(data.teacher_name || '')
      setTeacherEmail(data.teacher_email || '')
      setTeacherPhone(data.teacher_phone || '')
      setTeacherGroupChat(data.teacher_group_chat || '')
      setTeacherMessenger(data.teacher_messenger || '')

      if (data.teacher_photo_url) {
        const { data: signedData, error: signedError } =
          await supabase.storage
            .from('portfolio-files')
            .createSignedUrl(data.teacher_photo_url, 3600)

        if (signedError) throw signedError

        setTeacherPhoto(signedData.signedUrl)
      } else {
        setTeacherPhoto('')
      }
    } catch (error) {
      console.error('Teacher load error:', error.message)
    } finally {
      setTeacherLoading(false)
    }
  }

  loadTeacher()
}, [])

const saveTeacherInfo = async () => {
  try {
    setTeacherLoading(true)

    const { data, error } = await supabase
      .from('immersion_teacher')
      .update({
        teacher_name: teacherName,
        teacher_email: teacherEmail,
        teacher_phone: teacherPhone,
        teacher_group_chat: teacherGroupChat,
        teacher_messenger: teacherMessenger,
      })
      .eq('id', 1)
      .select('id')

    if (error) throw error

    if (!data || data.length === 0) {
      throw new Error(
        'No teacher record was updated. Check the row ID and Supabase permissions.'
      )
    }

    alert('Teacher information saved successfully!')
  } catch (error) {
    console.error('Save teacher info error:', error)
    alert(error.message || 'Unable to save teacher information.')
  } finally {
    setTeacherLoading(false)
  }
}

const [coverPhoto, setCoverPhoto] = useState(null)
const [coverPhotoUrl, setCoverPhotoUrl] = useState(null)
const [uploading, setUploading] = useState(false)
const [coverEditing, setCoverEditing] = useState(false)
const [coverSaving, setCoverSaving] = useState(false)
const [coverMessage, setCoverMessage] = useState('')
const [coverForm, setCoverForm] = useState({
  track: user?.track || '',
  strand: user?.strand || '',
  specialization: user?.specialization || '',
  student_name: user?.full_name || '',
  school_name: user?.school || 'Western Cagayan School of Arts and Trades',
})

useEffect(() => {
  let cancelled = false
  const loadCoverPage = async () => {
    if (!user?.id) return
    const { data, error } = await loadPortfolioEntry(supabase, user.id, 'Module Introduction/Cover Page')

    if (error) {
      console.error('LOAD COVER PAGE ERROR:', error)
      return
    }

    let saved = data?.content || {}
    if (typeof saved === 'string') {
      try { saved = JSON.parse(saved) } catch { saved = {} }
    }
    if (cancelled) return

    setCoverForm({
      track: saved.track ?? user?.track ?? '',
      strand: saved.strand ?? user?.strand ?? '',
      specialization: saved.specialization ?? user?.specialization ?? '',
      student_name: saved.student_name ?? user?.full_name ?? '',
      school_name: saved.school_name ?? user?.school ?? 'Western Cagayan School of Arts and Trades',
    })

    const filePath = saved.cover_photo_path
    if (!filePath) return
    setCoverPhoto(filePath)
    const { data: signed, error: signedError } = await getPortfolioSignedUrl(user.id, filePath)
    if (signedError) {
      console.error('COVER PHOTO SIGNED URL ERROR:', signedError)
      return
    }
    if (!cancelled) setCoverPhotoUrl(signed.signedUrl)
  }
  loadCoverPage()
  return () => { cancelled = true }
}, [user?.id, user?.track, user?.strand, user?.specialization, user?.full_name, user?.school])

const saveCoverPage = async (overrides = {}) => {
  if (!user?.id) throw new Error('Please log in again before saving.')
  const content = {
    ...coverForm,
    ...overrides,
    cover_photo_path: overrides.cover_photo_path ?? coverPhoto,
  }
  const { error } = await savePortfolioEntry(supabase, {
    user_id: user.id,
    section: 'Module Introduction/Cover Page',
    content,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id,section' })
  if (error) throw error
}

const handleSaveCoverPage = async () => {
  setCoverSaving(true)
  setCoverMessage('')
  try {
    await saveCoverPage()
    setCoverEditing(false)
    setCoverMessage('Cover page saved successfully.')
  } catch (error) {
    console.error('SAVE COVER PAGE ERROR:', error)
    setCoverMessage(error?.message || 'Unable to save the cover page.')
  } finally {
    setCoverSaving(false)
  }
}

const uploadCoverPhoto = async (event) => {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  if (!user?.id) {
    setCoverMessage('User ID is missing. Please log in again.')
    return
  }
  if (!file.type.startsWith('image/')) {
    setCoverMessage('Please choose an image file.')
    return
  }

  setUploading(true)
  setCoverMessage('')
  const extension = file.name.split('.').pop()?.replace(/[^a-zA-Z0-9]/g, '') || 'png'
  const filePath = `${user.id}/cover-page-${Date.now()}.${extension}`
  try {
    await savePortfolioPhoto(user.id, filePath, file)

    const { data: signed, error: signedError } = await getPortfolioSignedUrl(user.id, filePath)
    if (signedError) throw signedError

    const { error: saveError } = await savePortfolioEntry(supabase, {
      user_id: user.id,
      section: 'Module Introduction/Cover Page',
      content: { ...coverForm, cover_photo_path: filePath },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,section' })
    if (saveError) throw saveError

    setCoverPhoto(filePath)
    setCoverPhotoUrl(signed.signedUrl)
    setCoverMessage('School logo/photo uploaded and saved.')
  } catch (error) {
    console.error('UPLOAD COVER PHOTO ERROR:', error)
    setCoverMessage(error?.message || 'Unable to upload the school logo/photo.')
  } finally {
    setUploading(false)
  }
}


const handleDownloadPortfolio = async () => {
  if (!user?.id) {
    alert('Please log in first.');
    return;
  }

  const filename = 'My_Work_Immersion_Portfolio.pdf'
  const saveRequest = requestPdfSaveLocation(filename)

  try {
    const pdfBlob = await createPortfolioPdf(user.id, { filename, download: false })
    await savePdfBlob(pdfBlob, filename, saveRequest)
  } catch (error) {
    if (error?.name === 'AbortError') return
    console.error('Portfolio PDF export failed:', error);
    alert('Unable to download portfolio as PDF.');
  }
};



  const portfolioFolders = [
    {
      title:
        'Module Introduction',
      description:
        'Start your Work Immersion portfolio with the basic module requirements.',
      items: [
        'Cover Page',
        'Objectives',
        'Instructions',
        'Duties',
        'Checklist',
        'Student ID',
      ],
    },
    {
      title:
        'Pre-Immersion',
      description:
        'Complete the requirements before beginning your Work Immersion.',
      items: [
        'Requirements Checklist',
        'Parent Consent',
        'List of Task',
        'Essay on Workplace Conduct',
        'Application Letter',
        'Resume',
        'Barangay Clearance',
        'Police Clearance',
        'Mayors Clearance',
        'Health Clearance',
      ],
    },
    {
      title:
        'Immersion Proper',
      description:
        'Document your experiences and activities during Work Immersion.',
      items: ['Narrative Report', 'Work Immersion Map Location', 'Evaluation Sheet', 'Daily Time Record'],
    },
    {
      title:
        'Post-Immersion',
      description:
        'Complete the final requirements after your Work Immersion.',
      items: [
        'Written Report',
        'Forms',
        'Sample',
        'Gallery',
        'Evaluation',
        'Self Evaluation and Reflection',
        'Certificate',
      ],
    },
  ]

  if (openFolder === 'Pre-Immersion') {
    if (openModule === 'Requirements Checklist') {
      return (
        <RequirementsChecklistPage
          user={user}
          onBack={() => setOpenModule(null)}
        />
      )
    }

    if (openModule === 'Class Schedule') {
      return <ClassSchedulePage user={user} onBack={() => setOpenModule(null)} />
    }

    if (openModule === 'Parent Consent') {
      return <ParentConsentPage user={user} onBack={() => setOpenModule(null)} />
    }

    if (openModule === 'List of Task') {
      return <ListOfTaskPage user={user} onBack={() => setOpenModule(null)} />
    }

    if (openModule === 'Essay on Workplace Conduct') {
      return (
        <WorkplaceConductEssayPage
          user={user}
          onBack={() => setOpenModule(null)}
        />
      )
    }

    if (openModule === 'Application Letter') {
      return (
        <ApplicationLetterPage
          user={user}
          onBack={() => setOpenModule(null)}
        />
      )
    }

    if (openModule === 'Resume') {
      return <ResumePage user={user} onBack={() => setOpenModule(null)} />
    }

    if (openModule === 'Barangay Clearance') {
      return <BarangayClearancePage user={user} onBack={() => setOpenModule(null)} />
    }

    if (openModule === 'Police Clearance') {
      return <PoliceClearancePage user={user} onBack={() => setOpenModule(null)} />
    }

    if (openModule === 'Mayors Clearance') {
      return <MayorsClearancePage user={user} onBack={() => setOpenModule(null)} />
    }

    if (openModule === 'Health Clearance') {
      return <HealthClearancePage user={user} onBack={() => setOpenModule(null)} />
    }

    return (
      <div className="dashboard-section portfolio-unframed-page">
        <button
          type="button"
          className="portfolio-back-button"
          onClick={() => setOpenFolder(null)}
        >
          ← Back to My Portfolio
        </button>

        <p className="eyebrow">
          STUDENT DASHBOARD / MY PORTFOLIO / PRE-IMMERSION
        </p>

        <h1>PRE-IMMERSION</h1>

        <p>
          Complete the requirements before beginning your Work Immersion.
        </p>

        <div className="portfolio-pre-immersion-list">
          {portfolioFolders
            .find((folder) => folder.title === 'Pre-Immersion')
            .items.map((item, index) => (
              <button
                type="button"
                className="portfolio-pre-immersion-item"
                key={item}
                onClick={() => {
                  if (
                    item === 'Requirements Checklist' ||
                    item === 'Class Schedule' ||
                    item === 'Parent Consent' ||
                    item === 'List of Task' ||
                    item === 'Essay on Workplace Conduct' ||
                    item === 'Application Letter' ||
                    item === 'Resume' ||
                    item === 'Barangay Clearance' ||
                    item === 'Police Clearance' ||
                    item === 'Mayors Clearance' ||
                    item === 'Health Clearance'
                  ) {
                    setOpenModule(item)
                  }
                }}
              >
                <span className="portfolio-module-number">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span className="portfolio-module-title">{item}</span>
                <span className="portfolio-module-arrow">→</span>
              </button>
            ))}
        </div>
      </div>
    )
  }

  if (openFolder === 'Immersion Proper') {
    if (openModule === 'Narrative Report') {
      return (
        <NarrativeReportPage
          user={user}
          onBack={() => setOpenModule(null)}
        />
      )
    }

    if (openModule === 'Work Immersion Map Location') {
      return (
        <WorkImmersionMapLocationPage
          user={user}
          onBack={() => setOpenModule(null)}
        />
      )
    }

    if (openModule === 'Evaluation Sheet') {
      return (
        <WorkImmersionEvaluationSheetPage
          user={user}
          onBack={() => setOpenModule(null)}
        />
      )
    }

    if (openModule === 'Daily Time Record') {
      return (
        <DailyTimeRecordPage
          user={user}
          onBack={() => setOpenModule(null)}
        />
      )
    }

    return (
      <div className="dashboard-section portfolio-unframed-page">
        <button
          type="button"
          className="portfolio-back-button"
          onClick={() => setOpenFolder(null)}
        >
          ← Back to My Portfolio
        </button>

        <p className="eyebrow">
          STUDENT DASHBOARD / MY PORTFOLIO / IMMERSION PROPER
        </p>

        <h1>IMMERSION PROPER</h1>

        <p>
          Document your experiences and activities during your Work Immersion.
        </p>

        <div className="portfolio-pre-immersion-list">
          <button
            type="button"
            className="portfolio-pre-immersion-item immersion-narrative-report-button"
            onClick={() => setOpenModule('Narrative Report')}
          >
            <span className="portfolio-module-number">01</span>
            <span className="portfolio-module-title">Narrative Report</span>
            <span className="portfolio-module-arrow">→</span>
          </button>
          <button
            type="button"
            className="portfolio-pre-immersion-item immersion-narrative-report-button"
            onClick={() => setOpenModule('Work Immersion Map Location')}
          >
            <span className="portfolio-module-number">02</span>
            <span className="portfolio-module-title">Work Immersion Map Location</span>
            <span className="portfolio-module-arrow">→</span>
          </button>
          <button
            type="button"
            className="portfolio-pre-immersion-item immersion-narrative-report-button"
            onClick={() => setOpenModule('Evaluation Sheet')}
          >
            <span className="portfolio-module-number">03</span>
            <span className="portfolio-module-title">Evaluation Sheet</span>
            <span className="portfolio-module-arrow">→</span>
          </button>
          <button
            type="button"
            className="portfolio-pre-immersion-item immersion-narrative-report-button"
            onClick={() => setOpenModule('Daily Time Record')}
          >
            <span className="portfolio-module-number">04</span>
            <span className="portfolio-module-title">Daily Time Record</span>
            <span className="portfolio-module-arrow">→</span>
          </button>
        </div>
      </div>
    )
  }

  if (openFolder === 'Post-Immersion') {
    if (openModule === 'Written Report') {
      return (
        <WrittenReportPage
          user={user}
          onBack={() => setOpenModule(null)}
        />
      )
    }

    if (openModule === 'Evaluation') {
      return (
        <PostImmersionEvaluationPage
          user={user}
          onBack={() => setOpenModule(null)}
        />
      )
    }

    if (openModule === 'Self Evaluation and Reflection') {
      return (
        <PostImmersionEvaluationPage
          user={user}
          onBack={() => setOpenModule(null)}
          section="Post-Immersion/Self Evaluation and Reflection"
          pageName="Self Evaluation and Reflection"
        />
      )
    }

    if (openModule === 'Certificate') {
      return (
        <PostImmersionFormsPage
          user={user}
          onBack={() => setOpenModule(null)}
          section="Post-Immersion/Certificate"
          pageName="Certificate"
          documentTitle="CERTIFICATE"
          instruction="Upload your certificate here."
          uploadText="Upload your Certificate photo."
          showCaption={false}
        />
      )
    }

    if (openModule === 'Forms') {
      return (
        <PostImmersionFormsPage
          user={user}
          onBack={() => setOpenModule(null)}
        />
      )
    }

    if (openModule === 'Sample') {
      return (
        <PostImmersionFormsPage
          user={user}
          onBack={() => setOpenModule(null)}
          section="Post-Immersion/Sample"
          pageName="Sample"
        />
      )
    }

    if (openModule === 'Gallery') {
      return (
        <PostImmersionGalleryPage
          user={user}
          onBack={() => setOpenModule(null)}
        />
      )
    }

    return (
      <div className="dashboard-section portfolio-unframed-page">
        <button
          type="button"
          className="portfolio-back-button"
          onClick={() => setOpenFolder(null)}
        >
          ← Back to My Portfolio
        </button>

        <p className="eyebrow">
          STUDENT DASHBOARD / MY PORTFOLIO / POST-IMMERSION
        </p>

        <h1>POST-IMMERSION</h1>

        <p>Complete your final Work Immersion requirements.</p>

        <div className="portfolio-pre-immersion-list">
          <button
            type="button"
            className="portfolio-pre-immersion-item immersion-narrative-report-button"
            onClick={() => setOpenModule('Written Report')}
          >
            <span className="portfolio-module-number">01</span>
            <span className="portfolio-module-title">Written Report</span>
            <span className="portfolio-module-arrow">→</span>
          </button>
          <button
            type="button"
            className="portfolio-pre-immersion-item immersion-narrative-report-button"
            onClick={() => setOpenModule('Forms')}
          >
            <span className="portfolio-module-number">02</span>
            <span className="portfolio-module-title">Forms</span>
            <span className="portfolio-module-arrow">→</span>
          </button>
          <button
            type="button"
            className="portfolio-pre-immersion-item immersion-narrative-report-button"
            onClick={() => setOpenModule('Sample')}
          >
            <span className="portfolio-module-number">03</span>
            <span className="portfolio-module-title">Sample</span>
            <span className="portfolio-module-arrow">→</span>
          </button>
          <button
            type="button"
            className="portfolio-pre-immersion-item immersion-narrative-report-button"
            onClick={() => setOpenModule('Gallery')}
          >
            <span className="portfolio-module-number">04</span>
            <span className="portfolio-module-title">Gallery</span>
            <span className="portfolio-module-arrow">→</span>
          </button>
          <button
            type="button"
            className="portfolio-pre-immersion-item immersion-narrative-report-button"
            onClick={() => setOpenModule('Evaluation')}
          >
            <span className="portfolio-module-number">05</span>
            <span className="portfolio-module-title">Evaluation</span>
            <span className="portfolio-module-arrow">→</span>
          </button>
          <button
            type="button"
            className="portfolio-pre-immersion-item immersion-narrative-report-button"
            onClick={() => setOpenModule('Self Evaluation and Reflection')}
          >
            <span className="portfolio-module-number">06</span>
            <span className="portfolio-module-title">Self Evaluation and Reflection</span>
            <span className="portfolio-module-arrow">→</span>
          </button>
          <button
            type="button"
            className="portfolio-pre-immersion-item immersion-narrative-report-button"
            onClick={() => setOpenModule('Certificate')}
          >
            <span className="portfolio-module-number">07</span>
            <span className="portfolio-module-title">Certificate</span>
            <span className="portfolio-module-arrow">→</span>
          </button>
        </div>
      </div>
    )
  }

  /* MODULE INTRODUCTION */

  if (
    openFolder ===
    'Module Introduction'
  ) {

   if (openModule === 'Cover Page') {
     const updateCoverField = (field, value) => setCoverForm(current => ({ ...current, [field]: value }))
     const coverFields = [
       { key: 'track', label: 'TRACK' },
       { key: 'strand', label: 'STRAND' },
       { key: 'specialization', label: 'SPECIALIZATION' },
       { key: 'student_name', label: 'STUDENT NAME' },
       { key: 'school_name', label: 'SCHOOL NAME', wide: true },
     ]
     return (
       <div className="dashboard-section cover-page-screen">
         <style>{`
           .cover-page-toolbar{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;margin:0 0 18px}
           .cover-page-action{border:1px solid #dedede;border-radius:9px;padding:10px 15px;background:#fff;color:#111;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:8px}
           .cover-page-action.primary{background:#171717;color:#fff;border-color:#171717}
           .cover-page-sheet{box-sizing:border-box;background:#fff;color:#111;border:1px solid #dedede;border-radius:12px;padding:40px;max-width:900px;margin:0 auto 24px;font-family:Arial,Helvetica,sans-serif}
           .cover-page-logo{width:180px;height:180px;border:2px dashed #e0e0e0;border-radius:12px;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;overflow:hidden;color:#777;background:#fff}
           .cover-page-logo img{width:100%;height:100%;object-fit:contain}
           .cover-page-fields{display:grid;grid-template-columns:1fr 1fr;gap:24px 28px;margin-top:38px}
           .cover-page-field{border-bottom:1px solid #dedede;padding-bottom:10px;min-width:0}
           .cover-page-field.wide{grid-column:1/-1}
           .cover-page-field label{display:block;font-size:13px;color:#777;margin-bottom:8px}
           .cover-page-field input{width:100%;box-sizing:border-box;border:0;border-bottom:1px solid #999;padding:5px 0;background:#fff;color:#111;font:inherit;outline:none}
           .cover-page-value{font-size:16px;min-height:22px;overflow-wrap:anywhere}
           .cover-page-message{max-width:900px;margin:0 auto 14px;font-size:14px;color:#555}
           @media(max-width:640px){.cover-page-sheet{padding:24px 18px}.cover-page-fields{gap:22px 16px}.cover-page-logo{width:150px;height:150px}.cover-page-title{font-size:clamp(20px,5vw,28px)!important}}
           @page{size:A4 portrait;margin:12mm}
           @media print{body *{visibility:hidden!important}.cover-page-sheet,.cover-page-sheet *{visibility:visible!important}.cover-page-screen{padding:0!important;margin:0!important}.cover-page-screen .cover-page-sheet{position:absolute;left:0;top:0;width:100%;max-width:none;margin:0;border:0;border-radius:0;padding:12mm;box-shadow:none}.cover-page-toolbar,.cover-page-message,.portfolio-back-button,.cover-page-screen>.eyebrow,.cover-page-screen>h1{display:none!important}.cover-page-field input{display:none!important}.cover-page-value{display:block!important}}
         `}</style>
         <button type="button" className="portfolio-back-button" onClick={() => setOpenModule(null)}>← Back to Module Introduction</button>
         <div className="cover-page-toolbar">
           <button type="button" className="cover-page-action" onClick={() => window.print()}>▣ Print</button>
           {!coverEditing ? (
             <button type="button" className="cover-page-action primary" onClick={() => { setCoverMessage(''); setCoverEditing(true) }}>✎ Edit</button>
           ) : (
             <>
               <button type="button" className="cover-page-action" onClick={() => { setCoverForm({ track: user?.track || '', strand: user?.strand || '', specialization: user?.specialization || '', student_name: user?.full_name || '', school_name: user?.school || 'Western Cagayan School of Arts and Trades' }); setCoverEditing(false); setCoverMessage('Edits cancelled.') }}>Cancel</button>
               <button type="button" className="cover-page-action primary" disabled={coverSaving} onClick={handleSaveCoverPage}>{coverSaving ? 'Saving...' : 'Save'}</button>
             </>
           )}
         </div>
         {coverMessage && <p className="cover-page-message" role="status">{coverMessage}</p>}
         <section className="cover-page-sheet">
           <div style={{display:'flex',alignItems:'center',flexDirection:'column',textAlign:'center'}}>
             <div style={{fontSize:16,fontWeight:600,marginBottom:10}}>School Logo / Photo</div>
             <label className="cover-page-logo" style={{cursor:uploading?'wait':'pointer'}} title="Upload school logo or photo">
               {coverPhotoUrl ? <img src={coverPhotoUrl} alt="Uploaded school logo or photo" /> : <><span style={{fontSize:28}}>▧</span><strong>{uploading ? 'Uploading...' : 'Click to upload'}</strong><span style={{fontSize:12}}>JPG, PNG</span></>}
               <input type="file" accept="image/png,image/jpeg,image/webp" hidden disabled={uploading} onChange={uploadCoverPhoto} />
             </label>
           </div>
           <div style={{textAlign:'center',marginTop:38}}>
             <h2 className="cover-page-title" style={{fontSize:28,lineHeight:1.25,margin:'0 0 8px',fontWeight:800}}>WORK IMMERSION PORTFOLIO</h2>
             <p style={{color:'#777',fontSize:16,margin:0}}>Senior High School · Grade 12</p>
           </div>
           <div className="cover-page-fields">
             {coverFields.map(field => (
               <div key={field.key} className={`cover-page-field${field.wide?' wide':''}`}>
                 <label>{field.label}</label>
                 {coverEditing ? (
                   <input value={coverForm[field.key] || ''} onChange={event => updateCoverField(field.key,event.target.value)} placeholder={`Enter ${field.label.toLowerCase()}`} />
                 ) : (
                   <div className="cover-page-value">{coverForm[field.key] || '—'}</div>
                 )}
               </div>
             ))}
           </div>
         </section>
       </div>
     )
   }

   if (
  openModule ===
  'Work Immersion Objectives'
) {
  return (
    <div className="dashboard-section">

      <button
        type="button"
        className="portfolio-back-button"
        onClick={() =>
          setOpenModule(null)
        }
      >
        ← Back to Module Introduction
      </button>

      <p className="eyebrow">
        MODULE INTRODUCTION / OBJECTIVES
      </p>

      <h1>
        WORK IMMERSION OBJECTIVES
      </h1>

      <p>
        One of the goals of the K to 12 Basic Education Program is for you
        to develop the competencies, work ethics, and values relevant in
        pursuing further education and/or joining the world of work.
      </p>

      <p>
        To become a productive citizen who contributes to our nation's
        development, Work Immersion is a required Senior High School subject
        that provides these opportunities:
      </p>

      <ol>
        <li>Become familiar with the workplace;</li>
        <li>Experience employment simulation; and</li>
        <li>
          Apply your Computer Systems Servicing competencies in an authentic
          work environment.
        </li>
      </ol>

      <p>
        To achieve the above objectives, Work Immersion is a requirement for
        graduation from secondary education. Learners complete school-based
        work immersion simulation and home-based activities, then submit and
        present a portfolio to a panel at the end of the subject.
      </p>

    </div>
  )
}

if (
  openModule === 'How to Use This Work Immersion Module'
) {
  return (
    <div className="dashboard-section">

      <button
        type="button"
        className="portfolio-back-button"
        onClick={() => setOpenModule(null)}
      >
        ← Back to Module Introduction
      </button>

      <p className="eyebrow">
        MODULE INTRODUCTION / HOW TO USE
      </p>

      <h1>
        HOW TO USE THIS WORK IMMERSION MODULE
      </h1>

      <div className="module-card">
        {howToUseLoading ? <p>Loading saved content...</p> : (
          <>
            {howToUseEditing ? (
              <textarea
                id="portfolio-how-to-use-text"
                value={howToUseDraft}
                onChange={(event) => {
                  setHowToUseDraft(event.target.value)
                  setHowToUseMessage('')
                  setHowToUseError('')
                }}
                rows={9}
                style={{ display: 'block', width: '100%', boxSizing: 'border-box', minHeight: 180, padding: 12, border: '1px solid #d1d5db', borderRadius: 10, font: 'inherit', lineHeight: 1.6, resize: 'vertical', background: 'var(--input-bg, #fff)', color: 'inherit' }}
                disabled={howToUseSaving}
              />
            ) : (
              <p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{howToUseText}</p>
            )}
            <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
              {howToUseEditing ? (
                <button type="button" className="primary-btn" onClick={handleSaveHowToUse} disabled={howToUseSaving}>
                  {howToUseSaving ? 'Saving...' : 'Save'}
                </button>
              ) : (
                <button type="button" className="primary-btn" onClick={() => {
                  setHowToUseDraft(howToUseText)
                  setHowToUseMessage('')
                  setHowToUseError('')
                  setHowToUseEditing(true)
                }}>
                  Edit
                </button>
              )}
            </div>
            {howToUseError && <p role="alert" style={{ color: '#b91c1c', marginTop: 10 }}>{howToUseError}</p>}
            {howToUseMessage && <p role="status" style={{ color: '#166534', marginTop: 10 }}>{howToUseMessage}</p>}
          </>
        )}
      </div>

      {/* IMMERSION TEACHER CARD */}
      <div className="module-card">

        <h2>Immersion Teacher Information</h2>

        <div className="teacher-profile-layout">

          {/* LEFT: 2x2 PHOTO */}
          <div className="immersion-photo-section">

            <label className="immersion-photo">

              {teacherPhoto ? (
                <img
                  src={teacherPhoto}
                  alt="Immersion Teacher"
                />
              ) : (
                <span>Upload 2×2 Photo</span>
              )}

<input
  type="file"
  accept="image/*"
  hidden
  onChange={async (event) => {
    const file = event.target.files?.[0];

    if (!file || !user?.id) return;

    try {
      setTeacherLoading(true);

      const extension = file.name.split('.').pop();
      const filePath = `${user.id}/teacher-photo-${Date.now()}.${extension}`;

      const { error: uploadError } = await supabase.storage
        .from('portfolio-files')
        .upload(filePath, file, {
          upsert: true,
          contentType: file.type,
        });

      if (uploadError) throw uploadError;

      const { data: signedData, error: signedError } =
        await getPortfolioSignedUrl(user.id, filePath);

      if (signedError) throw signedError;

      const { error: saveError } = await supabase
        .from('immersion_teacher')
        .update({
          teacher_photo_url: filePath,
        })
        .eq('id', 1);

      if (saveError) throw saveError;

      setTeacherPhoto(signedData.signedUrl);
    } catch (error) {
      console.error('Teacher photo upload error:', error);
      alert(error.message || 'Unable to save teacher photo.');
    } finally {
      setTeacherLoading(false);
      event.target.value = '';
    }
  }}
/>
</label>


            <p>Click to upload 2×2 photo</p>

          </div>

          {/* RIGHT: EDITABLE INFORMATION */}
          <div className="teacher-contact">

            <label>
              Teacher Name

              <input
                type="text"
                value={teacherName}
                onChange={(e) =>
                  setTeacherName(e.target.value)
                }
                placeholder="Enter teacher's name"
              />
            </label>

            <label>
              Email Address

              <input
                type="email"
                value={teacherEmail}
                onChange={(e) =>
                  setTeacherEmail(e.target.value)
                }
                placeholder="Enter email address"
              />
            </label>

            <label>
              CP Number

              <input
                type="tel"
                value={teacherPhone}
                onChange={(e) =>
                  setTeacherPhone(e.target.value)
                }
                placeholder="Enter contact number"
              />
            </label>

            <label>
              Group Chat

              <input
                type="text"
                value={teacherGroupChat}
                onChange={(e) =>
                  setTeacherGroupChat(e.target.value)
                }
                placeholder="Enter group chat link or name"
              />
            </label>

            <label>
              Messenger

              <input
                type="text"
                value={teacherMessenger}
                onChange={(e) =>
                  setTeacherMessenger(e.target.value)
                }
                placeholder="Enter Messenger name or link"
              />
            </label>

          </div>

        </div>

      </div>

      <h2>Remember to:</h2>

      <ul>
        <div
  style={{
    display: 'flex',
    justifyContent: 'flex-end',
    marginTop: 20,
  }}
>
  <button
    type="button"
    className="primary-btn"
    onClick={handleSaveHowToUse}
    disabled={howToUseSaving || howToUseLoading}
  >
    {howToUseSaving ? 'Saving...' : 'Save'}
  </button>
</div>
        <li>
          Work through all the information and complete the
          activities in each section.
        </li>

        <li>
          Coordinate with your Work Immersion Teacher,
          who is assigned to supervise you at the school-based
          work simulation immersion venue, in coordination
          with your schedule of school-based and home-based
          activities.
        </li>

        <li>
          While in school or assigned community, treat it
          as you are in a workplace. You will be given
          opportunities to ask questions and practice
          on the job.
        </li>

        <li>
          When you feel confident that you have had enough
          practice, ask your Immersion Teacher to evaluate
          you. The results of your evaluation will be
          recorded and will be part of your grade.
        </li>

        <li>
          Submit accomplished portfolio to your immersion
          teacher for checking and as reference for the
          issuance of your certificate of completion.
        </li>
      </ul>

    </div>
  )
}

if (openModule === "Students' Duties & Responsibilities") {
  return (
    <div className="dashboard-section">
      <button
        type="button"
        className="portfolio-back-button"
        onClick={() => setOpenModule(null)}
      >
        ← Back to Module Introduction
      </button>

      <p className="eyebrow">MODULE INTRODUCTION / STUDENT DUTIES</p>
      <h1>STUDENT DUTIES AND RESPONSIBILITIES</h1>
      <StudentDutiesContent user={user} />
    </div>
  )
}

if (openModule === 'Portfolio Checklist') {
  return (
    <div className="dashboard-section">
      <button
        type="button"
        className="portfolio-back-button"
        onClick={() => setOpenModule(null)}
      >
        ← Back to Module Introduction
      </button>

      <p className="eyebrow">MODULE INTRODUCTION / PORTFOLIO CHECKLIST</p>
      <PortfolioChecklistPage user={user} />
    </div>
  )
}

if (openModule === 'Student ID') {
  return (
    <div className="dashboard-section">
      <button
        type="button"
        className="portfolio-back-button"
        onClick={() => setOpenModule(null)}
      >
        ← Back to Module Introduction
      </button>

      <p className="eyebrow">MODULE INTRODUCTION / STUDENT ID</p>
      <StudentIdPage user={user} />
    </div>
  )
}



    const moduleItems = [
      
      'Cover Page',
      'Work Immersion Objectives',
      'How to Use This Work Immersion Module',
      "Students' Duties & Responsibilities",
      'Portfolio Checklist',
      'Student ID',
    ]

    return (
      <div className="dashboard-section portfolio-module-introduction-page">

        <button
          type="button"
          className="portfolio-back-button"
          onClick={() =>
            setOpenFolder(
              null
            )
          }
        >
          ← Back to My Portfolio
        </button>

        <p className="eyebrow">
          STUDENT DASHBOARD / MY PORTFOLIO
        </p>

        <h1>
          MODULE INTRODUCTION
        </h1>

        <p>
          Complete all sections
          below to finish this
          module.
        </p>

        <div className="portfolio-module-list">

          {moduleItems.map(
            (
              item,
              index
            ) => (
              <button
                type="button"
                className="portfolio-module-item"
                key={item}
                onClick={() =>
                  setOpenModule(
                    item
                  )
                }
              >

                <span className="portfolio-module-number">
                  {String(
                    index + 1
                  ).padStart(
                    2,
                    '0'
                  )}
                </span>

                <span className="portfolio-module-title">
                  {item}
                </span>

                <span className="portfolio-module-arrow">
                  →
                </span>

              </button>
            )
          )}

        </div>
      </div>
    )
  }

  return (
    <div className="dashboard-section portfolio-unframed-page">

      <p className="eyebrow">
        STUDENT DASHBOARD / MY PORTFOLIO
      </p>

      <h1>
        My Portfolio
      </h1>

      <p>
        Build and organize your
        Work Immersion portfolio.
      </p>
      <section className="mobile-portfolio-overview">
        <div>
          <span>Portfolio overview</span>
          <strong>4 folders</strong>
        </div>
        <div>
          <span>Requirements</span>
          <strong>{portfolioFolders.reduce((total, folder) => total + folder.items.length, 0)}</strong>
        </div>
      </section>
      <button
        type="button"
       onClick={handleDownloadPortfolio}
      >
      Download Portfolio as PDF
      </button>

      <div className="portfolio-folder-list">

        {portfolioFolders.map(
          (folder) => (
            <button
              type="button"
              key={folder.title}
              className="portfolio-folder-card"
              style={{
                border:
                  '1px solid #888',
                borderRadius:
                  '12px',
                background:
                  'transparent',
                boxSizing:
                  'border-box',
              }}
              onClick={() => {
                setOpenFolder(
                  folder.title
                )

                setOpenModule(
                  null
                )
              }}
            >

              <div className="portfolio-folder-header">

                <div>

                  <h3>
                    {folder.title}
                  </h3>

                  <p>
                    {
                      folder.description
                    }
                  </p>

                </div>

                <span className="portfolio-folder-arrow">
                  →
                </span>

              </div>

              <div className="mobile-folder-card-content">
                <span className="mobile-folder-icon" aria-hidden="true">
                  <FolderOpen size={22} />
                </span>
                <div className="mobile-folder-copy">
                  <strong>{folder.title}</strong>
                  <p>{folder.description}</p>
                  <span>{folder.items.length} requirements</span>
                </div>
                <span className="mobile-folder-arrow" aria-hidden="true">→</span>
              </div>

              <ul>

                {folder.items.map(
                  (item) => (
                    <li
                      key={item}
                    >
                      {item}
                    </li>
                  )
                )}

              </ul>

            </button>
          )
        )}

      </div>

    </div>
  )
}

/* =========================
   PORTFOLIO THEME
========================= */

function PortfolioTheme({
  strand,
  title,
  description,
}) {
  return (
    <div className="portfolio-theme-card">

      <div className="portfolio-theme-preview">
        <FolderOpen size={40} />
      </div>

      <div className="portfolio-theme-info">

        <span className="eyebrow">
          {strand} STRAND
        </span>

        <h3>
          {title}
        </h3>

        <p>
          {description}
        </p>

        <button
          className="primary-btn"
          onClick={() =>
            alert(
              `${getPortfolioFormat(strand)?.format || strand} portfolio will be developed next.`
            )
          }
        >
          View Portfolio
        </button>

      </div>

    </div>
  )
}


/* =========================
   STUDENT HOME
========================= */

function StudentHome({
  user,
  setActivePage,
}) {
  const isAcademicStudent = isAcademicStrand(user?.strand)
  const [homeProfile, setHomeProfile] = useState(null)
  const [moduleIntroductionEntries, setModuleIntroductionEntries] = useState({})
  const [moduleIntroductionLoading, setModuleIntroductionLoading] = useState(true)
  const [moduleIntroductionError, setModuleIntroductionError] = useState('')
  const [portfolioExportingGroup, setPortfolioExportingGroup] = useState('')
  const [portfolioExportError, setPortfolioExportError] = useState('')
  const [joinedClass, setJoinedClass] = useState(null)
  const [immersionTeacher, setImmersionTeacher] = useState(null)
  const [classLoading, setClassLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    const loadModuleIntroductionProgress = async () => {
      if (isAcademicStudent) {
        setModuleIntroductionLoading(false)
        return
      }

      if (!user?.id) {
        setModuleIntroductionLoading(false)
        return
      }

      setModuleIntroductionError('')
      try {
        const { data, error } = await supabase
          .from('portfolio_entries')
          .select('section,content')
          .eq('user_id', user.id)
          .like('section', 'Module Introduction/%')
        if (error) throw error

        const entries = Object.fromEntries(
          (data || []).map((entry) => [entry.section, entry.content])
        )
        if (!cancelled) setModuleIntroductionEntries(entries)
        await saveOfflineData(
          portfolioCacheKey(user.id, 'Module Introduction/*'),
          entries
        )
      } catch (error) {
        console.error('Load Module Introduction progress failed:', error)
        if (!cancelled) {
          const cached = await getOfflineData(
            portfolioCacheKey(user.id, 'Module Introduction/*')
          )
          setModuleIntroductionEntries(cached?.data || cached || {})
          setModuleIntroductionError(error?.message || 'Could not load Module Introduction progress.')
        }
      } finally {
        if (!cancelled) setModuleIntroductionLoading(false)
      }
    }

    loadModuleIntroductionProgress()
    return () => { cancelled = true }
  }, [user?.id, isAcademicStudent])

  // LOAD STUDENT PROFILE
  useEffect(() => {
    const loadHomeProfile = async () => {
      if (!user?.id) return

      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .maybeSingle()

      if (error) {
        console.error('HOME PROFILE ERROR:', error)
        return
      }

      setHomeProfile(data)
    }

    loadHomeProfile()
  }, [user?.id])

  // LOAD JOINED CLASS AND TEACHER
  useEffect(() => {
    const loadJoinedClass = async () => {
      if (!user?.id) {
        setClassLoading(false)
        return
      }

      setClassLoading(true)

      const { data, error } = await supabase
        .from('class_members')
        .select(`
          class_id,
          joined_at,
          immersion_classes (
            id,
            class_name,
            class_code,
            teacher_id
          )
        `)
        .eq('student_id', user.id)
        .order('joined_at', { ascending: false })
        .limit(1)

      if (error) {
        console.error('JOINED CLASS ERROR:', error)
        setClassLoading(false)
        return
      }

      const classData = data?.[0]?.immersion_classes

      if (!classData) {
        setJoinedClass(null)
        setImmersionTeacher(null)
        setClassLoading(false)
        return
      }

      setJoinedClass(classData)

      // LOAD TEACHER PROFILE
      const { data: teacherData, error: teacherError } =
        await supabase
          .from('profiles')
          .select('full_name, email')
          .eq('id', classData.teacher_id)
          .maybeSingle()

      if (teacherError) {
        console.error('TEACHER PROFILE ERROR:', teacherError)
      }

    console.log('CLASS TEACHER ID:', classData.teacher_id)
console.log('TEACHER PROFILE DATA:', teacherData)
console.log('TEACHER PROFILE ERROR:', teacherError)

setImmersionTeacher(teacherData || null)
setClassLoading(false)
    }

    loadJoinedClass()
  }, [user?.id])

  // STUDENT INFORMATION
  const studentEmail =
    homeProfile?.email ||
    user?.email ||
    'Not set'

  const studentName =
    homeProfile?.full_name ||
    user?.full_name ||
    'Not set'

  const studentStrand = isAcademicStudent
    ? 'ACADEMIC'
    : homeProfile?.strand ||
      user?.strand ||
      'Not set'

  const studentTrack =
    homeProfile?.track ||
    user?.track ||
    'Not set'

  const studentSpecialization =
    homeProfile?.specialization ||
    user?.specialization ||
    'Not set'

  const studentSchool =
    homeProfile?.school ||
    user?.school ||
    'Not set'

  const studentGradeSection =
    (homeProfile?.grade || user?.grade) && (homeProfile?.section || user?.section)
      ? `${homeProfile?.grade || user?.grade} - ${homeProfile?.section || user?.section}`
      : homeProfile?.grade ||
        user?.grade ||
        homeProfile?.section ||
        user?.section ||
        'Not set'

  const moduleIntroductionProgress = getPortfolioProgress(moduleIntroductionEntries)
    .groups.find((group) => group.title === 'Module Introduction')
  const moduleIntroductionPercentage = moduleIntroductionProgress.total
    ? Math.round((moduleIntroductionProgress.completed / moduleIntroductionProgress.total) * 100)
    : 0

  const handleDownloadFillableFolder = async (groupTitle) => {
    if (!user?.id) {
      setPortfolioExportError('Your account could not be identified. Please log in again.')
      return
    }

    const folderNames = {
      'Post-Immersion': 'Post Immersion',
    }
    const folderName = (folderNames[groupTitle] || groupTitle).replace(/[^\w\s-]/g, '').trim()
    const filename = `ICT-WCSAT-Work-Immersion-2026-${folderName}.pdf`
    setPortfolioExportingGroup(groupTitle)
    setPortfolioExportError('')
    try {
      const pdfBytes = await createFillablePortfolioPdf(user, groupTitle)
      const pdfBlob = new Blob([pdfBytes], { type: 'application/pdf' })
      await savePdfBlob(pdfBlob, filename, null)
    } catch (error) {
      if (error?.name === 'AbortError') return
      console.error(`Generate fillable ${groupTitle} PDF failed:`, error)
      setPortfolioExportError(error?.message || `Could not generate the ${groupTitle} fillable PDF.`)
    } finally {
      setPortfolioExportingGroup('')
    }
  }

  return (
    <div className="student-home">

      {/* WELCOME */}
      <div className="home-welcome">
        <p className="eyebrow">
          STUDENT DASHBOARD
        </p>

        <h1>
          Welcome to i-WORKFOLIO!
        </h1>

        <p>
          Manage your Work Immersion
          portfolio and track your
          progress.
        </p>
      </div>

      {/* PORTFOLIO PROGRESS */}
      <section className="home-section">

        <div className="section-title-row">
          <h2>
            {isAcademicStudent ? 'Progress' : 'Module Introduction Progress'}
          </h2>

          {!isAcademicStudent && (
            <button
              className="edit-profile-btn"
              onClick={() =>
                setActivePage('My Profile')
              }
            >
              Edit Profile
            </button>
          )}
        </div>

        {isAcademicStudent ? (
          <>
            <div className="progress-label">
              <span>Academic progress</span>
              <strong>—</strong>
            </div>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: '0%' }} />
            </div>
          </>
        ) : (
          <>
            <div className="progress-label">
              <span>Module Introduction</span>
              <strong>
                {moduleIntroductionLoading ? '…' : moduleIntroductionError ? '—' : `${moduleIntroductionPercentage}%`}
              </strong>
            </div>

            <div className="progress-bar">
              <div
                className="progress-fill"
                style={{ width: `${moduleIntroductionLoading || moduleIntroductionError ? 0 : moduleIntroductionPercentage}%` }}
              />
            </div>

            <div className="progress-stats">
              <span>
                Completed sections:{' '}
                <strong>
                  {moduleIntroductionLoading ? '…' : moduleIntroductionError ? '—' : moduleIntroductionProgress.completed}
                </strong>
              </span>

              <span>
                Remaining sections:{' '}
                <strong>
                  {moduleIntroductionLoading ? '…' : moduleIntroductionError ? '—' : moduleIntroductionProgress.total - moduleIntroductionProgress.completed}
                </strong>
              </span>
            </div>

            {moduleIntroductionError && (
              <p role="alert" className="workplace-essay-message error">
                {moduleIntroductionError}
              </p>
            )}

            <p>Download a fillable PDF for each portfolio folder:</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {PORTFOLIO_PROGRESS_GROUPS.map((group) => (
                <button
                  key={group.title}
                  className="pdf-btn"
                  type="button"
                  onClick={() => handleDownloadFillableFolder(group.title)}
                  disabled={Boolean(portfolioExportingGroup)}
                >
                  <Download size={16} />
                  {portfolioExportingGroup === group.title
                    ? 'Preparing PDF...'
                    : `Download ${group.title}`}
                </button>
              ))}
            </div>
            {portfolioExportError && (
              <p role="alert" className="workplace-essay-message error">
                {portfolioExportError}
              </p>
            )}
          </>
        )}

      </section>

      {/* ACADEMIC INFORMATION */}
      {!isAcademicStudent && (
        <div className="academic-grid">
          <div className="academic-card">
            <span>TRACK</span>
            <strong>{studentTrack}</strong>
          </div>
          <div className="academic-card">
            <span>SPECIALIZATION</span>
            <strong>{studentSpecialization}</strong>
          </div>
        </div>
      )}

      {/* STUDENT INFORMATION */}
      <section className="home-section">

        <div className="section-title-row">
          <h2>
            Student Information
          </h2>
        </div>

        <div className="student-information-grid">

          <InfoItem
            label="STUDENT NAME"
            value={studentName}
          />

          <InfoItem
            label="EMAIL"
            value={studentEmail}
          />

          <InfoItem
            label="STRAND"
            value={studentStrand}
          />

          {!isAcademicStudent && (
            <InfoItem
              label="TRACK"
              value={studentTrack}
            />
          )}

          <InfoItem
            label="SCHOOL NAME"
            value={studentSchool}
          />

          <InfoItem
            label="GRADE & SECTION"
            value={studentGradeSection}
          />

        </div>

      </section>

      {/* WORK IMMERSION TEACHER */}
      <section className="home-section">

        <div className="section-title-row">
          <h2>
            Work Immersion Teacher
          </h2>
        </div>

        <div className="teacher-connection">

          <div className="teacher-status-dot" />

          <div>

            {classLoading ? (

              <strong>
                Loading class information...
              </strong>

            ) : joinedClass ? (

              <>
             
<strong>
  {immersionTeacher?.full_name ||
    'Teacher name not available'}
</strong>

                <span>
                  {joinedClass.class_name}
                </span>

                <span>
                  Class Code: {joinedClass.class_code}
                </span>
              </>

            ) : (

              <>
                <strong>
                  No teacher connected yet
                </strong>

                <span>
                  Join a class with a code.
                </span>

                <button
                  className="edit-profile-btn"
                  onClick={() =>
                    setActivePage(
                      'My Work Immersion Class'
                    )
                  }
                >
                  Join a Class
                </button>
              </>

            )}

          </div>

        </div>

      </section>

    </div>
  )
}

/* =========================
   MODULE INTRODUCTION
========================= */

function ModuleIntroduction({ user, setActivePage }) {
  const [immersionPhoto, setImmersionPhoto] = useState(null)
  const [openSection, setOpenSection] = useState(null)
  const [photoLoading, setPhotoLoading] = useState(false)
  const [photoError, setPhotoError] = useState('')

  // Cover Page: kept inside the actual Module Introduction page.
  const [coverForm, setCoverForm] = useState({
    track: user?.track || '',
    strand: user?.strand || '',
    specialization: user?.specialization || '',
    student_name: user?.full_name || '',
    school_name: user?.school || 'Western Cagayan School of Arts and Trades',
  })
  const [coverPhotoPath, setCoverPhotoPath] = useState(null)
  const [coverPhotoUrl, setCoverPhotoUrl] = useState('')
  const [coverEditing, setCoverEditing] = useState(false)
  const [coverSaving, setCoverSaving] = useState(false)
  const [coverUploading, setCoverUploading] = useState(false)
  const [coverMessage, setCoverMessage] = useState('')

  useEffect(() => {
    let cancelled = false
    const loadCoverPage = async () => {
      if (!user?.id) return
      const { data, error } = await loadPortfolioEntry(supabase, user.id, 'Module Introduction/Cover Page')
      if (error) {
        console.error('Load Cover Page failed:', error)
        return
      }
      let saved = data?.content || {}
      if (typeof saved === 'string') {
        try { saved = JSON.parse(saved) } catch { saved = {} }
      }
      if (cancelled) return
      setCoverForm({
        track: saved.track ?? user?.track ?? '',
        strand: saved.strand ?? user?.strand ?? '',
        specialization: saved.specialization ?? user?.specialization ?? '',
        student_name: saved.student_name ?? user?.full_name ?? '',
        school_name: saved.school_name ?? user?.school ?? 'Western Cagayan School of Arts and Trades',
      })
      if (saved.cover_photo_path) {
        setCoverPhotoPath(saved.cover_photo_path)
        const { data: signed, error: signedError } = await getPortfolioSignedUrl(user.id, saved.cover_photo_path)
        if (!signedError && !cancelled) setCoverPhotoUrl(signed.signedUrl)
        if (signedError) console.error('Load Cover Page photo failed:', signedError)
      }
    }
    loadCoverPage()
    return () => { cancelled = true }
  }, [user?.id, user?.track, user?.strand, user?.specialization, user?.full_name, user?.school])

  const saveCoverPage = async (formValue = coverForm, photoPath = coverPhotoPath) => {
    if (!user?.id) throw new Error('Please log in again before saving.')
    const { error } = await savePortfolioEntry(supabase, {
      user_id: user.id,
      section: 'Module Introduction/Cover Page',
      content: { ...formValue, cover_photo_path: photoPath },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,section' })
    if (error) throw error
  }

  const handleSaveCoverPage = async () => {
    setCoverSaving(true)
    setCoverMessage('')
    try {
      await saveCoverPage()
      setCoverEditing(false)
      setCoverMessage('Cover Page saved. Your details will remain after refreshing.')
    } catch (error) {
      console.error('Save Cover Page failed:', error)
      setCoverMessage(error?.message || 'Could not save the Cover Page.')
    } finally { setCoverSaving(false) }
  }

  const handleCoverPhotoUpload = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!user?.id) { setCoverMessage('Please log in again before uploading.'); return }
    if (!file.type.startsWith('image/')) { setCoverMessage('Please choose an image file.'); return }
    setCoverUploading(true)
    setCoverMessage('')
    const ext = file.name.split('.').pop()?.replace(/[^a-zA-Z0-9]/g, '') || 'png'
    const path = `${user.id}/cover-page-${Date.now()}.${ext}`
    try {
      await savePortfolioPhoto(user.id, path, file)
      const { data: signed, error: signedError } = await getPortfolioSignedUrl(user.id, path)
      if (signedError) throw signedError
      await saveCoverPage(coverForm, path)
      setCoverPhotoPath(path)
      setCoverPhotoUrl(signed.signedUrl)
      setCoverMessage('Photo uploaded and saved.')
    } catch (error) {
      console.error('Upload Cover Page photo failed:', error)
      setCoverMessage(error?.message || 'Could not upload the photo.')
    } finally { setCoverUploading(false) }
  }

  // Content for "How to Use This Work Immersion Module".
  const [howToUseText, setHowToUseText] = useState(`This module serves as your guide throughout the Work Immersion experience. Read each section carefully and accomplish the activities and requirements assigned to you.

Keep your documents, reflections, photographs, reports, and other outputs organized inside your digital portfolio.

Update your portfolio regularly so that your progress can be monitored throughout your Work Immersion.`)
  const [howToUseDraft, setHowToUseDraft] = useState(howToUseText)
  const [howToUseEditing, setHowToUseEditing] = useState(false)
  const [howToUseImages, setHowToUseImages] = useState([])
  const [contentLoading, setContentLoading] = useState(true)
  const [contentSaving, setContentSaving] = useState(false)
  const [contentError, setContentError] = useState('')
  const [contentMessage, setContentMessage] = useState('')
  const HOW_TO_USE_SECTION = 'Module Introduction/How to Use This Work Immersion Module'

  const saveHowToUseContent = async (textValue, imageValue) => {
    if (!user?.id) {
      throw new Error('Your account could not be identified. Please log in again.')
    }

    const { error } = await savePortfolioEntry(
      supabase,
        {
          user_id: user.id,
          section: HOW_TO_USE_SECTION,
          content: JSON.stringify({
            text: textValue,
            images: imageValue.map(({ path, name }) => ({ path, name })),
          }),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,section' }
      )

    if (error) throw error
  }

  // Load the saved text and photo paths every time this module is opened.
  useEffect(() => {
    let cancelled = false

    const loadHowToUseContent = async () => {
      if (!user?.id) {
        setContentLoading(false)
        return
      }

      setContentLoading(true)
      setContentError('')
      setContentMessage('')

      try {
        const { data, error } = await loadPortfolioEntry(supabase, user.id, HOW_TO_USE_SECTION)

       if (error) throw error

console.log('HOW TO USE DATABASE DATA:', data)
console.log('HOW TO USE CONTENT:', data?.content)
console.log('CONTENT TYPE:', typeof data?.content)

if (!data?.content) return

        let saved
        try {
          saved = JSON.parse(data.content)
        } catch {
          // If this section had older plain text, keep it editable.
          saved = { text: data.content, images: [] }
        }

        if (cancelled) return
        if (typeof saved.text === 'string') {
          setHowToUseText(saved.text)
          setHowToUseDraft(saved.text)
        }
        const savedImages = Array.isArray(saved.images) ? saved.images : []
        if (!cancelled) setHowToUseImages(savedImages.filter((item) => item?.path))
      } catch (error) {
        console.error('Error loading How to Use content:', error)
        if (!cancelled) setContentError(error?.message || 'Could not load saved content.')
      } finally {
        if (!cancelled) setContentLoading(false)
      }
    }

    loadHowToUseContent()
    return () => { cancelled = true }
  }, [user?.id])

  const handleSaveHowToUseText = async () => {
    setContentSaving(true)
    setContentError('')
    setContentMessage('')

    try {
      await saveHowToUseContent(howToUseDraft, howToUseImages)
      setHowToUseText(howToUseDraft)
      setHowToUseEditing(false)
      setContentMessage('Information saved.')
    } catch (error) {
      console.error('Error saving How to Use text:', error)
      setContentError(error?.message || 'Could not save your text.')
    } finally {
      setContentSaving(false)
    }
  }

  const handleStudentPhotoUpload = async (e) => {
    console.log('PHOTO UPLOAD FUNCTION CALLED')

    const file = e.target.files?.[0]

    if (!file || !user?.id) {
      e.target.value = ''
      return
    }

    if (!file.type.startsWith('image/')) {
      setPhotoError('Please select an image file.')
      e.target.value = ''
      return
    }

    setPhotoLoading(true)
    setPhotoError('')

    try {
      const filePath = `${user.id}/student-2x2-photo`

      await savePortfolioPhoto(user.id, filePath, file)

      const { error: saveError } = await savePortfolioEntry(
        supabase,
          {
            user_id: user.id,
            section: 'Module Introduction/Student 2x2 Photo',
            content: filePath,
            updated_at: new Date().toISOString(),
          },
          {
            onConflict: 'user_id,section',
          }
        )

      if (saveError) throw saveError

      const { data: signedData, error: signedError } =
        await getPortfolioSignedUrl(user.id, filePath)

      if (signedError) throw signedError

      setImmersionPhoto(signedData.signedUrl)
    } catch (error) {
      console.error('Error uploading student photo:', error)
      setPhotoError(error?.message || 'Unable to upload student photo.')
    } finally {
      setPhotoLoading(false)
      e.target.value = ''
    }
  }

  useEffect(() => {
    const loadStudentPhoto = async () => {
      if (!user?.id) return

      setPhotoLoading(true)
      setPhotoError('')

      try {
        const { data, error } = await loadPortfolioEntry(supabase, user.id, 'Module Introduction/Student 2x2 Photo')

        if (error) throw error

        if (data?.content) {
          const { data: signedData, error: signedError } =
            await getPortfolioSignedUrl(user.id, data.content)

          if (signedError) throw signedError

          setImmersionPhoto(signedData.signedUrl)
        } else {
          setImmersionPhoto(null)
        }
      } catch (error) {
        console.error('Error loading student photo:', error)
        setPhotoError(error?.message || 'Unable to load student photo.')
      } finally {
        setPhotoLoading(false)
      }
    }

    loadStudentPhoto()
  }, [user?.id])

  return (
    <div className="dashboard-section">

      {/* BACK BUTTON */}
      <button
        type="button"
        className="back-btn"
        onClick={() => setActivePage('Home')}
      >
        ← Back to Home
      </button>

      {/* HEADER */}
      <p className="eyebrow">WORK IMMERSION / MODULE INTRODUCTION</p>

      <h1>Module Introduction</h1>

      <p>
        Explore the goals,
        responsibilities, and portfolio checklist for your Work Immersion.
      </p>

      {!openSection && (
        <div className="module-section-list" style={{ marginTop: 28 }}>
          {[
            { id: 'cover-page', title: 'Cover Page' },
            { id: 'objectives', title: 'Work Immersion Objectives' },
            { id: 'how-to-use', title: 'How to Use This Work Immersion Module' },
            { id: 'duties', title: "Students' Duties & Responsibilities" },
            { id: 'checklist', title: 'Portfolio Checklist' },
            { id: 'student-id', title: 'Student ID' },
          ].map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setOpenSection(item.id)}
              aria-label={`Open ${item.title}`}
              style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 24px', alignItems: 'center', gap: 12, width: '100%', padding: '22px 16px', border: 0, borderBottom: '1px solid #e5e7eb', background: 'transparent', color: 'inherit', textAlign: 'left', cursor: 'pointer', font: 'inherit' }}
            >
              <span>{item.title}</span><span aria-hidden="true">→</span>
            </button>
          ))}
        </div>
      )}

      {/* =========================
          COVER PAGE
      ========================= */}
{openSection === 'cover-page' && (
      <div>
        <button type="button" className="back-btn" onClick={() => setOpenSection(null)} style={{ margin: '12px 0 18px' }}>← Back to sections</button>
      <div className="module-card">
          <div className="module-section-content">
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
              {!coverEditing ? (
                <button type="button" className="primary-btn" onClick={() => { setCoverMessage(''); setCoverEditing(true) }}>Edit Cover Page</button>
              ) : (
                <>
                  <button type="button" className="back-btn" onClick={() => { setCoverForm({ track: user?.track || '', strand: user?.strand || '', specialization: user?.specialization || '', student_name: user?.full_name || '', school_name: user?.school || 'Western Cagayan School of Arts and Trades' }); setCoverEditing(false); setCoverMessage('Changes cancelled.') }}>Cancel</button>
                  <button type="button" className="primary-btn" onClick={handleSaveCoverPage} disabled={coverSaving}>{coverSaving ? 'Saving...' : 'Save Cover Page'}</button>
                </>
              )}
            </div>
            <div style={{ maxWidth: 760, margin: '0 auto', padding: '28px 22px', border: '1px solid #e5e7eb', borderRadius: 12, background: '#fff', color: '#111', textAlign: 'center' }}>
              <label style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 8, cursor: coverUploading ? 'wait' : 'pointer', marginBottom: 22 }}>
                {coverPhotoUrl ? <img src={coverPhotoUrl} alt="School logo" style={{ width: 130, height: 130, objectFit: 'contain', border: '1px solid #e5e7eb', borderRadius: 8 }} /> : <span style={{ width: 130, height: 130, border: '1px dashed #aaa', borderRadius: 8, display: 'grid', placeItems: 'center', color: '#555' }}>School Logo / Photo</span>}
                <span style={{ fontSize: 13, color: '#555' }}>{coverUploading ? 'Uploading...' : 'Click to upload or change photo'}</span>
                <input type="file" accept="image/png,image/jpeg,image/webp" hidden disabled={coverUploading} onChange={handleCoverPhotoUpload} />
              </label>
              <h2 style={{ fontSize: 25, margin: '0 0 8px' }}>WORK IMMERSION PORTFOLIO</h2>
              <p style={{ color: '#666', margin: '0 0 28px' }}>Senior High School · Grade 12</p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 18, textAlign: 'left' }}>
                {[
                  { key: 'track', label: 'TRACK' },
                  { key: 'strand', label: 'STRAND' },
                  { key: 'specialization', label: 'SPECIALIZATION' },
                  { key: 'student_name', label: 'STUDENT NAME' },
                  { key: 'school_name', label: 'SCHOOL NAME' },
                ].map((field) => (
                  <div key={field.key} style={{ minWidth: 0, borderBottom: '1px solid #ddd', paddingBottom: 10 }}>
                    <label style={{ display: 'block', fontSize: 12, color: '#666', marginBottom: 6 }}>{field.label}</label>
                    {coverEditing ? (
                      <input value={coverForm[field.key] || ''} onChange={(event) => setCoverForm((current) => ({ ...current, [field.key]: event.target.value }))} placeholder={`Enter ${field.label.toLowerCase()}`} style={{ width: '100%', boxSizing: 'border-box', padding: '7px 0', border: 0, borderBottom: '1px solid #999', font: 'inherit', color: '#111', background: '#fff' }} />
                    ) : (
                      <div style={{ minHeight: 22, overflowWrap: 'anywhere' }}>{coverForm[field.key] || '—'}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
            {coverMessage && <p role="status" style={{ marginTop: 12, color: '#555' }}>{coverMessage}</p>}
          </div>
      </div>

      </div>
    )}

      {/* =========================
          WORK IMMERSION OBJECTIVES
      ========================= */}
{openSection === 'objectives' && (
      <div>
        <button type="button" className="back-btn" onClick={() => setOpenSection(null)} style={{ margin: '12px 0 18px' }}>← Back to sections</button>
      <div className="module-card">
          <div className="module-section-content">

            <p>
              One of the goals of the K to 12 Basic Education Program is for
              learners to develop the competencies, work ethics, and values
              relevant to further education and joining the world of work.
            </p>

            <p>
              Work Immersion provides opportunities to become familiar with
              the workplace, experience employment simulation, and apply
              Computer Systems Servicing competencies in an authentic work
              environment.
            </p>

            <p>
              Work Immersion is a graduation requirement. Learners complete
              school-based simulation and home-based activities, then submit
              and present a portfolio.
            </p>

            <ul>
              <li>Become familiar with the workplace.</li>
              <li>Experience employment simulation.</li>
              <li>Apply competencies in an authentic work environment.</li>
            </ul>

          </div>

      </div>

      </div>
    )}


      {/* =========================
          HOW TO USE THIS WORK IMMERSION MODULE
      ========================= */}
{openSection === 'how-to-use' && (
  
      <div>
        <button type="button" className="back-btn" onClick={() => setOpenSection(null)} style={{ margin: '12px 0 18px' }}>← Back to sections</button>
      <div className="module-card">

        <h2>HOW TO USE THIS WORK IMMERSION MODULE</h2>

        {contentLoading ? (
          <p>Loading your saved content...</p>
        ) : (
          <>
            {howToUseEditing ? (
              <textarea
                id="how-to-use-text"
                value={howToUseDraft}
                onChange={(event) => {
                  setHowToUseDraft(event.target.value)
                  setContentMessage('')
                  setContentError('')
                }}
                rows={8}
                style={{
                  display: 'block',
                  width: '100%',
                  boxSizing: 'border-box',
                  minHeight: 180,
                  padding: 12,
                  border: '1px solid #d1d5db',
                  borderRadius: 10,
                  font: 'inherit',
                  lineHeight: 1.6,
                  resize: 'vertical',
                  background: 'var(--input-bg, #fff)',
                  color: 'inherit',
                }}
                disabled={contentSaving}
              />
            ) : (
              <p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                {howToUseText}
              </p>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
              {howToUseEditing ? (
                <button
                  type="button"
                  className="primary-btn"
                  onClick={handleSaveHowToUseText}
                  disabled={contentSaving}
                >
                  {contentSaving ? 'Saving...' : 'Save'}
                </button>
              ) : (
                <button
                  type="button"
                  className="primary-btn"
                  onClick={() => {
                    setHowToUseDraft(howToUseText)
                    setContentMessage('')
                    setContentError('')
                    setHowToUseEditing(true)
                  }}
                >
                  Edit
                </button>
              )}
            </div>

            {contentError && (
              <p role="alert" style={{ color: '#b91c1c', marginTop: 10 }}>
                {contentError}
              </p>
            )}

            {contentMessage && (
              <p role="status" style={{ color: '#166534', marginTop: 10 }}>
                {contentMessage}
              </p>
            )}
          </>
        )}

      </div>

      </div>
    )}

      {openSection === 'duties' && (
        <div>
          <button
            type="button"
            className="back-btn"
            onClick={() => setOpenSection(null)}
            style={{ margin: '12px 0 18px' }}
          >
            ← Back to sections
          </button>
          <StudentDutiesContent user={user} />
        </div>
      )}

      {/* =========================
          WORK IMMERSION PORTFOLIO CHECKLIST
      ========================= */}
{openSection === 'checklist' && (
      <div>
        <button type="button" className="back-btn" onClick={() => setOpenSection(null)} style={{ margin: '12px 0 18px' }}>← Back to sections</button>
        <PortfolioChecklistPage user={user} />
      </div>
    )}

      {/* =========================
          STUDENT ID
      ========================= */}
{openSection === 'student-id' && (
      <div>
        <button type="button" className="back-btn" onClick={() => setOpenSection(null)} style={{ margin: '12px 0 18px' }}>← Back to sections</button>
        <StudentIdPage user={user} />
      </div>
    )}

    </div>
  )
}

/* =========================
   PRE-IMMERSION
========================= */

function PreImmersion({ setActivePage }) {
  return (
    <div className="dashboard-section">

      <button
        type="button"
        className="back-btn"
        onClick={() => setActivePage('Home')}
      >
        ← Back to Home
      </button>

      <p className="eyebrow">
        WORK IMMERSION / PRE-IMMERSION
      </p>

      <h1>
        Pre-Immersion
      </h1>

      <p>
        Complete the required activities and documents
        before starting your Work Immersion.
      </p>

      <div className="module-card">

        <h2>
          PRE-IMMERSION REQUIREMENTS
        </h2>

        <div className="pre-immersion-list">

          <div>
            <span>01</span>
            <strong>Enrolment Form</strong>
          </div>

          <div>
            <span>02</span>
            <strong>Essay on How to Conduct Oneself</strong>
          </div>

          <div>
            <span>03</span>
            <strong>Application Letter Addressed to the Principal</strong>
          </div>

          <div>
            <span>04</span>
            <strong>Résumé</strong>
          </div>

          <div>
            <span>05</span>
            <strong>Flow Chart of Securing Clearance Documents</strong>
          </div>

          <div>
            <span>06</span>
            <strong>Barangay Clearance</strong>
          </div>

          <div>
            <span>07</span>
            <strong>Police Clearance</strong>
          </div>

          <div>
            <span>08</span>
            <strong>Mayor's Clearance</strong>
          </div>

          <div>
            <span>09</span>
            <strong>Health Certificate</strong>
          </div>

          <div>
            <span>10</span>
            <strong>Immersion List of Tasks</strong>
          </div>

          <div>
            <span>11</span>
            <strong>Duly Signed Parents' Consent</strong>
          </div>

        </div>

      </div>

    </div>
  )
}



/* =========================
   POST-IMMERSION
========================= */
/* =========================
   IMMERSION PROPER
========================= */

function ImmersionProper({ setActivePage }) {
  return (
    <div className="dashboard-section">

      <button
        type="button"
        className="back-btn"
        onClick={() => setActivePage('Home')}
      >
        ← Back to Home
      </button>

      <p className="eyebrow">
        WORK IMMERSION / IMMERSION PROPER
      </p>

      <h1>Immersion Proper</h1>

      <p>
        Document your experiences and activities
        during your Work Immersion.
      </p>

      <div className="module-card">

        <h2>IMMERSION PROPER REQUIREMENTS</h2>

        <div className="pre-immersion-list">
          <div><span>01</span><strong>Agency Organizational Chart</strong></div>
          <div><span>02</span><strong>Work Process Flow Charts</strong></div>
          <div><span>03</span><strong>Work Immersion Map (Google Maps)</strong></div>
          <div><span>04</span><strong>Pictures of Work with Captions</strong></div>
          <div><span>05</span><strong>Narrative Report</strong></div>
          <div><span>06</span><strong>Daily Journal</strong></div>
          <div><span>07</span><strong>Task Rating / Evaluation</strong></div>
          <div><span>08</span><strong>Daily Time Record (DTR)</strong></div>
          <div><span>09</span><strong>Essay about the Work/Task</strong></div>
        </div>

      </div>

    </div>
  )
}

function NarrativeReportPage({ user, onBack }) {
  const [answers, setAnswers] = useState({
    title: '',
    report: '',
    preparedBy: '',
    natureOfBusiness: '',
    descriptionOfServices: '',
    targetClientele: '',
    companyRules: '',
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const section = 'Immersion Proper/Narrative Report'

  useEffect(() => {
    let cancelled = false

    const loadReport = async () => {
      if (!user?.id) {
        setLoading(false)
        setErrorMessage('Your account could not be identified. Please log in again.')
        return
      }

      setLoading(true)
      setErrorMessage('')
      setAnswers({
        title: '',
        report: '',
        preparedBy: '',
        natureOfBusiness: '',
        descriptionOfServices: '',
        targetClientele: '',
        companyRules: '',
      })

      const cached = await getPortfolioCache(user.id, section)
      if (cached?.data && !cancelled) {
        const content = typeof cached.data === 'string'
          ? JSON.parse(cached.data)
          : cached.data
        setAnswers({
          title: typeof content.title === 'string' ? content.title : '',
          report: typeof content.report === 'string' ? content.report : '',
          preparedBy: typeof content.preparedBy === 'string' ? content.preparedBy : '',
          natureOfBusiness: typeof content.natureOfBusiness === 'string' ? content.natureOfBusiness : '',
          descriptionOfServices: typeof content.descriptionOfServices === 'string' ? content.descriptionOfServices : '',
          targetClientele: typeof content.targetClientele === 'string' ? content.targetClientele : '',
          companyRules: typeof content.companyRules === 'string' ? content.companyRules : '',
        })
      }

      try {
        const { data, error } = await loadPortfolioEntry(supabase, user.id, section)
        if (error) throw error

        let content = data?.content
        if (typeof content === 'string') content = JSON.parse(content)
        if (content !== undefined && content !== null) {
          if (typeof content !== 'object' || Array.isArray(content)) {
            throw new Error('Saved narrative report data has an invalid format.')
          }
          if (!cancelled) {
            setAnswers({
              title: typeof content.title === 'string' ? content.title : '',
              report: typeof content.report === 'string' ? content.report : '',
              preparedBy: typeof content.preparedBy === 'string' ? content.preparedBy : '',
              natureOfBusiness: typeof content.natureOfBusiness === 'string' ? content.natureOfBusiness : '',
              descriptionOfServices: typeof content.descriptionOfServices === 'string' ? content.descriptionOfServices : '',
              targetClientele: typeof content.targetClientele === 'string' ? content.targetClientele : '',
              companyRules: typeof content.companyRules === 'string' ? content.companyRules : '',
            })
            await savePortfolioCache(user.id, section, content)
          }
        }
      } catch (error) {
        console.error('Load Narrative Report failed:', error)
        if (!cancelled) {
          if (!navigator.onLine) {
            setStatusMessage('Loaded your saved copy from this phone.')
          } else {
            setErrorMessage(error?.message || 'Could not load the saved narrative report.')
          }
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadReport()
    return () => { cancelled = true }
  }, [user?.id])

  const updateAnswer = (field, value) => {
    setAnswers((current) => ({ ...current, [field]: value }))
    setErrorMessage('')
    setStatusMessage('')
  }

  const handleSave = async () => {
    if (!user?.id) {
      setErrorMessage('Your account could not be identified. Please log in again.')
      return
    }

    setSaving(true)
    setErrorMessage('')
    setStatusMessage('')

    try {
      const updatedAt = new Date().toISOString()
      const { error } = await savePortfolioEntry(supabase, {
        user_id: user.id,
        section,
        content: answers,
        updated_at: updatedAt,
      }, { onConflict: 'user_id,section' })
      if (error) throw error
      setStatusMessage('Narrative report saved. Your writing will remain when you reopen this page.')
    } catch (error) {
      console.error('Save Narrative Report failed:', error)
      setErrorMessage(error?.message || 'Could not save the narrative report.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="dashboard-section workplace-essay-page narrative-report-page">
      <button
        type="button"
        className="portfolio-back-button"
        onClick={onBack}
      >
        ← Back to Immersion Proper
      </button>

      <article className="workplace-essay-document">
        <h1>NARRATIVE REPORT</h1>
        <p className="workplace-essay-instructions">
          Write a report on your learning experiences during your work immersion. Create your own title, use the format on the box and guide questions below to complete your essay.
        </p>

        <div className="workplace-essay-questions">
          <p>Paragraph 1: Evaluate your overall performance during your work immersion? State whether you were satisfied or not satisfied on your performance. Provide reason for your evaluation.</p>
          <p>Paragraph 2: Describe the task/activities you performed during your work immersion.</p>
          <p>Paragraph 3: Did you ask your immersion teacher acting as supervisor to evaluate your performance? What did you learn from his/her evaluation?</p>
          <p>Paragraph 4: How would you describe the school-based work immersion simulation and the home-based work immersion?</p>
        </div>

        <hr className="narrative-report-separator" />

        <label className="workplace-essay-title-field narrative-report-title-field">
          <span>Title</span>
          <input
            type="text"
            value={answers.title}
            disabled={loading || saving || !user?.id}
            onChange={(event) => updateAnswer('title', event.target.value)}
            aria-label="Narrative report title"
          />
        </label>

        <label className="workplace-essay-body-field narrative-report-body-field">
          <span>Narrative Report</span>
          <textarea
            value={answers.report}
            disabled={loading || saving || !user?.id}
            onChange={(event) => updateAnswer('report', event.target.value)}
            aria-label="Narrative report"
            rows={18}
          />
        </label>

        <div className="workplace-essay-prepared-by">
          <strong>Prepared by:</strong>
          <input
            className="narrative-report-signature-line"
            type="text"
            value={answers.preparedBy}
            disabled={loading || saving || !user?.id}
            onChange={(event) => updateAnswer('preparedBy', event.target.value)}
            aria-label="Student’s Name and Signature"
          />
          <span>Student’s Name and Signature</span>
        </div>
      </article>

      <article className="workplace-essay-document narrative-report-profile-page">
        <h2>Western Cagayan School of Arts and Trades</h2>
        <h1>Work Immersion Simulation Profile</h1>
        <p className="workplace-essay-instructions">
          Discuss the profile of the WCSAT School-Based Work Immersion. You may attach charts, photos, or illustrations on the next page.
        </p>

        <label className="narrative-profile-field">
          <span>Nature of Business:</span>
          <textarea
            value={answers.natureOfBusiness}
            disabled={loading || saving || !user?.id}
            onChange={(event) => updateAnswer('natureOfBusiness', event.target.value)}
            aria-label="Nature of Business"
            rows={4}
          />
        </label>

        <label className="narrative-profile-field">
          <span>Description of Services:</span>
          <textarea
            value={answers.descriptionOfServices}
            disabled={loading || saving || !user?.id}
            onChange={(event) => updateAnswer('descriptionOfServices', event.target.value)}
            aria-label="Description of Services"
            rows={4}
          />
        </label>

        <label className="narrative-profile-field">
          <span>Target Clientele:</span>
          <textarea
            value={answers.targetClientele}
            disabled={loading || saving || !user?.id}
            onChange={(event) => updateAnswer('targetClientele', event.target.value)}
            aria-label="Target Clientele"
            rows={4}
          />
        </label>

        <label className="narrative-profile-field">
          <span>Company Rules and Regulations:</span>
          <textarea
            value={answers.companyRules}
            disabled={loading || saving || !user?.id}
            onChange={(event) => updateAnswer('companyRules', event.target.value)}
            aria-label="Company Rules and Regulations"
            rows={4}
          />
        </label>
      </article>

      {loading && <p role="status">Loading saved narrative report...</p>}
      {errorMessage && <p role="alert" className="workplace-essay-message error">{errorMessage}</p>}
      {statusMessage && !saving && <p role="status" className="workplace-essay-message">{statusMessage}</p>}
      <button
        type="button"
        className="workplace-essay-save"
        onClick={handleSave}
        disabled={loading || saving || !user?.id}
      >
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  )
}

function WrittenReportPage({ user, onBack }) {
  const [answers, setAnswers] = useState({ title: '', report: '', preparedBy: '' })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const section = 'Post-Immersion/Written Report'

  useEffect(() => {
    let cancelled = false

    const loadReport = async () => {
      if (!user?.id) {
        setLoading(false)
        setErrorMessage('Your account could not be identified. Please log in again.')
        return
      }

      setLoading(true)
      setErrorMessage('')
      setAnswers({ title: '', report: '', preparedBy: '' })

      const cached = await getPortfolioCache(user.id, section)
      if (cached?.data && !cancelled) {
        const content = typeof cached.data === 'string'
          ? JSON.parse(cached.data)
          : cached.data
        setAnswers({
          title: typeof content.title === 'string' ? content.title : '',
          report: typeof content.report === 'string' ? content.report : '',
          preparedBy: typeof content.preparedBy === 'string' ? content.preparedBy : '',
        })
      }

      try {
        const { data, error } = await loadPortfolioEntry(supabase, user.id, section)
        if (error) throw error

        let content = data?.content
        if (typeof content === 'string') content = JSON.parse(content)
        if (content !== undefined && content !== null) {
          if (typeof content !== 'object' || Array.isArray(content)) {
            throw new Error('Saved written report data has an invalid format.')
          }
          if (!cancelled) {
            setAnswers({
              title: typeof content.title === 'string' ? content.title : '',
              report: typeof content.report === 'string' ? content.report : '',
              preparedBy: typeof content.preparedBy === 'string' ? content.preparedBy : '',
            })
            await savePortfolioCache(user.id, section, content)
          }
        }
      } catch (error) {
        console.error('Load Written Report failed:', error)
        if (!cancelled) {
          if (!navigator.onLine) {
            setStatusMessage('Loaded your saved copy from this phone.')
          } else {
            setErrorMessage(error?.message || 'Could not load the saved written report.')
          }
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadReport()
    return () => { cancelled = true }
  }, [user?.id])

  const updateAnswer = (field, value) => {
    setAnswers((current) => ({ ...current, [field]: value }))
    setErrorMessage('')
    setStatusMessage('')
  }

  const handleSave = async () => {
    if (!user?.id) {
      setErrorMessage('Your account could not be identified. Please log in again.')
      return
    }

    setSaving(true)
    setErrorMessage('')
    setStatusMessage('')

    try {
      const updatedAt = new Date().toISOString()
      const { error } = await savePortfolioEntry(supabase, {
        user_id: user.id,
        section,
        content: answers,
        updated_at: updatedAt,
      }, { onConflict: 'user_id,section' })
      if (error) throw error
      setStatusMessage('Written report saved.')
    } catch (error) {
      console.error('Save Written Report failed:', error)
      setErrorMessage(error?.message || 'Could not save the written report.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="dashboard-section workplace-essay-page written-report-page">
      <button
        type="button"
        className="portfolio-back-button"
        onClick={onBack}
      >
        ← Back to Post-Immersion
      </button>

      <article className="workplace-essay-document written-report-document">
        <h1>WRITTEN REPORTS</h1>
        <p className="workplace-essay-instructions">
          Write a report on your learning experiences during your work immersion. Create your own title, use the format on the box and guide questions below to complete your essay.
        </p>

        <div className="workplace-essay-questions">
          <p>Paragraph 1: List the forms that you were asked to accomplished before, during and after your work immersion. How does it help you?</p>
          <p>Paragraph 2: Narrate/account your leanings and achievements, issued faced and corresponding resolution for week 1 of your work immersion.</p>
          <p>Paragraph 3: Narrate/account your leanings and achievements, issued faced and corresponding resolution for week 2 of your work immersion.</p>
          <p>Paragraph 4: Is there any non-written outputs and/or projects that were assigned to you during your work immersion? If yes, give a short description of the accomplished output/project.</p>
          <p>Paragraph 5: What were the highlights of your work immersion?</p>
        </div>

        <hr className="narrative-report-separator" />

        <label className="workplace-essay-title-field narrative-report-title-field">
          <span>Title</span>
          <input
            type="text"
            value={answers.title}
            disabled={loading || saving || !user?.id}
            onChange={(event) => updateAnswer('title', event.target.value)}
            aria-label="Written report title"
          />
        </label>

        <div className="workplace-essay-body-field narrative-report-body-field">
          <span>Written Report</span>
          <textarea
            value={answers.report}
            disabled={loading || saving || !user?.id}
            onChange={(event) => updateAnswer('report', event.target.value)}
            aria-label="Written report"
            rows={18}
          />
        </div>

        <div className="workplace-essay-prepared-by">
          <strong>Prepared by:</strong>
          <input
            className="narrative-report-signature-line"
            type="text"
            value={answers.preparedBy}
            disabled={loading || saving || !user?.id}
            onChange={(event) => updateAnswer('preparedBy', event.target.value)}
            aria-label="Student’s Name and Signature"
          />
          <span>Student’s Name and Signature</span>
        </div>
      </article>

      {loading && <p role="status">Loading saved written report...</p>}
      {errorMessage && <p role="alert" className="workplace-essay-message error">{errorMessage}</p>}
      {statusMessage && !saving && <p role="status" className="workplace-essay-message">{statusMessage}</p>}
      <button
        type="button"
        className="workplace-essay-save"
        onClick={handleSave}
        disabled={loading || saving || !user?.id}
      >
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  )
}

function PostImmersionFormsPage({
  user,
  onBack,
  section = 'Post-Immersion/Forms',
  pageName = 'Forms',
  documentTitle = 'PICTURES OF ACCOMPLISHED FORMS',
  instruction = 'Provide photo of the accomplished form during the work immersion and provide caption below it.',
  uploadText = 'Upload the Collage photo of your work.',
  showCaption = true,
}) {
  const [caption, setCaption] = useState('')
  const [savedPhoto, setSavedPhoto] = useState(null)
  const [selectedPhoto, setSelectedPhoto] = useState(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const previewUrlRef = useRef('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [statusMessage, setStatusMessage] = useState('')

  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
  }, [])

  useEffect(() => {
    let cancelled = false

    const loadFormPhoto = async () => {
      if (!user?.id) {
        setLoading(false)
        setErrorMessage('Your account could not be identified. Please log in again.')
        return
      }

      try {
        const { data, error } = await loadPortfolioEntry(supabase, user.id, section)
        if (error) throw error

        let content = data?.content
        if (typeof content === 'string') content = JSON.parse(content)
        if (content !== undefined && content !== null) {
          if (typeof content !== 'object' || Array.isArray(content)) {
            throw new Error(`Saved ${pageName} data has an invalid format.`)
          }

          if (!cancelled && typeof content.caption === 'string') {
            setCaption(content.caption)
          }
          if (content.photo_path) {
            const { data: signed, error: signedError } = await getPortfolioSignedUrl(user.id, content.photo_path)
            if (signedError) throw signedError
            if (!cancelled) {
              setSavedPhoto({ path: content.photo_path, url: signed.signedUrl })
            }
          }
        }
      } catch (error) {
        console.error(`Load Post-Immersion ${pageName} failed:`, error)
        if (!cancelled) {
          setErrorMessage(error?.message || `Could not load the saved ${pageName} page.`)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadFormPhoto()
    return () => { cancelled = true }
  }, [user?.id, pageName, section])

  const handlePhotoSelect = (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setErrorMessage('Please choose an image file.')
      return
    }

    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    const nextPreviewUrl = URL.createObjectURL(file)
    previewUrlRef.current = nextPreviewUrl
    setPreviewUrl(nextPreviewUrl)
    setSelectedPhoto(file)
    setErrorMessage('')
    setStatusMessage('')
  }

  const handleSave = async () => {
    if (!user?.id) {
      setErrorMessage('Your account could not be identified. Please log in again.')
      return
    }

    setSaving(true)
    setErrorMessage('')
    setStatusMessage('')
    let uploadedPath = ''

    try {
      let photoPath = savedPhoto?.path || null
      let photoUrl = savedPhoto?.url || ''
      if (selectedPhoto) {
        const safeName = selectedPhoto.name.replace(/[^a-zA-Z0-9._-]/g, '_')
        uploadedPath = `${user.id}/post-immersion-${pageName.toLowerCase()}/${Date.now()}-${safeName}`
        await savePortfolioPhoto(user.id, uploadedPath, selectedPhoto)

        const { data: signed, error: signedError } = await getPortfolioSignedUrl(user.id, uploadedPath)
        if (signedError) throw signedError
        photoPath = uploadedPath
        photoUrl = signed.signedUrl
      }

      const { error } = await savePortfolioEntry(supabase, {
        user_id: user.id,
        section,
        content: { caption, photo_path: photoPath },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,section' })
      if (error) throw error

      if (uploadedPath) {
        setSavedPhoto({ path: uploadedPath, url: photoUrl })
        setSelectedPhoto(null)
        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
        previewUrlRef.current = ''
        setPreviewUrl('')
      }
      setStatusMessage(`${pageName} page saved.`)
    } catch (error) {
      console.error(`Save Post-Immersion ${pageName} failed:`, error)
      if (uploadedPath) {
        const { error: cleanupError } = await supabase.storage
          .from('portfolio-files')
          .remove([uploadedPath])
        if (cleanupError) {
          console.error(`Could not remove the unsaved ${pageName} photo:`, cleanupError)
        }
      }
      setErrorMessage(error?.message || `Could not save the ${pageName} page.`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="dashboard-section workplace-essay-page post-immersion-forms-page">
      <button type="button" className="portfolio-back-button" onClick={onBack}>
        ← Back to Post-Immersion
      </button>

      <article className="workplace-essay-document post-immersion-forms-document">
        <h1>{documentTitle}</h1>
        <p className="workplace-essay-instructions">{instruction}</p>

        <label className="post-immersion-forms-upload">
          {previewUrl || savedPhoto?.url ? (
            <img
              src={previewUrl || savedPhoto.url}
              alt={`Uploaded photo for ${pageName}`}
            />
          ) : (
            <span>{uploadText}</span>
          )}
          <input
            type="file"
            accept="image/*"
            hidden
            disabled={loading || saving || !user?.id}
            onChange={handlePhotoSelect}
          />
        </label>

        {showCaption && (
          <label className="post-immersion-forms-caption">
            <span>Caption</span>
            <textarea
              value={caption}
              disabled={loading || saving || !user?.id}
              onChange={(event) => {
                setCaption(event.target.value)
                setErrorMessage('')
                setStatusMessage('')
              }}
              aria-label="Photo caption"
              rows={5}
            />
          </label>
        )}
      </article>

      {loading && <p role="status">{`Loading saved ${pageName} page...`}</p>}
      {errorMessage && <p role="alert" className="workplace-essay-message error">{errorMessage}</p>}
      {statusMessage && !saving && <p role="status" className="workplace-essay-message">{statusMessage}</p>}
      <button
        type="button"
        className="workplace-essay-save"
        onClick={handleSave}
        disabled={loading || saving || !user?.id}
      >
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  )
}

const POST_IMMERSION_GALLERY_WEEKS = [
  1, 2, 3, 4, 5, 6, 7, 8,
]

const createPostImmersionGalleryItems = () => POST_IMMERSION_GALLERY_WEEKS.map((week) => ({
  week,
  caption: '',
  path: '',
  url: '',
  file: null,
  previewUrl: '',
}))

function PostImmersionGalleryPage({ user, onBack }) {
  const [items, setItems] = useState(createPostImmersionGalleryItems)
  const previewUrls = useRef(new Set())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const section = 'Post-Immersion/Gallery'

  useEffect(() => () => {
    previewUrls.current.forEach((url) => URL.revokeObjectURL(url))
    previewUrls.current.clear()
  }, [])

  useEffect(() => {
    let cancelled = false

    const loadGallery = async () => {
      if (!user?.id) {
        setLoading(false)
        setErrorMessage('Your account could not be identified. Please log in again.')
        return
      }

      try {
        const { data, error } = await loadPortfolioEntry(supabase, user.id, section)
        if (error) throw error

        let content = data?.content
        if (typeof content === 'string') content = JSON.parse(content)
        if (content !== undefined && content !== null) {
          if (typeof content !== 'object' || Array.isArray(content)) {
            throw new Error('Saved Gallery data has an invalid format.')
          }

          const savedItems = Array.isArray(content.items) ? content.items : []
          const restoredItems = await Promise.all(
            POST_IMMERSION_GALLERY_WEEKS.map(async (week) => {
              const savedItem = savedItems.find((entry) => entry?.week === week)
              const path = typeof savedItem?.path === 'string' ? savedItem.path : ''
              let url = ''
              if (path) {
                const { data: signed, error: signedError } = await getPortfolioSignedUrl(user.id, path)
                if (signedError) throw signedError
                url = signed.signedUrl
              }
              return {
                week,
                caption: typeof savedItem?.caption === 'string' ? savedItem.caption : '',
                path,
                url,
                file: null,
                previewUrl: '',
              }
            })
          )
          if (!cancelled) setItems(restoredItems)
        }
      } catch (error) {
        console.error('Load Post-Immersion Gallery failed:', error)
        if (!cancelled) {
          setErrorMessage(error?.message || 'Could not load the saved Gallery.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadGallery()
    return () => { cancelled = true }
  }, [user?.id])

  const updateItem = (index, updates) => {
    setItems((current) => current.map((item, itemIndex) => (
      itemIndex === index ? { ...item, ...updates } : item
    )))
    setErrorMessage('')
    setStatusMessage('')
  }

  const handlePhotoSelect = (index, event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setErrorMessage('Please choose an image file.')
      return
    }

    const previousUrl = items[index]?.previewUrl
    if (previousUrl) {
      URL.revokeObjectURL(previousUrl)
      previewUrls.current.delete(previousUrl)
    }
    const previewUrl = URL.createObjectURL(file)
    previewUrls.current.add(previewUrl)
    updateItem(index, { file, previewUrl })
  }

  const handleSave = async () => {
    if (!user?.id) {
      setErrorMessage('Your account could not be identified. Please log in again.')
      return
    }

    setSaving(true)
    setErrorMessage('')
    setStatusMessage('')
    const uploadedPaths = []

    try {
      const savedItems = []
      for (const [index, item] of items.entries()) {
        let path = item.path
        let url = item.url
        if (item.file) {
          const safeName = item.file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
          path = `${user.id}/post-immersion-gallery/${Date.now()}-${index}-${safeName}`
          await savePortfolioPhoto(user.id, path, item.file)
          uploadedPaths.push(path)

          const { data: signed, error: signedError } = await getPortfolioSignedUrl(user.id, path)
          if (signedError) throw signedError
          url = signed.signedUrl
        }
        savedItems.push({ week: item.week, caption: item.caption, path, url })
      }

      const { error } = await savePortfolioEntry(supabase, {
        user_id: user.id,
        section,
        content: { items: savedItems.map(({ url: _url, ...item }) => item) },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,section' })
      if (error) throw error

      items.forEach((item) => {
        if (item.previewUrl) {
          URL.revokeObjectURL(item.previewUrl)
          previewUrls.current.delete(item.previewUrl)
        }
      })
      setItems(savedItems.map((item) => ({
        ...item,
        file: null,
        previewUrl: '',
      })))
      setStatusMessage('Gallery saved.')
    } catch (error) {
      console.error('Save Post-Immersion Gallery failed:', error)
      if (uploadedPaths.length) {
        const { error: cleanupError } = await supabase.storage
          .from('portfolio-files')
          .remove(uploadedPaths)
        if (cleanupError) {
          console.error('Could not remove unsaved Gallery photos:', cleanupError)
        }
      }
      setErrorMessage(error?.message || 'Could not save the Gallery.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="dashboard-section workplace-essay-page post-immersion-gallery-page">
      <button type="button" className="portfolio-back-button" onClick={onBack}>
        ← Back to Post-Immersion
      </button>

      <article className="workplace-essay-document post-immersion-gallery-document">
        <h1>GALLERY</h1>
        <p className="workplace-essay-instructions">
          Pictures of work site and nonwritten output/ projects with captions
        </p>

        <div className="post-immersion-gallery-grid">
          {items.map((item, index) => (
            <section className="post-immersion-gallery-item" key={`week-${item.week}-${index}`}>
              <label className="post-immersion-gallery-upload">
                {item.previewUrl || item.url ? (
                  <img
                    src={item.previewUrl || item.url}
                    alt={`Work Immersion photo for Week ${item.week}`}
                  />
                ) : (
                  <span>Upload week {item.week}</span>
                )}
                <input
                  type="file"
                  accept="image/*"
                  hidden
                  disabled={loading || saving || !user?.id}
                  onChange={(event) => handlePhotoSelect(index, event)}
                />
              </label>
              <label className="post-immersion-gallery-caption">
                <span>Week {item.week}</span>
                <textarea
                  value={item.caption}
                  disabled={loading || saving || !user?.id}
                  onChange={(event) => updateItem(index, { caption: event.target.value })}
                  aria-label={`Caption for Week ${item.week} photo ${index + 1}`}
                  rows={3}
                />
              </label>
            </section>
          ))}
        </div>
      </article>

      {loading && <p role="status">Loading saved Gallery...</p>}
      {errorMessage && <p role="alert" className="workplace-essay-message error">{errorMessage}</p>}
      {statusMessage && !saving && <p role="status" className="workplace-essay-message">{statusMessage}</p>}
      <button
        type="button"
        className="workplace-essay-save"
        onClick={handleSave}
        disabled={loading || saving || !user?.id}
      >
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  )
}

const POST_IMMERSION_EVALUATION_AREAS = [
  { key: 'knowledge', label: 'Knowledge' },
  { key: 'skills', label: 'Skills' },
  { key: 'attitude', label: 'Attitude' },
]

const POST_IMMERSION_EVALUATION_PARTS = [
  { key: 'school', label: 'School' },
  { key: 'shared', label: 'Shared' },
  { key: 'work', label: 'Work' },
]

const POST_IMMERSION_SELF_REFLECTION_FIELDS = [
  'studentName',
  'trackStrand',
  'specialization',
  'trainingCompany',
  'companyAddress',
  'telephoneNumber',
  'contactPerson',
  'contactNumber',
  'inclusiveDateFrom',
  'inclusiveDateTo',
  'inclusiveDateYear',
  'workAssignment',
  'department',
  'position',
  'otherDepartment',
  'raterSupervisor',
  'evaluationDate',
  'dutiesBriefly',
  'strongestPerformance',
  'areasImproved',
  'needsImprovement',
  'challengingSituation',
  'overcomeChallenge',
  'learnedExperiences',
  'trainingStationPandemic',
  'suggestions',
  'studentSignature',
  'studentDate',
  'acquiredTrainingHours',
  'dateOfCompletion',
  'totalPerformanceRating',
  'remarks',
  'teacherSignature',
  'teacherDate',
]

const createEmptyPostImmersionEvaluation = (isSelfReflection = false) => (
  isSelfReflection
    ? Object.fromEntries(POST_IMMERSION_SELF_REFLECTION_FIELDS.map((field) => [field, '']))
    : Object.fromEntries(
      POST_IMMERSION_EVALUATION_AREAS.flatMap(({ key }) => (
        POST_IMMERSION_EVALUATION_PARTS.map(({ key: partKey }) => [`${key}_${partKey}`, ''])
      ))
    )
)

function PostImmersionEvaluationPage({
  user,
  onBack,
  section = 'Post-Immersion/Evaluation',
  pageName = 'Evaluation',
}) {
  const isSelfReflection = pageName === 'Self Evaluation and Reflection'
  const createEmptyAnswers = () => createEmptyPostImmersionEvaluation(isSelfReflection)
  const [answers, setAnswers] = useState(createEmptyAnswers)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  useEffect(() => {
    let cancelled = false

    const loadEvaluation = async () => {
      if (!user?.id) {
        setLoading(false)
        setErrorMessage('Your account could not be identified. Please log in again.')
        return
      }

      setLoading(true)
      setErrorMessage('')
      setAnswers(createEmptyAnswers())

      try {
        const { data, error } = await loadPortfolioEntry(supabase, user.id, section)
        if (error) throw error

        let content = data?.content
        if (typeof content === 'string') content = JSON.parse(content)
        if (content !== undefined && content !== null) {
          if (typeof content !== 'object' || Array.isArray(content)) {
            throw new Error(`Saved ${pageName} data has an invalid format.`)
          }

          const restoredAnswers = createEmptyAnswers()
          Object.keys(restoredAnswers).forEach((key) => {
            restoredAnswers[key] = typeof content[key] === 'string' ? content[key] : ''
          })
          if (!cancelled) setAnswers(restoredAnswers)
        }
      } catch (error) {
        console.error(`Load Post-Immersion ${pageName} failed:`, error)
        if (!cancelled) {
          setErrorMessage(error?.message || `Could not load the saved ${pageName}.`)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadEvaluation()
    return () => { cancelled = true }
  }, [user?.id, section, pageName])

  const updateAnswer = (field, value) => {
    setAnswers((current) => ({ ...current, [field]: value }))
    setErrorMessage('')
    setStatusMessage('')
  }

  const handleSave = async () => {
    if (!user?.id) {
      setErrorMessage('Your account could not be identified. Please log in again.')
      return
    }

    setSaving(true)
    setErrorMessage('')
    setStatusMessage('')

    try {
      const { error } = await savePortfolioEntry(supabase, {
        user_id: user.id,
        section,
        content: answers,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,section' })
      if (error) throw error
      setStatusMessage(`${pageName} saved.`)
    } catch (error) {
      console.error(`Save Post-Immersion ${pageName} failed:`, error)
      setErrorMessage(error?.message || `Could not save the ${pageName}.`)
    } finally {
      setSaving(false)
    }
  }

  const reflectionInput = (field, label, multiline = false) => {
    const Input = multiline ? 'textarea' : 'input'
    return (
      <Input
        aria-label={label}
        value={answers[field]}
        disabled={loading || saving || !user?.id}
        onChange={(event) => updateAnswer(field, event.target.value)}
      />
    )
  }

  return (
    <div className="dashboard-section workplace-essay-page post-immersion-evaluation-page">
      <button type="button" className="portfolio-back-button" onClick={onBack}>
        ← Back to Post-Immersion
      </button>

      {isSelfReflection ? (
        <article className="workplace-essay-document post-immersion-self-reflection-document">
          <h1>SELF EVALUATION AND REFLECTION</h1>
          <h2>Work Immersion Evaluation Form</h2>
          <div className="self-reflection-table-wrap">
            <table className="self-reflection-form-table">
              <colgroup>
                <col className="self-reflection-label-column" />
                <col />
                <col />
                <col />
                <col />
              </colgroup>
              <tbody>
                <tr>
                  <th scope="row">Student’s Name:</th>
                  <td colSpan="4">{reflectionInput('studentName', 'Student’s Name')}</td>
                </tr>
                <tr>
                  <th scope="row">Track / Strand:</th>
                  <td>{reflectionInput('trackStrand', 'Track or Strand')}</td>
                  <th scope="row">Specialization:</th>
                  <td colSpan="2">{reflectionInput('specialization', 'Specialization')}</td>
                </tr>
                <tr>
                  <th scope="row">Training Company:</th>
                  <td colSpan="4">{reflectionInput('trainingCompany', 'Training Company')}</td>
                </tr>
                <tr>
                  <th scope="row">Company Address:</th>
                  <td colSpan="2">{reflectionInput('companyAddress', 'Company Address')}</td>
                  <th scope="row">Telephone Number:</th>
                  <td>{reflectionInput('telephoneNumber', 'Telephone Number')}</td>
                </tr>
                <tr>
                  <th scope="row">Contact Person:</th>
                  <td colSpan="2">{reflectionInput('contactPerson', 'Contact Person')}</td>
                  <th scope="row">Contact Number:</th>
                  <td>{reflectionInput('contactNumber', 'Contact Number')}</td>
                </tr>
                <tr>
                  <th scope="row">Inclusive Date of Training:</th>
                  <td>{reflectionInput('inclusiveDateFrom', 'Training start date')}</td>
                  <th scope="row">to</th>
                  <td>{reflectionInput('inclusiveDateTo', 'Training end date')}</td>
                  <td>
                    <span>, 20</span>
                    {reflectionInput('inclusiveDateYear', 'Training end year')}
                  </td>
                </tr>
                <tr className="self-reflection-work-heading">
                  <th scope="col">Work Assignment</th>
                  <th scope="col">Department</th>
                  <th scope="col">Position</th>
                  <th scope="col">Other Department Assigned</th>
                  <th scope="col">Rater/Supervisor</th>
                </tr>
                <tr className="self-reflection-work-answers">
                  <td>{reflectionInput('workAssignment', 'Work Assignment', true)}</td>
                  <td>{reflectionInput('department', 'Department', true)}</td>
                  <td>{reflectionInput('position', 'Position', true)}</td>
                  <td>{reflectionInput('otherDepartment', 'Other Department Assigned', true)}</td>
                  <td>{reflectionInput('raterSupervisor', 'Rater or Supervisor', true)}</td>
                </tr>
                <tr>
                  <th scope="row">Date of Evaluation:</th>
                  <td colSpan="4">{reflectionInput('evaluationDate', 'Date of Evaluation')}</td>
                </tr>
                {[
                  ['dutiesBriefly', 'Describe your duties briefly'],
                  ['strongestPerformance', 'What do you consider your strongest area of performance? Explain.'],
                  ['areasImproved', 'In what areas do you feel you have improved the most? Explain.'],
                  ['needsImprovement', 'In what areas do you feel you need the most improvement? Explain'],
                  ['challengingSituation', 'What situation challenged you the most? Explain.'],
                  ['overcomeChallenge', 'How did you overcome the challenge? Explain.'],
                  ['learnedExperiences', 'What did you learn from your experiences? Explain.'],
                  ['trainingStationPandemic', 'Do you think your training station is helps you times of pandemic? Explain.'],
                  ['suggestions', 'Suggestion/ recommendation:'],
                ].map(([field, prompt]) => (
                  <tr className="self-reflection-question-row" key={field}>
                    <th scope="row">{prompt}</th>
                    <td colSpan="4">{reflectionInput(field, prompt, true)}</td>
                  </tr>
                ))}
                <tr className="self-reflection-section-row">
                  <th colSpan="5">Accomplished by:</th>
                </tr>
                <tr>
                  <td colSpan="3" className="self-reflection-signature-cell">
                    {reflectionInput('studentSignature', 'Student’s Name and Signature')}
                    <span>Student’s Name and Signature</span>
                  </td>
                  <th scope="row">Date:</th>
                  <td className="self-reflection-signature-cell">
                    {reflectionInput('studentDate', 'Student signature date')}
                  </td>
                </tr>
                <tr className="self-reflection-divider-row">
                  <td colSpan="5">Please do not fill out this portion.</td>
                </tr>
                <tr>
                  <th scope="row">Acquired Total Training Hours:</th>
                  <td colSpan="2">{reflectionInput('acquiredTrainingHours', 'Acquired Total Training Hours')}</td>
                  <th scope="row">Date of Completion:</th>
                  <td>{reflectionInput('dateOfCompletion', 'Date of Completion')}</td>
                </tr>
                <tr>
                  <th scope="row" colSpan="2">Acquired Total Performance Rating:</th>
                  <td colSpan="3">{reflectionInput('totalPerformanceRating', 'Acquired Total Performance Rating')}</td>
                </tr>
                <tr className="self-reflection-question-row">
                  <th scope="row">Remarks:</th>
                  <td colSpan="4">{reflectionInput('remarks', 'Remarks', true)}</td>
                </tr>
                <tr className="self-reflection-section-row">
                  <th colSpan="5">Accomplished by:</th>
                </tr>
                <tr>
                  <td colSpan="3" className="self-reflection-signature-cell self-reflection-teacher-signature-cell">
                    {reflectionInput('teacherSignature', 'Work Immersion Teacher’s Name and Signature')}
                    <span>VIVENCIO P. PASCUAL, JR<br />Work Immersion Teacher’s Name and Signature</span>
                  </td>
                  <th scope="row">Date:</th>
                  <td className="self-reflection-signature-cell">
                    <input
                      type="date"
                      aria-label="Work Immersion Teacher date"
                      value={answers.teacherDate}
                      disabled={loading || saving || !user?.id}
                      onChange={(event) => updateAnswer('teacherDate', event.target.value)}
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </article>
      ) : (
        <article className="workplace-essay-document post-immersion-evaluation-document">
          <h1>EVALUATION</h1>
          <p className="post-immersion-evaluation-instructions">
            Compare and contrast school and work application of skill, knowledge, and attitudes
            using the venn diagram below. Write a short explanation on the space provided.
          </p>

          <div className="post-immersion-evaluation-diagram">
            <div className="post-immersion-evaluation-circles" aria-hidden="true">
              <div />
              <div />
            </div>
            <div className="post-immersion-evaluation-columns" aria-hidden="true">
              {POST_IMMERSION_EVALUATION_PARTS.map((part) => (
                <h2 key={part.key}>{part.label === 'Shared' ? '' : part.label.toUpperCase()}</h2>
              ))}
            </div>
            {POST_IMMERSION_EVALUATION_AREAS.map((area) => (
              <section className="post-immersion-evaluation-row" key={area.key}>
                <h3>{area.label}</h3>
                <div className="post-immersion-evaluation-fields">
                  {POST_IMMERSION_EVALUATION_PARTS.map((part) => {
                    const field = `${area.key}_${part.key}`
                    return (
                      <label key={field}>
                        <textarea
                          value={answers[field]}
                          placeholder="Text box"
                          disabled={loading || saving || !user?.id}
                          onChange={(event) => updateAnswer(field, event.target.value)}
                          aria-label={`${part.label} ${area.label}`}
                          rows={3}
                        />
                      </label>
                    )
                  })}
                </div>
              </section>
            ))}
          </div>
        </article>
      )}

      {loading && <p role="status">Loading saved {pageName}...</p>}
      {errorMessage && <p role="alert" className="workplace-essay-message error">{errorMessage}</p>}
      {statusMessage && !saving && <p role="status" className="workplace-essay-message">{statusMessage}</p>}
      <button
        type="button"
        className="workplace-essay-save"
        onClick={handleSave}
        disabled={loading || saving || !user?.id}
      >
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  )
}

function WorkImmersionMapLocationPage({ user, onBack }) {
  const [answers, setAnswers] = useState({
    address: 'Centro 2 Lasam Cagayan',
    accessibility: 'From Malinta to CSU lasam means of transportation is Tricycle amounting 20 Pesos.',
  })
  const [savedPhoto, setSavedPhoto] = useState(null)
  const [selectedPhoto, setSelectedPhoto] = useState(null)
  const [photoPreview, setPhotoPreview] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const section = 'Immersion Proper/Work Immersion Map Location'

  useEffect(() => {
    let cancelled = false

    const loadMapLocation = async () => {
      if (!user?.id) {
        setLoading(false)
        setErrorMessage('Your account could not be identified. Please log in again.')
        return
      }

      setLoading(true)
      setErrorMessage('')
      setAnswers({
        address: 'Centro 2 Lasam Cagayan',
        accessibility: 'From Malinta to CSU lasam means of transportation is Tricycle amounting 20 Pesos.',
      })
      setSavedPhoto(null)

      try {
        const { data, error } = await loadPortfolioEntry(supabase, user.id, section)
        if (error) throw error

        let content = data?.content
        if (typeof content === 'string') content = JSON.parse(content)
        if (content !== undefined && content !== null) {
          if (typeof content !== 'object' || Array.isArray(content)) {
            throw new Error('Saved map location data has an invalid format.')
          }

          if (!cancelled) {
            setAnswers({
              address: typeof content.address === 'string' ? content.address : '',
              accessibility: typeof content.accessibility === 'string' ? content.accessibility : '',
            })
          }

          if (content.photo_path) {
            const { data: signed, error: signedError } = await getPortfolioSignedUrl(user.id, content.photo_path)
            if (signedError) throw signedError
            if (!cancelled) {
              setSavedPhoto({ path: content.photo_path, url: signed.signedUrl })
            }
          }
        }
      } catch (error) {
        console.error('Load Work Immersion Map Location failed:', error)
        if (!cancelled) {
          setErrorMessage(error?.message || 'Could not load the saved map location.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadMapLocation()
    return () => { cancelled = true }
  }, [user?.id])

  useEffect(() => {
    if (!selectedPhoto) {
      setPhotoPreview('')
      return undefined
    }

    const objectUrl = URL.createObjectURL(selectedPhoto)
    setPhotoPreview(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [selectedPhoto])

  const updateAnswer = (field, value) => {
    setAnswers((current) => ({ ...current, [field]: value }))
    setErrorMessage('')
    setStatusMessage('')
  }

  const handlePhotoSelect = (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setErrorMessage('Please choose an image file for the location screenshot.')
      return
    }

    setSelectedPhoto(file)
    setErrorMessage('')
    setStatusMessage('')
  }

  const handleSave = async () => {
    if (!user?.id) {
      setErrorMessage('Your account could not be identified. Please log in again.')
      return
    }

    setSaving(true)
    setErrorMessage('')
    setStatusMessage('')
    let uploadedPath = ''

    try {
      let photoPath = savedPhoto?.path || null
      if (selectedPhoto) {
        const safeName = selectedPhoto.name.replace(/[^a-zA-Z0-9._-]/g, '_')
        uploadedPath = `${user.id}/work-immersion-map/${Date.now()}-${safeName}`
        await savePortfolioPhoto(user.id, uploadedPath, selectedPhoto)
        photoPath = uploadedPath
      }

      let uploadedPhotoUrl = ''
      if (uploadedPath) {
        const { data: signed, error: signedError } = await getPortfolioSignedUrl(user.id, uploadedPath)
        if (signedError) throw signedError
        uploadedPhotoUrl = signed.signedUrl
      }

      const { error } = await savePortfolioEntry(supabase, {
        user_id: user.id,
        section,
        content: { ...answers, photo_path: photoPath },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,section' })
      if (error) throw error

      if (uploadedPath) {
        setSavedPhoto({ path: uploadedPath, url: uploadedPhotoUrl })
        setSelectedPhoto(null)
      }
      setStatusMessage('Work Immersion Map Location saved.')
    } catch (error) {
      console.error('Save Work Immersion Map Location failed:', error)
      if (uploadedPath) {
        const { error: cleanupError } = await supabase.storage
          .from('portfolio-files')
          .remove([uploadedPath])
        if (cleanupError) {
          console.error('Could not remove the unsaved map location photo:', cleanupError)
        }
      }
      setErrorMessage(error?.message || 'Could not save the map location.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="dashboard-section workplace-essay-page map-location-page">
      <button type="button" className="portfolio-back-button" onClick={onBack}>
        ← Back to Immersion Proper
      </button>

      <article className="workplace-essay-document map-location-document">
        <h1>LOCATION OF WORK IMMERSION VENUE</h1>

        <label className="narrative-profile-field">
          <span>Address:</span>
          <textarea
            value={answers.address}
            disabled={loading || saving || !user?.id}
            onChange={(event) => updateAnswer('address', event.target.value)}
            aria-label="Work immersion venue address"
            rows={2}
          />
        </label>

        <span className="map-location-label">Vicinity Map / Location Map</span>
        <label className="map-location-upload">
          {photoPreview || savedPhoto?.url ? (
            <img
              src={photoPreview || savedPhoto.url}
              alt="Uploaded work immersion location screenshot"
            />
          ) : (
            <span>Upload your screenshot location</span>
          )}
          <input
            type="file"
            accept="image/*"
            hidden
            disabled={loading || saving || !user?.id}
            onChange={handlePhotoSelect}
          />
        </label>

        <label className="narrative-profile-field map-location-accessibility">
          <span>Accessibility</span>
          <textarea
            value={answers.accessibility}
            disabled={loading || saving || !user?.id}
            onChange={(event) => updateAnswer('accessibility', event.target.value)}
            aria-label="Work immersion venue accessibility"
            rows={4}
          />
        </label>
      </article>

      {loading && <p role="status">Loading saved map location...</p>}
      {errorMessage && <p role="alert" className="workplace-essay-message error">{errorMessage}</p>}
      {statusMessage && !saving && <p role="status" className="workplace-essay-message">{statusMessage}</p>}
      <button
        type="button"
        className="workplace-essay-save"
        onClick={handleSave}
        disabled={loading || saving || !user?.id}
      >
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  )
}

const WORK_IMMERSION_EVALUATION_CRITERIA = [
  ['Technical Knowledge', 'Possesses the necessary academic background needed to handle the assigned job'],
  ['Quality of Work', 'Does job thoroughly and produces accurate work'],
  ['Dependability', 'Able to understand and follow instructions and can be relied upon to complete a task on time'],
  ['Initiative/Resourcefulness', 'A self-starter, able to follow every detail of the job with minimal supervision'],
  ['Judgement', 'Use logic or common sense, foresees effects of errors, able to choose options to do the job better'],
  ['Ease of Learning', 'Grasps instructions and able to learn procedures quickly'],
  ['Attitude Towards Work', 'Project pleasant disposition towards work'],
  ['Attendance and Punctuality', 'Follows time schedule without tardiness and /or absences'],
  ['Personal Appearance', 'Displays good grooming and regularly wears uniform'],
  ['Interpersonal Skills', 'Works cooperatively with superiors/ peers'],
]

const WORK_IMMERSION_EVALUATION_RATINGS = [
  'Outstanding (5)',
  'Very Good (4)',
  'Good (3)',
  'Fair (2)',
  'Poor (1)',
]

const createEmptyEvaluationAnswers = () => ({
    studentName: '',
    immersionSite: '',
    periodCovered: '',
    ratings: WORK_IMMERSION_EVALUATION_CRITERIA.map(() => ({ choice: '', score: '' })),
    ratingTotal: '',
    ratingAverage: '',
    overallRating: '',
    comments: '',
    supervisorSignature: '',
    studentSignature: '',
  })

function WorkImmersionEvaluationSheetPage({ user, onBack }) {
  const [answers, setAnswers] = useState(createEmptyEvaluationAnswers)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const section = 'Immersion Proper/Evaluation Sheet'

  useEffect(() => {
    let cancelled = false

    const loadEvaluation = async () => {
      if (!user?.id) {
        setLoading(false)
        setErrorMessage('Your account could not be identified. Please log in again.')
        return
      }

      setLoading(true)
      setErrorMessage('')
      setAnswers(createEmptyEvaluationAnswers())

      try {
        const { data, error } = await loadPortfolioEntry(supabase, user.id, section)
        if (error) throw error

        let content = data?.content
        if (typeof content === 'string') content = JSON.parse(content)
        if (content !== undefined && content !== null) {
          if (typeof content !== 'object' || Array.isArray(content)) {
            throw new Error('Saved evaluation sheet data has an invalid format.')
          }

          if (!cancelled) {
            const savedRatings = Array.isArray(content.ratings) ? content.ratings : []
            setAnswers({
              ...createEmptyEvaluationAnswers(),
              studentName: typeof content.studentName === 'string' ? content.studentName : '',
              immersionSite: typeof content.immersionSite === 'string' ? content.immersionSite : '',
              periodCovered: typeof content.periodCovered === 'string' ? content.periodCovered : '',
              ratings: WORK_IMMERSION_EVALUATION_CRITERIA.map((_, index) => ({
                choice: typeof savedRatings[index]?.choice === 'string' ? savedRatings[index].choice : '',
                score: typeof savedRatings[index]?.score === 'string' ? savedRatings[index].score : '',
              })),
              ratingTotal: typeof content.ratingTotal === 'string' ? content.ratingTotal : '',
              ratingAverage: typeof content.ratingAverage === 'string' ? content.ratingAverage : '',
              overallRating: typeof content.overallRating === 'string' ? content.overallRating : '',
              comments: typeof content.comments === 'string' ? content.comments : '',
              supervisorSignature: typeof content.supervisorSignature === 'string' ? content.supervisorSignature : '',
              studentSignature: typeof content.studentSignature === 'string' ? content.studentSignature : '',
            })
          }
        }
      } catch (error) {
        console.error('Load Work Immersion Evaluation Sheet failed:', error)
        if (!cancelled) {
          setErrorMessage(error?.message || 'Could not load the saved evaluation sheet.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadEvaluation()
    return () => { cancelled = true }
  }, [user?.id])

  const updateAnswer = (field, value) => {
    setAnswers((current) => ({ ...current, [field]: value }))
    setErrorMessage('')
    setStatusMessage('')
  }

  const updateCriterion = (index, field, value) => {
    setAnswers((current) => ({
      ...current,
      ratings: current.ratings.map((rating, ratingIndex) => (
        ratingIndex === index ? { ...rating, [field]: value } : rating
      )),
    }))
    setErrorMessage('')
    setStatusMessage('')
  }

  const handleSave = async () => {
    if (!user?.id) {
      setErrorMessage('Your account could not be identified. Please log in again.')
      return
    }

    setSaving(true)
    setErrorMessage('')
    setStatusMessage('')

    try {
      const { error } = await savePortfolioEntry(supabase, {
        user_id: user.id,
        section,
        content: answers,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,section' })
      if (error) throw error
      setStatusMessage('Evaluation sheet saved.')
    } catch (error) {
      console.error('Save Work Immersion Evaluation Sheet failed:', error)
      setErrorMessage(error?.message || 'Could not save the evaluation sheet.')
    } finally {
      setSaving(false)
    }
  }

  const identificationField = (label, field) => (
    <label className="evaluation-identification-field" key={field}>
      <span>{label}</span>
      <input
        type="text"
        value={answers[field]}
        disabled={loading || saving || !user?.id}
        onChange={(event) => updateAnswer(field, event.target.value)}
        aria-label={label}
      />
    </label>
  )

  return (
    <div className="dashboard-section workplace-essay-page evaluation-sheet-page">
      <button type="button" className="portfolio-back-button" onClick={onBack}>
        ← Back to Immersion Proper
      </button>

      <article className="evaluation-sheet-document">
        <h1>WORK IMMERSION EVALUATION SHEET</h1>

        <div className="evaluation-identification">
          {identificationField('Name of Student:', 'studentName')}
          {identificationField('Immersion Site:', 'immersionSite')}
          {identificationField('Period Covered:', 'periodCovered')}
        </div>

        <table className="evaluation-rating-table">
          <colgroup>
            <col style={{ width: '38.05%' }} />
            <col style={{ width: '12.95%' }} />
            <col style={{ width: '10.53%' }} />
            <col style={{ width: '9.19%' }} />
            <col style={{ width: '8.85%' }} />
            <col style={{ width: '9.67%' }} />
            <col style={{ width: '10.76%' }} />
          </colgroup>
          <thead>
            <tr>
              <th>Criteria/ Rating</th>
              {WORK_IMMERSION_EVALUATION_RATINGS.map((label) => <th key={label}>{label}</th>)}
              <th>Rating</th>
            </tr>
          </thead>
          <tbody>
            {WORK_IMMERSION_EVALUATION_CRITERIA.map(([name, description], index) => (
              <tr key={name}>
                <th scope="row">
                  <strong>{name}</strong>
                  <span>{description}</span>
                </th>
                {WORK_IMMERSION_EVALUATION_RATINGS.map((label, optionIndex) => (
                  <td key={label}>
                    <input
                      className="evaluation-rating-choice"
                      type="radio"
                      name={`evaluation-rating-${index}`}
                      value={String(5 - optionIndex)}
                      checked={answers.ratings[index].choice === String(5 - optionIndex)}
                      disabled={loading || saving || !user?.id}
                      onChange={(event) => updateCriterion(index, 'choice', event.target.value)}
                      aria-label={`${name}: ${label}`}
                    />
                  </td>
                ))}
                <td>
                  <input
                    className="evaluation-cell-input"
                    type="number"
                    min="1"
                    max="5"
                    step="1"
                    value={answers.ratings[index].score}
                    disabled={loading || saving || !user?.id}
                    onChange={(event) => updateCriterion(index, 'score', event.target.value)}
                    aria-label={`${name} rating`}
                  />
                </td>
              </tr>
            ))}
            <tr className="evaluation-overall-row">
              <td colSpan="7">
                <div className="evaluation-overall-content">
                  <span>(Add all ratings divided by 10 =</span>
                  <input
                    type="text"
                    value={answers.ratingTotal}
                    disabled={loading || saving || !user?.id}
                    onChange={(event) => updateAnswer('ratingTotal', event.target.value)}
                    aria-label="Sum of all ratings"
                  />
                  <span>/10 =</span>
                  <input
                    type="text"
                    value={answers.ratingAverage}
                    disabled={loading || saving || !user?.id}
                    onChange={(event) => updateAnswer('ratingAverage', event.target.value)}
                    aria-label="Ratings divided by ten"
                  />
                  <span>) Over All Rating:</span>
                  <input
                    type="text"
                    value={answers.overallRating}
                    disabled={loading || saving || !user?.id}
                    onChange={(event) => updateAnswer('overallRating', event.target.value)}
                    aria-label="Overall rating"
                  />
                </div>
              </td>
            </tr>
            <tr className="evaluation-comments-row">
              <td colSpan="7">
                <label>
                  <span>Comments/ Suggestion:</span>
                  <textarea
                    value={answers.comments}
                    disabled={loading || saving || !user?.id}
                    onChange={(event) => updateAnswer('comments', event.target.value)}
                    aria-label="Comments or suggestions"
                  />
                </label>
              </td>
            </tr>
            <tr className="evaluation-signature-row">
              <td colSpan="4">
                <input
                  type="text"
                  value={answers.supervisorSignature}
                  disabled={loading || saving || !user?.id}
                  onChange={(event) => updateAnswer('supervisorSignature', event.target.value)}
                  aria-label="Supervisor signature"
                />
                <span>Supervisor’s Signature Over Printed Name</span>
              </td>
              <td colSpan="3">
                <input
                  type="text"
                  value={answers.studentSignature}
                  disabled={loading || saving || !user?.id}
                  onChange={(event) => updateAnswer('studentSignature', event.target.value)}
                  aria-label="Student signature"
                />
                <span>Student’s Signature Over Printed Name</span>
              </td>
            </tr>
          </tbody>
        </table>
      </article>

      {loading && <p role="status">Loading saved evaluation sheet...</p>}
      {errorMessage && <p role="alert" className="workplace-essay-message error">{errorMessage}</p>}
      {statusMessage && !saving && <p role="status" className="workplace-essay-message">{statusMessage}</p>}
      <button
        type="button"
        className="workplace-essay-save"
        onClick={handleSave}
        disabled={loading || saving || !user?.id}
      >
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  )
}

const DAILY_TIME_RECORD_PAGE_SIZES = [5, 5, 5, 5, 5, 5]

const createDailyTimeRecordPages = () => DAILY_TIME_RECORD_PAGE_SIZES.map((entryCount) => ({
  entries: Array.from({ length: entryCount }, () => ({ date: '', day: '', tasks: '' })),
  preparedBy: '',
}))

const DAILY_TIME_RECORD_PHOTO_COUNT = 30

function DailyTimeRecordPage({ user, onBack }) {
  const [pages, setPages] = useState(createDailyTimeRecordPages)
  const photoPreviewUrls = useRef(new Set())
  const [photos, setPhotos] = useState(() => Array.from(
    { length: DAILY_TIME_RECORD_PHOTO_COUNT },
    () => ({ path: '', url: '', file: null, previewUrl: '' })
  ))
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const section = 'Immersion Proper/Daily Time Record'

  useEffect(() => {
    let cancelled = false

    const loadRecord = async () => {
      if (!user?.id) {
        await Promise.resolve()
        if (!cancelled) {
          setLoading(false)
          setErrorMessage('Your account could not be identified. Please log in again.')
        }
        return
      }

      try {
        const { data, error } = await loadPortfolioEntry(supabase, user.id, section)
        if (error) throw error

        let content = data?.content
        if (typeof content === 'string') content = JSON.parse(content)
        if (content !== undefined && content !== null) {
          if (typeof content !== 'object' || Array.isArray(content)) {
            throw new Error('Saved Daily Time Record data has an invalid format.')
          }

          const savedPages = Array.isArray(content.pages) ? content.pages : []
          const initialPages = createDailyTimeRecordPages()
          const restoredPages = initialPages.map((page, pageIndex) => {
            const savedIndexes = savedPages.length === 5
              ? (pageIndex === 2 ? [2, 3] : pageIndex < 2 ? [pageIndex] : pageIndex === 3 ? [4] : [])
              : [pageIndex]
            const sourcePages = savedIndexes
              .map((savedIndex) => savedPages[savedIndex])
              .filter(Boolean)
            const savedEntries = sourcePages.flatMap((savedPage) => (
              Array.isArray(savedPage?.entries) ? savedPage.entries : []
            ))
            const savedSignature = sourcePages
              .map((savedPage) => savedPage?.preparedBy)
              .flatMap((value) => (
                Array.isArray(value)
                  ? value
                  : typeof value === 'string'
                    ? [value]
                    : []
              ))
              .filter(Boolean)
              .join(' / ')
            return {
              entries: page.entries.map((entry, entryIndex) => ({
                date: typeof savedEntries[entryIndex]?.date === 'string' ? savedEntries[entryIndex].date : '',
                day: typeof savedEntries[entryIndex]?.day === 'string' ? savedEntries[entryIndex].day : '',
                tasks: typeof savedEntries[entryIndex]?.tasks === 'string' ? savedEntries[entryIndex].tasks : '',
              })),
              preparedBy: savedSignature,
            }
          })
          if (!cancelled) setPages(restoredPages)

          const savedPhotoPaths = Array.isArray(content.photo_paths) ? content.photo_paths : []
          const restoredPhotos = await Promise.all(
            Array.from({ length: DAILY_TIME_RECORD_PHOTO_COUNT }, async (_, photoIndex) => {
              const path = typeof savedPhotoPaths[photoIndex] === 'string'
                ? savedPhotoPaths[photoIndex]
                : ''
              if (!path) return { path: '', url: '', file: null, previewUrl: '' }

              const { data: signed, error: signedError } = await getPortfolioSignedUrl(user.id, path)
              if (signedError) throw signedError
              return { path, url: signed.signedUrl, file: null, previewUrl: '' }
            })
          )
          if (!cancelled) setPhotos(restoredPhotos)
        }
      } catch (error) {
        console.error('Load Daily Time Record failed:', error)
        if (!cancelled) {
          setErrorMessage(error?.message || 'Could not load the saved Daily Time Record.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadRecord()
    return () => { cancelled = true }
  }, [user?.id])

  useEffect(() => () => {
    photoPreviewUrls.current.forEach((url) => URL.revokeObjectURL(url))
    photoPreviewUrls.current.clear()
  }, [])

  const updateEntry = (pageIndex, entryIndex, field, value) => {
    setPages((current) => current.map((page, currentPageIndex) => (
      currentPageIndex === pageIndex
        ? {
          ...page,
          entries: page.entries.map((entry, currentEntryIndex) => (
            currentEntryIndex === entryIndex ? { ...entry, [field]: value } : entry
          )),
        }
        : page
    )))
    setErrorMessage('')
    setStatusMessage('')
  }

  const updatePreparedBy = (pageIndex, value) => {
    setPages((current) => current.map((page, currentPageIndex) => (
      currentPageIndex === pageIndex
        ? { ...page, preparedBy: value }
        : page
    )))
    setErrorMessage('')
    setStatusMessage('')
  }

  const handlePhotoSelect = (photoIndex, event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setErrorMessage('Please choose an image file.')
      return
    }

    setPhotos((current) => current.map((photo, currentIndex) => {
      if (currentIndex !== photoIndex) return photo
      if (photo.previewUrl) {
        URL.revokeObjectURL(photo.previewUrl)
        photoPreviewUrls.current.delete(photo.previewUrl)
      }
      const previewUrl = URL.createObjectURL(file)
      photoPreviewUrls.current.add(previewUrl)
      return {
        ...photo,
        file,
        previewUrl,
      }
    }))
    setErrorMessage('')
    setStatusMessage('')
  }

  const handleSave = async () => {
    if (!user?.id) {
      setErrorMessage('Your account could not be identified. Please log in again.')
      return
    }

    setSaving(true)
    setErrorMessage('')
    setStatusMessage('')
    const uploadedPaths = []

    try {
      const savedPhotoPaths = []
      const savedPhotoUrls = []
      for (const [photoIndex, photo] of photos.entries()) {
        if (photo.file) {
          const safeName = photo.file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
          const path = `${user.id}/daily-time-record/${Date.now()}-${photoIndex}-${safeName}`
          await savePortfolioPhoto(user.id, path, photo.file)
          uploadedPaths.push(path)

          const { data: signed, error: signedError } = await getPortfolioSignedUrl(user.id, path)
          if (signedError) throw signedError
          savedPhotoPaths.push(path)
          savedPhotoUrls.push(signed.signedUrl)
        } else {
          savedPhotoPaths.push(photo.path)
          savedPhotoUrls.push(photo.url)
        }
      }

      const { error } = await savePortfolioEntry(supabase, {
        user_id: user.id,
        section,
        content: { pages, photo_paths: savedPhotoPaths },
       updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,section' })
      if (error) throw error
      photos.forEach((photo) => {
        if (photo.previewUrl) {
          URL.revokeObjectURL(photo.previewUrl)
          photoPreviewUrls.current.delete(photo.previewUrl)
        }
      })
      setPhotos((current) => current.map((photo, photoIndex) => ({
        ...photo,
        path: savedPhotoPaths[photoIndex],
        url: savedPhotoUrls[photoIndex],
        file: null,
        previewUrl: '',
      })))
      setStatusMessage('Daily Time Record saved.')
    } catch (error) {
      console.error('Save Daily Time Record failed:', error)
      if (uploadedPaths.length) {
        const { error: cleanupError } = await supabase.storage
          .from('portfolio-files')
          .remove(uploadedPaths)
        if (cleanupError) {
          console.error('Could not remove unsaved Daily Time Record photos:', cleanupError)
        }
      }
      setErrorMessage(error?.message || 'Could not save the Daily Time Record.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="dashboard-section workplace-essay-page daily-time-record-page">
      <button type="button" className="portfolio-back-button" onClick={onBack}>
        ← Back to Immersion Proper
      </button>

      <div className="daily-time-record-pages">
        {pages.map((page, pageIndex) => (
          <article className="daily-time-record-sheet" key={`record-page-${pageIndex}`}>
            <header className="daily-time-record-header">
              <h1>DAILY TASK RECORD</h1>
              <p>Record your daily tasks performed for each day during your work immersion.</p>
            </header>

            <div className="daily-time-record-entries">
              {page.entries.map((entry, entryIndex) => {
                const globalEntryIndex = DAILY_TIME_RECORD_PAGE_SIZES
                  .slice(0, pageIndex)
                  .reduce((sum, count) => sum + count, 0) + entryIndex
                return (
                  <section className="daily-time-record-entry" key={`entry-${globalEntryIndex}`}>
                    <div className="daily-time-record-date-row">
                      <label>
                        <span>Date:</span>
                        <input
                          type="text"
                          value={entry.date}
                          disabled={loading || saving || !user?.id}
                          onChange={(event) => updateEntry(pageIndex, entryIndex, 'date', event.target.value)}
                          aria-label={`Day record ${globalEntryIndex + 1} date`}
                        />
                      </label>
                      <label>
                        <span>Day:</span>
                        <input
                          type="text"
                          value={entry.day}
                          disabled={loading || saving || !user?.id}
                          onChange={(event) => updateEntry(pageIndex, entryIndex, 'day', event.target.value)}
                          aria-label={`Day record ${globalEntryIndex + 1} day`}
                        />
                      </label>
                    </div>
                    <textarea
                      className="daily-time-record-task-box"
                      value={entry.tasks}
                      disabled={loading || saving || !user?.id}
                      onChange={(event) => updateEntry(pageIndex, entryIndex, 'tasks', event.target.value)}
                      aria-label={`Daily tasks for record ${globalEntryIndex + 1}`}
                    />
                  </section>
                )
              })}
            </div>

            <footer className="daily-time-record-signatures">
              <div className="daily-time-record-prepared-by">
                <span>Prepared by:</span>
                <input
                  type="text"
                  value={page.preparedBy}
                  disabled={loading || saving || !user?.id}
                  onChange={(event) => updatePreparedBy(pageIndex, event.target.value)}
                  aria-label={`Student name and signature for page ${pageIndex + 1}`}
                />
                <small>Student’s Name and Signature</small>
              </div>
              <div>
                <span>Noted by:</span>
                <div className="daily-time-record-signature-line" />
                <strong>VIVENCIO P. PASCUAL, JR.</strong>
                <small>Work Immersion Teacher</small>
              </div>
            </footer>
          </article>
        ))}
      </div>

      <section className="daily-time-record-photo-section">
        <h2>Upload you photos in your 30-day Work Immersion.</h2>
        <div className="daily-time-record-photo-grid">
          {photos.map((photo, photoIndex) => (
            <label className="daily-time-record-photo-slot" key={`work-photo-${photoIndex}`}>
              {photo.previewUrl || photo.url ? (
                <img
                  src={photo.previewUrl || photo.url}
                  alt={`Work immersion day ${photoIndex + 1}`}
                />
              ) : (
                <span>Upload photo {photoIndex + 1}</span>
              )}
              <input
                type="file"
                accept="image/*"
                hidden
                disabled={loading || saving || !user?.id}
                onChange={(event) => handlePhotoSelect(photoIndex, event)}
              />
            </label>
          ))}
        </div>
      </section>

      {loading && <p role="status">Loading saved Daily Time Record...</p>}
      {errorMessage && <p role="alert" className="workplace-essay-message error">{errorMessage}</p>}
      {statusMessage && !saving && <p role="status" className="workplace-essay-message">{statusMessage}</p>}
      <button
        type="button"
        className="workplace-essay-save"
        onClick={handleSave}
        disabled={loading || saving || !user?.id}
      >
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  )
}

/* =========================
   STUDENT INFORMATION ITEM
========================= */

function InfoItem({
  label,
  value,
}) {
  return (
    <div className="info-item">

      <span>
        {label}
      </span>

      <strong>
        {value}
      </strong>

    </div>
  )
}


function formatStudentJoinDate(joinedAt) {
  if (!joinedAt) return 'Join time unavailable'
  const date = new Date(joinedAt)
  if (Number.isNaN(date.getTime())) return 'Join time unavailable'
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function formatPortfolioSaveDate(savedAt) {
  if (!savedAt) return 'Date unavailable'
  const date = new Date(savedAt)
  if (Number.isNaN(date.getTime())) return 'Date unavailable'
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function getTeacherPortfolioEmailHref(teacherEmail, submission) {
  const subject = `Portfolio activity: ${submission.name}`
  const body = [
    'Recent Work Immersion portfolio activity',
    `Student: ${submission.name}`,
    `Last saved: ${formatPortfolioSaveDate(submission.savedAt)}`,
    `Current status: ${submission.status}`,
    '',
    'This message summarizes saved portfolio activity. It does not include portfolio files.',
  ].join('\n')

  return `mailto:${encodeURIComponent(teacherEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

/* =========================
   TEACHER CONTENT
========================= */

function TeacherContent({ activePage, user }) {
  const [className, setClassName] = useState('')
  const [classCode, setClassCode] = useState('')
  const [classes, setClasses] = useState([])
  const [students, setStudents] = useState([])
  const [searchTerm, setSearchTerm] = useState('')
  const [selectedStudent, setSelectedStudent] = useState(null)
  const [feedbackMessage, setFeedbackMessage] = useState('')
  const [feedbackSending, setFeedbackSending] = useState(false)
  const [feedbackError, setFeedbackError] = useState('')
  const [feedbackSuccess, setFeedbackSuccess] = useState('')
  const [showCreateClass, setShowCreateClass] = useState(false)
  const [editingClass, setEditingClass] = useState(null)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [studentProgress, setStudentProgress] = useState({})
  const [studentProgressLoading, setStudentProgressLoading] = useState(true)
  const [studentProgressError, setStudentProgressError] = useState('')
  const [recentSubmissions, setRecentSubmissions] = useState([])
  const [recentSubmissionsLoading, setRecentSubmissionsLoading] = useState(true)
  const [recentSubmissionsError, setRecentSubmissionsError] = useState('')

  const teacherName =
    user?.full_name ||
    user?.email?.split('@')[0] ||
    'Teacher'

  // LOAD TEACHER CLASSES FROM SUPABASE
  const loadClasses = async () => {
    if (!user?.id) return

    setLoading(true)

    const { data, error } = await supabase
      .from('immersion_classes')
      .select('*')
      .eq('teacher_id', user.id)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('Load classes error:', error)
      alert('Unable to load classes: ' + error.message)
      setLoading(false)
      return
    }

    setClasses(data || [])

    if (data?.length > 0) {
      setClassCode(data[0].class_code)
      setClassName(data[0].class_name)

      await loadStudents(data.map((item) => item.id), data)
    } else {
      setClassCode('')
      setClassName('')
      setStudents([])
    }

    setLoading(false)
  }
  
  // LOAD STUDENTS IN TEACHER'S CLASSES
  
  const loadStudents = async (classIds, classRows = classes) => {
    if (!classIds?.length) {
      setStudents([])
      return
    }

    try {
      // STEP 1: Get students who joined the teacher's classes
     const { data: members, error: membersError } =
  await supabase
    .from('class_members')
    .select(`
      id,
      class_id,
      student_id,
      joined_at
    `)
    .in('class_id', classIds)
    .order('joined_at', { ascending: false })

      if (membersError) {
        console.error(
          'Load class members error:',
          membersError
        )
        alert('Unable to load joined students: ' + membersError.message)
        setStudents([])
        return
      }

      if (!members || members.length === 0) {
        setStudents([])
        return
      }

      // STEP 2: Get the student IDs
      const studentIds = [
        ...new Set(members.map((item) => item.student_id))
      ]

      // STEP 3: Fetch their profiles separately
      const { data: profiles, error: profilesError } =
        await supabase
          .from('profiles')
          .select('id, full_name, email, grade, section, strand, specialization')
          .in('id', studentIds)

      if (profilesError) {
        console.error(
          'Load student profiles error:',
          profilesError
        )
        alert('Unable to load student profiles: ' + profilesError.message)
        setStudents([])
        return
      }

      // STEP 4: Match each class member with their profile
      const formattedStudents = members.map((member) => {
        const profile = profiles?.find(
          (item) => item.id === member.student_id
        )

        return {
          id: member.student_id,
          class_id: member.class_id,
          name: profile?.full_name || profile?.email || 'Student',
          grade: profile?.grade || '',
          section: profile?.section || '',
          strand: profile?.strand || '',
          specialization: profile?.specialization || '',
          class_name: classRows.find((item) => item.id === member.class_id)?.class_name || '',
          joined_at: member.joined_at,
        }
      })

      setStudents(formattedStudents)

      console.log(
        'Teacher joined students:',
        formattedStudents
      )

    } catch (error) {
      console.error('Unexpected load students error:', error)
      setStudents([])
    }
  }

  useEffect(() => {
    loadClasses()
  }, [user?.id])

  useEffect(() => {
    if (activePage !== 'Monitoring') return undefined

    const studentIds = [...new Set(students.map((student) => student.id))]
    let cancelled = false

    const loadStudentProgress = async () => {
      if (!studentIds.length) {
        return
      }

      setStudentProgressLoading(true)
      setStudentProgressError('')
      try {
        const { data, error } = await supabase
          .from('portfolio_entries')
          .select('user_id, section, content')
          .in('user_id', studentIds)
        if (error) throw error

        const entriesByStudent = Object.fromEntries(
          studentIds.map((studentId) => [studentId, {}])
        )
        for (const entry of data || []) {
          if (entry.user_id in entriesByStudent) {
            entriesByStudent[entry.user_id][entry.section] = entry.content
          }
        }

        const nextProgress = Object.fromEntries(
          studentIds.map((studentId) => [
            studentId,
            getPortfolioProgress(entriesByStudent[studentId]),
          ])
        )
        if (!cancelled) setStudentProgress(nextProgress)
      } catch (error) {
        console.error('Load teacher student portfolio progress failed:', error)
        if (!cancelled) {
          setStudentProgressError(
            error?.message || 'Could not load student portfolio progress.'
          )
          setStudentProgress({})
        }
      } finally {
        if (!cancelled) setStudentProgressLoading(false)
      }
    }

    loadStudentProgress()
    return () => { cancelled = true }
  }, [activePage, students])

  useEffect(() => {
    if (activePage !== 'Home' && activePage !== 'Notifications') return undefined

    const studentIds = [...new Set(students.map((student) => student.id))]
    let cancelled = false

    const loadRecentSubmissions = async () => {
      if (!studentIds.length) {
        setRecentSubmissions([])
        setRecentSubmissionsError('')
        setRecentSubmissionsLoading(false)
        return
      }

      setRecentSubmissionsLoading(true)
      setRecentSubmissionsError('')
      try {
        const { data, error } = await supabase
          .from('portfolio_entries')
          .select('user_id, section, content, updated_at')
          .in('user_id', studentIds)
          .order('updated_at', { ascending: false })
        if (error) throw error

        const entriesByStudent = new Map()
        for (const entry of data || []) {
          const entries = entriesByStudent.get(entry.user_id) || {}
          entries[entry.section] = entry.content
          entriesByStudent.set(entry.user_id, entries)
        }

        const latestByStudent = new Map()
        for (const entry of data || []) {
          const previous = latestByStudent.get(entry.user_id)
          if (
            !previous ||
            (entry.updated_at && new Date(entry.updated_at) > new Date(previous.updated_at || 0))
          ) {
            latestByStudent.set(entry.user_id, entry)
          }
        }

        const records = students
          .filter((student, index) => students.findIndex((item) => item.id === student.id) === index)
          .flatMap((student) => {
            const latestEntry = latestByStudent.get(student.id)
            if (!latestEntry) return []
            const progress = getPortfolioProgress(entriesByStudent.get(student.id) || {})
            return [{
              id: student.id,
              name: student.name,
              savedAt: latestEntry.updated_at,
              status: progress.percentage === 100 ? 'Complete' : 'In Progress',
            }]
          })
          .sort((first, second) => {
            const firstDate = first.savedAt ? new Date(first.savedAt).getTime() : 0
            const secondDate = second.savedAt ? new Date(second.savedAt).getTime() : 0
            return secondDate - firstDate
          })

        if (!cancelled) setRecentSubmissions(records.slice(0, 20))
      } catch (error) {
        console.error('Load recent portfolio activity failed:', error)
        if (!cancelled) {
          setRecentSubmissionsError(
            error?.message || 'Could not load recent portfolio activity.'
          )
          setRecentSubmissions([])
        }
      } finally {
        if (!cancelled) setRecentSubmissionsLoading(false)
      }
    }

    loadRecentSubmissions()
    return () => { cancelled = true }
  }, [activePage, students])

  // CREATE CLASS IN SUPABASE
  const createClass = async () => {
    if (!className.trim()) {
      alert('Please enter your class name.')
      return
    }

    if (!user?.id) {
      alert('Teacher account not found. Please log in again.')
      return
    }

    setCreating(true)

    try {
      const newCode = crypto.randomUUID()
        .replace(/-/g, '')
        .substring(0, 8)
        .toUpperCase()

      const { data, error } = await supabase
        .from('immersion_classes')
        .insert([
          {
            teacher_id: user.id,
            class_name: className.trim(),
            class_code: newCode,
            is_active: true,
          },
        ])
        .select()
        .single()

      if (error) {
        console.error('Create class error:', error)
        alert('Failed to create class: ' + error.message)
        return
      }

      setClasses((prev) => [data, ...prev])
      setClassCode(data.class_code)
      setClassName(data.class_name)
      setShowCreateClass(false)

      alert('Class created successfully!')

    } catch (error) {
      console.error(error)
      alert('Something went wrong while creating the class.')
    } finally {
      setCreating(false)
    }
  }

  // COPY CLASS CODE
  const handleDeleteClass = async (classId, className) => {
  const confirmed = window.confirm(
    `Are you sure you want to delete "${className}"? Students will no longer be able to access this class.`
  )

  if (!confirmed) return

  try {
    // Remove students from this class first
    const { error: membersError } = await supabase
      .from('class_members')
      .delete()
      .eq('class_id', classId)

    if (membersError) throw membersError

    // Delete the class
    const { error: classError } = await supabase
      .from('immersion_classes')
      .delete()
      .eq('id', classId)

    if (classError) throw classError

    alert('Class deleted successfully!')

    // Refresh the class list
    setClasses((prev) =>
      prev.filter((item) => item.id !== classId)
    )

    setStudents((prev) =>
      prev.filter((student) => student.class_id !== classId)
    )
  } catch (error) {
    console.error('DELETE CLASS ERROR:', error)
    alert('Unable to delete class: ' + error.message)
  }
}
  const copyClassCode = async (code) => {
    if (!code) return

    try {
      await navigator.clipboard.writeText(code)
      alert('Class code copied!')
    } catch {
      alert(`Your class code is: ${code}`)
    }
  }

  const filteredStudents = students.filter((student) =>
    student.name.toLowerCase().includes(searchTerm.toLowerCase())
  )
  const uniqueFilteredStudents = [
    ...new Map(filteredStudents.map((student) => [student.id, student])).values(),
  ]
  const monitoringStudents = [
    ...new Map(filteredStudents.map((student) => [student.id, student])).values(),
  ]

  const handleSendFeedback = async (event) => {
    event.preventDefault()
    setFeedbackError('')
    if (!selectedStudent || !user?.id) {
      setFeedbackError('Select a student from your class roster before sending feedback.')
      return
    }
    if (!feedbackMessage.trim()) {
      setFeedbackError('Enter a feedback message.')
      return
    }

    setFeedbackSending(true)
    try {
      const { error } = await supabase
        .from('teacher_feedback')
        .insert({
          teacher_id: user.id,
          student_id: selectedStudent.id,
          title: 'Teacher Feedback',
          message: feedbackMessage.trim(),
        })
      if (error) throw error

      setFeedbackSuccess(`Feedback sent to ${selectedStudent.name}.`)
      setSelectedStudent(null)
      setFeedbackMessage('')
    } catch (error) {
      console.error('Send teacher feedback failed:', error)
      setFeedbackError(error?.message || 'Could not send feedback. Please try again.')
    } finally {
      setFeedbackSending(false)
    }
  }

  // HOME PAGE
  if (activePage === 'Home') {
    return (
      <div className="teacher-dashboard">
        <div className="teacher-welcome">
          <div>
            <p className="eyebrow">TEACHER DASHBOARD</p>

            <h1>Welcome back, {teacherName}!</h1>

            <p>
              Manage your Work Immersion class,
              monitor student portfolios, and review submissions.
            </p>
          </div>

          <div className="teacher-welcome-icon">
            <School size={30} />
          </div>
        </div>

        {/* OVERVIEW */}

        <section className="teacher-stats-grid">

          <div className="teacher-stat-card">
            <div className="teacher-stat-icon">
              <Users size={21} />
            </div>

            <span>Total Students</span>
            <h2>{students.length}</h2>
            <p>Students in your classes</p>
          </div>

          <div className="teacher-stat-card">
            <div className="teacher-stat-icon">
              <FileCheck size={21} />
            </div>

            <span>Submitted Portfolios</span>
            <h2>0</h2>
            <p>Ready for review</p>
          </div>

          <div className="teacher-stat-card">
            <div className="teacher-stat-icon">
              <Clock size={21} />
            </div>

            <span>Pending Review</span>
            <h2>0</h2>
            <p>Awaiting your feedback</p>
          </div>

          <div className="teacher-stat-card">
            <div className="teacher-stat-icon">
              <ChartNoAxesCombined size={21} />
            </div>

            <span>Class Progress</span>
            <h2>0%</h2>
            <p>Average completion</p>
          </div>

        </section>

        {/* CLASS MANAGEMENT */}

        <section className="teacher-panel">

          <div className="teacher-panel-header">
            <div>
              <p className="eyebrow">WORK IMMERSION</p>
              <h2>My Classes</h2>

              <p>
                Create classes and let students join using
                their class codes.
              </p>
            </div>

            <button
              className="teacher-primary-btn"
              onClick={() => {
                setClassName('')
                setShowCreateClass(true)
              }}
            >
              <Plus size={17} />
              Create Class
            </button>
          </div>

          {loading ? (
            <div className="teacher-empty-state">
              <p>Loading your classes...</p>
            </div>
          ) : classes.length > 0 ? (

            <div className="teacher-classes-list">
{classes.map((item) => (
  <div
    className="teacher-class-created"
    key={item.id}
  >

    <div className="teacher-class-icon">
      <School size={25} />
    </div>

    <div className="teacher-class-details">
      <h3>{item.class_name}</h3>

      <p>
        Share this code with your students
        so they can join your class.
      </p>

      <div className="teacher-class-code">
        <strong>{item.class_code}</strong>

        <button
          type="button"
          onClick={() =>
            copyClassCode(item.class_code)
          }
          title="Copy class code"
        >
          <Copy size={17} />
          Copy Code
        </button>
      </div>

      <p>
        {students.filter(
          (student) => student.class_id === item.id
        ).length} students joined
      </p>
    </div>

    <div className="teacher-class-actions">

      <span className="teacher-class-badge">
        {item.is_active ? 'Active' : 'Inactive'}
      </span>

      {/* EDIT BUTTON */}
      <button
        type="button"
        className="teacher-edit-class-btn"
        onClick={() => {
          setEditingClass(item)
          setClassName(item.class_name)
          setShowCreateClass(true)
        }}
      >
        Edit
      </button>

      {/* DELETE BUTTON */}
      <button
        type="button"
        className="teacher-delete-class-btn"
        onClick={() =>
          handleDeleteClass(item.id, item.class_name)
        }
      >
        <Trash2 size={16} />
        Delete
      </button>

    </div>

  </div>
))}
            </div>

          ) : (

            <div className="teacher-empty-state">

              <div className="teacher-empty-icon">
                <Users size={30} />
              </div>

              <h3>No class created yet</h3>

              <p>
                Create your Work Immersion class
                to start connecting with your students.
              </p>

              <button
                className="teacher-outline-btn"
                onClick={() => setShowCreateClass(true)}
              >
                <Plus size={16} />
                Create Your First Class
              </button>

            </div>
          )}

        </section>

        {/* JOINED STUDENTS */}

        <section className="teacher-panel">

          <div className="teacher-panel-header">
            <div>
              <p className="eyebrow">CLASS MONITORING</p>
              <h2>Joined Students</h2>

              <p>
                Students who have joined your Work Immersion classes.
              </p>
            </div>
          </div>

          <div className="teacher-search-field">
            <label htmlFor="teacher-student-search">Search students</label>
            <input
              id="teacher-student-search"
              className="teacher-student-search"
              type="text"
              placeholder="Enter a student name"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>

          {filteredStudents.length > 0 ? (

            <div className="teacher-students-list">

              {filteredStudents.map((student) => (
                <div
                  className="teacher-student-row"
                  key={student.id + student.class_id}
                >
                  <div>
                    <h3>{student.name}</h3>
                    <p>Joined {formatStudentJoinDate(student.joined_at)}</p>
                  </div>
                </div>
              ))}

            </div>

          ) : (

            <div className="teacher-empty-state">
              <Users size={30} />

              <h3>No students found</h3>

              <p>
                Students will appear here after joining
                one of your classes.
              </p>
            </div>

          )}

        </section>

        {/* LATEST SUBMISSIONS */}

        <section className="teacher-panel">

          <div className="teacher-panel-header">
            <div>
              <p className="eyebrow">PORTFOLIO MONITORING</p>
              <h2>Recent Portfolio Submissions</h2>
              <p>Latest saved portfolio activity from your joined students.</p>
            </div>
          </div>

          <div className="teacher-submission-table" aria-live="polite">
            <div className="teacher-table-header">
              <span>STUDENT</span>
              <span>LAST SAVED</span>
              <span>STATUS</span>
            </div>

            {loading || recentSubmissionsLoading ? (
              <div className="teacher-submission-empty" role="status">
                Loading recent portfolio activity...
              </div>
            ) : recentSubmissionsError ? (
              <div className="teacher-submission-empty" role="alert">
                Could not load recent portfolio activity: {recentSubmissionsError}
              </div>
            ) : recentSubmissions.length > 0 ? (
              <div className="teacher-submission-rows">
                {recentSubmissions.slice(0, 5).map((submission) => (
                  <div className="teacher-submission-row" key={submission.id}>
                    <strong>{submission.name}</strong>
                    <span>{formatPortfolioSaveDate(submission.savedAt)}</span>
                    <span
                      className={`teacher-submission-status ${
                        submission.status === 'Complete' ? 'complete' : 'in-progress'
                      }`}
                    >
                      {submission.status}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="teacher-submission-empty">
                <strong>No portfolio activity yet</strong>
                <span>Students’ saved portfolio work will appear here.</span>
              </div>
            )}
          </div>

        </section>

        {/* CREATE CLASS MODAL */}

        {showCreateClass && (
          <div className="teacher-modal-overlay">

            <div className="teacher-modal">

              <button
                className="teacher-modal-close"
                onClick={() => setShowCreateClass(false)}
              >
                ×
              </button>

              <div className="teacher-modal-icon">
                <School size={26} />
              </div>

              <h2>Create Work Immersion Class</h2>

              <p>
                Enter a name for your class.
                Students will use the generated code to join.
              </p>

              <label>
                Class Name

                <input
                  type="text"
                  placeholder="e.g. Grade 12 CSS - Section A"
                  value={className}
                  onChange={(e) => setClassName(e.target.value)}
                />
              </label>

              <button
                className="teacher-primary-btn teacher-modal-submit"
                onClick={createClass}
                disabled={creating}
              >
                {creating ? 'Creating...' : 'Create Class'}
              </button>

              <button
                className="teacher-cancel-btn"
                onClick={() => setShowCreateClass(false)}
                disabled={creating}
              >
                Cancel
              </button>

            </div>

          </div>
        )}

      </div>
    )
  }

  if (activePage === 'Students') {
    return (
      <div className="teacher-dashboard">
        <div className="teacher-welcome">
          <div>
            <p className="eyebrow">TEACHER DASHBOARD / STUDENTS</p>
            <h1>Joined Students</h1>
            <p>See who joined your Work Immersion classes and when they joined.</p>
          </div>
        </div>

        <section className="teacher-panel">
          <div className="teacher-panel-header">
            <div>
              <p className="eyebrow">CLASS ROSTER</p>
              <h2>Students in Your Classes</h2>
            </div>
          </div>

          <div className="teacher-search-field">
            <label htmlFor="teacher-students-page-search">Search students</label>
            <input
              id="teacher-students-page-search"
              className="teacher-student-search"
              type="search"
              placeholder="Enter a student name"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
            />
          </div>

          {feedbackSuccess && (
            <p className="teacher-feedback-success" role="status">{feedbackSuccess}</p>
          )}
          {loading ? (
            <div className="teacher-empty-state" role="status">
              <p>Loading joined students...</p>
            </div>
          ) : uniqueFilteredStudents.length > 0 ? (
            <div className="teacher-students-list">
              {uniqueFilteredStudents.map((student) => (
                <div
                  className="teacher-student-row"
                  key={student.id}
                >
                  <div>
                    <h3>{student.name}</h3>
                    <p>
                      {[student.grade, student.section].filter(Boolean).join(' - ') || 'Grade and section not provided'}
                    </p>
                    {(student.strand || student.specialization) && (
                      <p>
                        {[student.strand, student.specialization].filter(Boolean).join(' · ')}
                      </p>
                    )}
                    {student.class_name && <p>{student.class_name}</p>}
                    <p>Joined {formatStudentJoinDate(student.joined_at)}</p>
                  </div>
                  <button
                    type="button"
                    className="teacher-primary-btn"
                    onClick={() => {
                      setFeedbackSuccess('')
                      setFeedbackError('')
                      setSelectedStudent(student)
                    }}
                  >
                    <Send size={16} /> Send Feedback
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="teacher-empty-state">
              <Users size={30} />
              <h3>{searchTerm.trim() ? 'No students found' : 'No students have joined yet'}</h3>
              <p>
                {searchTerm.trim()
                  ? 'Try a different name.'
                  : 'Students who join your classes will appear here.'}
              </p>
            </div>
          )}

          {selectedStudent && (
            <div className="teacher-modal-overlay" role="presentation">
              <section
                className="teacher-modal teacher-feedback-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="teacher-feedback-title"
              >
                <button
                  type="button"
                  className="teacher-modal-close"
                  aria-label="Cancel feedback"
                  onClick={() => {
                    if (!feedbackSending) {
                      setSelectedStudent(null)
                      setFeedbackError('')
                    }
                  }}
                  disabled={feedbackSending}
                >
                  ×
                </button>
                <p className="eyebrow">STUDENT FEEDBACK</p>
                <h2 id="teacher-feedback-title">Send Feedback</h2>
                <p>Selected student: <strong>{selectedStudent.name}</strong></p>
                <form onSubmit={handleSendFeedback}>
                  <label htmlFor="teacher-feedback-message">Feedback Message</label>
                  <textarea
                    id="teacher-feedback-message"
                    value={feedbackMessage}
                    onChange={(event) => setFeedbackMessage(event.target.value)}
                    rows={6}
                    required
                  />
                  {feedbackError && <p className="teacher-feedback-error" role="alert">{feedbackError}</p>}
                  <button
                    type="submit"
                    className="teacher-primary-btn teacher-modal-submit"
                    disabled={feedbackSending}
                  >
                    {feedbackSending ? 'Sending...' : 'Send Feedback'}
                  </button>
                  <button
                    type="button"
                    className="teacher-cancel-btn teacher-feedback-cancel"
                    onClick={() => {
                      setSelectedStudent(null)
                      setFeedbackError('')
                    }}
                    disabled={feedbackSending}
                  >
                    Cancel
                  </button>
                </form>
              </section>
            </div>
          )}
        </section>
      </div>
    )
  }

  if (activePage === 'Settings') {
    return <SettingsPage user={user} teacherMode />
  }

  if (activePage === 'Help Center') {
    return <HelpCenter user={user} teacherMode />
  }

  if (activePage === 'Notifications') {
    return (
      <div className="teacher-dashboard">
        <div className="teacher-welcome">
          <div>
            <p className="eyebrow">TEACHER DASHBOARD / NOTIFICATIONS</p>
            <h1>Notifications</h1>
            <p>Recent portfolio activity from students who joined your classes.</p>
          </div>
        </div>

        <section className="teacher-panel">
          <div className="teacher-panel-header">
            <div>
              <p className="eyebrow">PORTFOLIO ACTIVITY</p>
              <h2>Recent Student Updates</h2>
              <p>
                Dates reflect the latest saved portfolio section. Status reflects overall portfolio completion.
              </p>
            </div>
          </div>

          {loading || recentSubmissionsLoading ? (
            <div className="teacher-empty-state" role="status">
              <p>Loading portfolio notifications...</p>
            </div>
          ) : recentSubmissionsError ? (
            <p className="teacher-progress-error" role="alert">
              Could not load portfolio notifications: {recentSubmissionsError}
            </p>
          ) : recentSubmissions.length > 0 ? (
            <div className="teacher-notification-list">
              {recentSubmissions.map((submission) => (
                <article className="teacher-notification-card" key={submission.id}>
                  <div className="teacher-notification-content">
                    <h3>{submission.name}</h3>
                    <p>
                      Saved {formatPortfolioSaveDate(submission.savedAt)}
                    </p>
                    <span
                      className={`teacher-submission-status ${
                        submission.status === 'Complete' ? 'complete' : 'in-progress'
                      }`}
                    >
                      {submission.status}
                    </span>
                  </div>
                  {user?.email ? (
                    <a
                      className="teacher-notification-email"
                      href={getTeacherPortfolioEmailHref(user.email, submission)}
                    >
                      Email summary
                    </a>
                  ) : (
                    <span className="teacher-notification-email-unavailable">
                      Teacher email unavailable
                    </span>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <div className="teacher-empty-state">
              <Bell size={30} />
              <h3>No portfolio activity yet</h3>
              <p>Student portfolio updates will appear here after work is saved.</p>
            </div>
          )}
        </section>
      </div>
    )
  }
  
  // MONITORING PAGE
  if (activePage === 'Monitoring') {
    return (
      <div className="teacher-dashboard">

        <div className="teacher-welcome">
          <div>
            <p className="eyebrow">TEACHER DASHBOARD</p>
            <h1>Student Monitoring</h1>
            <p>
              Track each joined student’s Work Immersion portfolio progress.
            </p>
          </div>
        </div>

        <section className="teacher-panel">

          <div className="teacher-panel-header">
            <div>
              <p className="eyebrow">CLASS MONITORING</p>
              <h2>Portfolio Progress</h2>
              <p>
                Completion is based on the saved portfolio sections.
              </p>
            </div>
          </div>

          <div className="teacher-search-field">
            <label htmlFor="teacher-monitoring-search">Search students</label>
            <input
              id="teacher-monitoring-search"
              className="teacher-student-search"
              type="search"
              placeholder="Enter a student name"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
            />
          </div>
          

          {loading ? (
            <div className="teacher-empty-state" role="status">
              <p>Loading joined students...</p>
            </div>
          ) : monitoringStudents.length === 0 ? (
            <div className="teacher-empty-state">
              <Users size={30} />
              <h3>{searchTerm.trim() ? 'No students found' : 'No students have joined yet'}</h3>
              <p>
                {searchTerm.trim()
                  ? 'Try a different name.'
                  : 'Students who join your classes will appear here.'}
              </p>
            </div>
          ) : studentProgressLoading ? (
            <div className="teacher-empty-state" role="status">
              <p>Loading student portfolio progress...</p>
            </div>
          ) : studentProgressError ? (
            <p className="teacher-progress-error" role="alert">
              Could not load portfolio progress: {studentProgressError}
            </p>
          ) : (
            <div className="teacher-progress-list">
              {monitoringStudents.map((student) => {
                const progress = studentProgress[student.id]
                return (
                  <article
                    className="teacher-progress-student"
                    key={student.id}
                  >
                    <header className="teacher-progress-student-header">
                      <h3>{student.name}</h3>
                      <strong>{progress?.percentage ?? 0}%</strong>
                    </header>
                    <div
                      className="teacher-progress-track"
                      role="progressbar"
                      aria-label={`${student.name} overall portfolio progress`}
                      aria-valuemin="0"
                      aria-valuemax="100"
                      aria-valuenow={progress?.percentage ?? 0}
                    >
                      <div
                        className="teacher-progress-fill"
                        style={{ width: `${progress?.percentage ?? 0}%` }}
                      />
                    </div>
                    <p className="teacher-progress-summary">
                      {progress?.completedSections ?? 0} of {progress?.totalSections ?? 0} sections completed
                    </p>
                    <div className="teacher-progress-groups">
                      {(progress?.groups || PORTFOLIO_PROGRESS_GROUPS.map((group) => ({
                        ...group,
                        completed: 0,
                        total: group.modules.length,
                      }))).map((group) => {
                        const percentage = group.total
                          ? Math.round((group.completed / group.total) * 100)
                          : 0
                        return (
                          <div className="teacher-progress-group" key={group.title}>
                            <div className="teacher-progress-group-header">
                              <span>{group.title}</span>
                              <span>{group.completed}/{group.total}</span>
                            </div>
                            <div className="teacher-progress-track">
                              <div
                                className="teacher-progress-fill"
                                style={{ width: `${percentage}%` }}
                              />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </article>
                )
              })}
            </div>
          )}

        </section>

      </div>
    )
  }

  // OTHER TEACHER PAGES

  return (
    <div className="teacher-dashboard">

      <div className="teacher-welcome">
        <div>
          <p className="eyebrow">TEACHER DASHBOARD</p>

          <h1>{activePage}</h1>

          <p>
            Manage your Work Immersion class
            and student portfolios.
          </p>
        </div>
      </div>

      <section className="teacher-panel">
        <h2>{activePage}</h2>

        <p>
          This section will be connected
          to your Work Immersion class data.
        </p>
      </section>

    </div>
  )
}

export default App
