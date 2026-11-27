import { screen, waitFor } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { tokenStore } from '../api/client.js'
import { fail, mockApi, ok } from '../test/mockApi.js'
import { renderApp } from '../test/renderApp.jsx'

const USER = { id: 'u1', name: 'Ada', email: 'ada@example.com', status: 'ACTIVE' }
const listEmpty = () => ok([], { page: 1, limit: 20, total: 0, totalPages: 0 })

describe('authentication', () => {
  test('signed-out users are sent to login, then back to the page they asked for', async () => {
    mockApi({
      'POST /auth/login': (req) => {
        expect(req.body).toEqual({ email: 'ada@example.com', password: 'secret-pass' })
        return ok({ user: USER, accessToken: 'tok' })
      },
      'GET /queues': listEmpty,
    })
    const { user, location } = renderApp('/queues?status=PAUSED')

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    await user.type(screen.getByLabelText('Email'), ' ada@example.com ')
    await user.type(screen.getByLabelText('Password'), 'secret-pass')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByRole('heading', { name: 'Queues' })).toBeInTheDocument()
    await waitFor(() => expect(location().pathname + location().search).toBe('/queues?status=PAUSED'))
    expect(tokenStore.get()).toBe('tok')
    expect(screen.getByText('Ada')).toBeInTheDocument()
  })

  test('shows client validation, then the server error for bad credentials', async () => {
    mockApi({ 'POST /auth/login': () => fail(401, 'INVALID_CREDENTIALS', 'Invalid email or password') })
    const { user } = renderApp('/login')

    await user.click(await screen.findByRole('button', { name: 'Sign in' }))
    expect(screen.getByText('Enter a valid email address')).toBeInTheDocument()
    expect(screen.getByText('Enter your password')).toBeInTheDocument()

    await user.type(screen.getByLabelText('Email'), 'ada@example.com')
    await user.type(screen.getByLabelText('Password'), 'wrong')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password')
  })

  test('register maps server field errors (email taken) and signs in on success', async () => {
    let attempts = 0
    mockApi({
      'POST /auth/register': () => {
        attempts += 1
        return attempts === 1
          ? fail(400, 'VALIDATION_ERROR', 'Request validation failed', [{ path: 'email', message: 'Invalid email' }])
          : [201, ok({ user: USER, accessToken: 'tok' })]
      },
      'GET /queues': listEmpty,
    })
    const { user } = renderApp('/register')

    await user.type(await screen.findByLabelText('Name'), 'Ada')
    await user.type(screen.getByLabelText('Email'), 'ada@example.com')
    await user.type(screen.getByLabelText('Password'), 'short')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(screen.getByText('Password must be at least 8 characters')).toBeInTheDocument()

    await user.clear(screen.getByLabelText('Password'))
    await user.type(screen.getByLabelText('Password'), 'long-enough')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText('Invalid email')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByRole('heading', { name: 'No queues yet' })).toBeInTheDocument()
  })

  test('a stored token restores the session on reload; logout clears it', async () => {
    tokenStore.set('tok')
    mockApi({ 'GET /auth/me': () => ok(USER), 'GET /queues': listEmpty })
    const { user, location } = renderApp('/queues')

    expect(await screen.findByRole('heading', { name: 'Queues' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Log out' }))
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    await waitFor(() => expect(location().pathname).toBe('/login'))
    expect(tokenStore.get()).toBeNull()
  })

  test('an expired token mid-session returns to login with a notice', async () => {
    tokenStore.set('tok')
    let expire = false
    mockApi({
      'GET /auth/me': () => ok(USER),
      'GET /queues': () => (expire ? fail(401, 'TOKEN_EXPIRED', 'Access token has expired') : listEmpty()),
    })
    const { user } = renderApp('/queues')
    await screen.findByRole('heading', { name: 'Queues' })

    expire = true
    await user.click(screen.getByRole('button', { name: 'Paused' }))
    expect(await screen.findByText('Your session has ended. Please sign in again.')).toBeInTheDocument()
    await waitFor(() => expect(tokenStore.get()).toBeNull())
  })
})
