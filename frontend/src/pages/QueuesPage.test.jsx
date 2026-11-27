import { screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, test } from 'vitest'
import { tokenStore } from '../api/client.js'
import { fail, mockApi, ok, queueFixture } from '../test/mockApi.js'
import { renderApp } from '../test/renderApp.jsx'

const USER = { id: 'u1', name: 'Ada', email: 'ada@example.com', status: 'ACTIVE' }
const meta = (total, page = 1, limit = 20) => ({ page, limit, total, totalPages: Math.ceil(total / limit) })

/** In-memory queue store behind the mocked API, filtered like the server. */
function queueServer(initial) {
  const queues = [...initial]
  const listCalls = []
  const routes = {
    'GET /auth/me': () => ok(USER),
    'GET /queues': ({ query }) => {
      listCalls.push(Object.fromEntries(query))
      const status = query.get('status')
      const search = (query.get('search') ?? '').toLowerCase()
      const rows = queues.filter(
        (q) => (!status || status.split(',').includes(q.status)) && q.name.toLowerCase().includes(search)
      )
      const page = Number(query.get('page') ?? 1)
      const limit = Number(query.get('limit') ?? 20)
      return ok(rows.slice((page - 1) * limit, page * limit), meta(rows.length, page, limit))
    },
    'POST /queues': ({ body }) => {
      if (queues.some((q) => q.name === body.name)) {
        return fail(409, 'QUEUE_NAME_TAKEN', `A queue named "${body.name}" already exists`)
      }
      const q = queueFixture({ ...body, description: body.description ?? null })
      queues.unshift(q)
      return [201, ok(q)]
    },
    'PATCH /queues/:id': ({ path, body }) => {
      const q = queues.find((x) => path.endsWith(x.id))
      Object.assign(q, body)
      return ok({ ...q })
    },
    'POST /queues/:id/pause': ({ path }) => {
      const q = queues.find((x) => path.includes(x.id))
      q.status = 'PAUSED'
      return ok({ ...q })
    },
    'POST /queues/:id/resume': ({ path }) => {
      const q = queues.find((x) => path.includes(x.id))
      q.status = 'ACTIVE'
      return ok({ ...q })
    },
  }
  return { queues, listCalls, routes }
}

const NAME = { selector: '.cell-title' }
const rowFor = (name) => screen.getByText(name, NAME).closest('tr')

beforeEach(() => tokenStore.set('tok'))

describe('Queues page', () => {
  test('lists queues with status, concurrency and defaults', async () => {
    const server = queueServer([
      queueFixture({ name: 'emails', concurrency: 4, description: 'Transactional mail' }),
      queueFixture({ name: 'reports', status: 'PAUSED', defaultJobOptions: { maxAttempts: 7, priority: 5 } }),
    ])
    mockApi(server.routes)
    renderApp('/queues')

    const emails = within(await screen.findByText('emails', NAME).then((el) => el.closest('tr')))
    expect(emails.getByText('ACTIVE')).toBeInTheDocument()
    expect(emails.getByText('4')).toBeInTheDocument()
    expect(emails.getByText('Transactional mail')).toBeInTheDocument()
    expect(within(rowFor('reports')).getByText('7 attempts · priority 5')).toBeInTheDocument()
  })

  test('status filter and search are kept in the URL and sent to the API', async () => {
    const server = queueServer([
      queueFixture({ name: 'emails' }),
      queueFixture({ name: 'email-digest', status: 'PAUSED' }),
      queueFixture({ name: 'sms', status: 'PAUSED' }),
    ])
    mockApi(server.routes)
    const { user, location } = renderApp('/queues')
    await screen.findByText('sms', NAME)

    await user.click(screen.getByRole('button', { name: 'Paused' }))
    await waitFor(() => expect(screen.queryByText('emails', NAME)).not.toBeInTheDocument())
    await waitFor(() => expect(location().search).toBe('?status=PAUSED'))

    await user.type(screen.getByRole('searchbox', { name: 'Search queues by name' }), 'email')
    await waitFor(() => expect(screen.queryByText('sms', NAME)).not.toBeInTheDocument())
    expect(screen.getByText('email-digest', NAME)).toBeInTheDocument()
    await waitFor(() => expect(new URLSearchParams(location().search).get('search')).toBe('email'))
    expect(server.listCalls.at(-1)).toMatchObject({ status: 'PAUSED', search: 'email', page: '1' })
  })

  test('opening a URL with filters restores that view (refresh)', async () => {
    const server = queueServer([queueFixture({ name: 'emails' }), queueFixture({ name: 'sms', status: 'PAUSED' })])
    mockApi(server.routes)
    renderApp('/queues?status=PAUSED&search=sm')

    expect(await screen.findByText('sms', NAME)).toBeInTheDocument()
    expect(screen.queryByText('emails', NAME)).not.toBeInTheDocument()
    expect(screen.getByRole('searchbox')).toHaveValue('sm')
    expect(screen.getByRole('button', { name: 'Paused' })).toHaveAttribute('aria-pressed', 'true')
  })

  test('paginates', async () => {
    const server = queueServer(Array.from({ length: 25 }, (_, i) => queueFixture({ name: `q-${String(i).padStart(2, '0')}` })))
    mockApi(server.routes)
    const { user, location } = renderApp('/queues')

    expect(await screen.findByText('Page 1 of 2 · 25 total')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(await screen.findByText('q-24', NAME)).toBeInTheDocument()
    await waitFor(() => expect(location().search).toBe('?page=2'))
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
  })

  test('pause and resume update the row from the API response', async () => {
    const server = queueServer([queueFixture({ name: 'emails' }), queueFixture({ name: 'old', status: 'ARCHIVED' })])
    mockApi(server.routes)
    const { user } = renderApp('/queues')
    await screen.findByText('emails', NAME)

    await user.click(within(rowFor('emails')).getByRole('button', { name: 'Pause emails' }))
    expect(await within(rowFor('emails')).findByText('PAUSED')).toBeInTheDocument()
    expect(screen.getByText('Paused emails')).toBeInTheDocument() // toast

    await user.click(within(rowFor('emails')).getByRole('button', { name: 'Resume emails' }))
    expect(await within(rowFor('emails')).findByText('ACTIVE')).toBeInTheDocument()

    expect(within(rowFor('old')).queryByRole('button', { name: /pause|resume/i })).not.toBeInTheDocument()
  })

  test('a failed action shows the server message', async () => {
    const server = queueServer([queueFixture({ name: 'emails' })])
    mockApi({ ...server.routes, 'POST /queues/:id/pause': () => fail(409, 'QUEUE_ARCHIVED', 'Archived queues cannot be paused') })
    const { user } = renderApp('/queues')
    await screen.findByText('emails', NAME)
    await user.click(screen.getByRole('button', { name: 'Pause emails' }))
    expect(await screen.findByText('Archived queues cannot be paused')).toBeInTheDocument()
  })

  test('creates a queue, showing validation and name conflicts in the form', async () => {
    const server = queueServer([queueFixture({ name: 'emails' })])
    mockApi(server.routes)
    const { user } = renderApp('/queues')
    await screen.findByText('emails', NAME)

    await user.click(screen.getByRole('button', { name: 'New queue' }))
    const dialog = screen.getByRole('dialog', { name: 'Create queue' })
    await user.type(within(dialog).getByLabelText('Name'), 'bad name')
    await user.clear(within(dialog).getByLabelText('Concurrency'))
    await user.click(within(dialog).getByRole('button', { name: 'Create queue' }))
    expect(within(dialog).getByText(/Use 1–100 letters/)).toBeInTheDocument()
    expect(within(dialog).getByText('A whole number from 1 to 1000')).toBeInTheDocument()

    await user.clear(within(dialog).getByLabelText('Name'))
    await user.type(within(dialog).getByLabelText('Name'), 'emails')
    await user.type(within(dialog).getByLabelText('Concurrency'), '3')
    await user.click(within(dialog).getByRole('button', { name: 'Create queue' }))
    expect(await within(dialog).findByText('A queue named "emails" already exists')).toBeInTheDocument()

    await user.clear(within(dialog).getByLabelText('Name'))
    await user.type(within(dialog).getByLabelText('Name'), 'reports')
    await user.click(within(dialog).getByRole('button', { name: 'Create queue' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByText('reports', NAME)).toBeInTheDocument()
    expect(server.queues[0]).toMatchObject({ name: 'reports', concurrency: 3 })
  })

  test('edits a queue, sending only changed fields', async () => {
    const server = queueServer([queueFixture({ name: 'emails', concurrency: 2 })])
    const fetchMock = mockApi(server.routes)
    const { user } = renderApp('/queues')
    await screen.findByText('emails', NAME)

    await user.click(screen.getByRole('button', { name: 'Edit emails' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit emails' })
    await user.clear(within(dialog).getByLabelText('Concurrency'))
    await user.type(within(dialog).getByLabelText('Concurrency'), '8')
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    expect(await within(rowFor('emails')).findByText('8')).toBeInTheDocument()
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')
    expect(JSON.parse(patch[1].body)).toEqual({ concurrency: 8 })
  })

  test('empty and error states', async () => {
    let failing = true
    const server = queueServer([])
    mockApi({
      ...server.routes,
      'GET /queues': (req) => (failing ? fail(503, 'SERVICE_UNAVAILABLE', 'Database is unavailable') : server.routes['GET /queues'](req)),
    })
    const { user } = renderApp('/queues?search=zzz')

    expect(await screen.findByRole('alert')).toHaveTextContent('Database is unavailable')
    failing = false
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'No matching queues' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(await screen.findByRole('heading', { name: 'No queues yet' })).toBeInTheDocument()
  })
})
