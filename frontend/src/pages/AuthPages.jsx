import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext.jsx'
import { Field } from '../components/ui.jsx'
import { useTheme } from '../theme/ThemeContext.jsx'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function AuthThemeToggle() {
  const { resolvedTheme, toggleTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'
  const label = isDark ? 'Switch to light theme' : 'Switch to dark theme'
  return (
    <button
      type="button"
      className="theme-toggle auth-theme-toggle"
      onClick={toggleTheme}
      aria-label={label}
      title={label}
    >
      {isDark ? (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      ) : (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  )
}

function AuthCard({ title, subtitle, children, footer }) {
  return (
    <div className="auth-page">
      <AuthThemeToggle />
      <div className="auth-card">
        <div className="brand brand-large">
          <span className="brand-mark" aria-hidden="true">
            QF
          </span>
          <span>QueueForge</span>
        </div>
        <h1>{title}</h1>
        <p className="muted">{subtitle}</p>
        {children}
        <p className="auth-footer">{footer}</p>
      </div>
    </div>
  )
}

/** Shared submit handling: client validation, then server errors mapped to fields. */
function useAuthForm(validate, submit) {
  const [errors, setErrors] = useState({})
  const [formError, setFormError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  const onSubmit = async (event, values) => {
    event.preventDefault()
    const clientErrors = validate(values)
    setErrors(clientErrors)
    setFormError(null)
    if (Object.keys(clientErrors).length) return
    setSubmitting(true)
    try {
      await submit(values) // on success the PublicOnly guard redirects
    } catch (err) {
      setErrors(err.fieldErrors?.() ?? {})
      setFormError(err.code === 'VALIDATION_ERROR' ? null : err.message)
      setSubmitting(false)
    }
  }
  return { errors, formError, submitting, onSubmit }
}

export function LoginPage() {
  const { login, sessionExpired } = useAuth()
  const [values, setValues] = useState({ email: '', password: '' })
  const { errors, formError, submitting, onSubmit } = useAuthForm(
    (v) => ({
      ...(EMAIL.test(v.email.trim()) ? {} : { email: 'Enter a valid email address' }),
      ...(v.password ? {} : { password: 'Enter your password' }),
    }),
    (v) => login({ email: v.email.trim(), password: v.password })
  )
  const set = (key) => (e) => setValues((v) => ({ ...v, [key]: e.target.value }))

  return (
    <AuthCard
      title="Sign in"
      subtitle="Manage your queues and jobs."
      footer={
        <>
          No account? <Link to="/register">Create one</Link>
        </>
      }
    >
      {sessionExpired && !formError && (
        <div className="alert alert-info">Your session has ended. Please sign in again.</div>
      )}
      {formError && (
        <div className="alert alert-error" role="alert">
          {formError}
        </div>
      )}
      <form onSubmit={(e) => onSubmit(e, values)} noValidate>
        <Field label="Email" htmlFor="email" error={errors.email}>
          <input id="email" type="email" autoComplete="email" value={values.email} onChange={set('email')} />
        </Field>
        <Field label="Password" htmlFor="password" error={errors.password}>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={values.password}
            onChange={set('password')}
          />
        </Field>
        <button type="submit" className="button button-primary button-block" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </AuthCard>
  )
}

export function RegisterPage() {
  const { register } = useAuth()
  const [values, setValues] = useState({ name: '', email: '', password: '' })
  const { errors, formError, submitting, onSubmit } = useAuthForm(
    (v) => ({
      ...(v.name.trim() ? {} : { name: 'Enter your name' }),
      ...(EMAIL.test(v.email.trim()) ? {} : { email: 'Enter a valid email address' }),
      ...(v.password.length >= 8 ? {} : { password: 'Password must be at least 8 characters' }),
    }),
    (v) => register({ name: v.name.trim(), email: v.email.trim(), password: v.password })
  )
  const set = (key) => (e) => setValues((v) => ({ ...v, [key]: e.target.value }))

  return (
    <AuthCard
      title="Create your account"
      subtitle="Start running background jobs."
      footer={
        <>
          Already have an account? <Link to="/login">Sign in</Link>
        </>
      }
    >
      {formError && (
        <div className="alert alert-error" role="alert">
          {formError}
        </div>
      )}
      <form onSubmit={(e) => onSubmit(e, values)} noValidate>
        <Field label="Name" htmlFor="name" error={errors.name}>
          <input id="name" autoComplete="name" value={values.name} onChange={set('name')} />
        </Field>
        <Field label="Email" htmlFor="email" error={errors.email}>
          <input id="email" type="email" autoComplete="email" value={values.email} onChange={set('email')} />
        </Field>
        <Field label="Password" htmlFor="password" error={errors.password} hint="At least 8 characters.">
          <input
            id="password"
            type="password"
            autoComplete="new-password"
            value={values.password}
            onChange={set('password')}
          />
        </Field>
        <button type="submit" className="button button-primary button-block" disabled={submitting}>
          {submitting ? 'Creating account…' : 'Create account'}
        </button>
      </form>
    </AuthCard>
  )
}
