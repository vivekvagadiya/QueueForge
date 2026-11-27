// Submit-job form logic. Mirrors backend/api/src/validators/job.validator.js;
// the server stays authoritative.

const MAX_DELAY_MS = 365 * 24 * 60 * 60 * 1000
const intIn = (value, min, max) => /^-?\d+$/.test(value) && Number(value) >= min && Number(value) <= max

export const EMPTY_FORM = {
  name: '',
  payload: '{\n  \n}',
  schedule: 'now', // now | delay | at
  delaySeconds: '',
  runAt: '', // datetime-local value
  priority: '',
  maxAttempts: '',
  idempotencyKey: '',
}

/** Server validation paths -> form fields. */
export const SERVER_FIELD = {
  name: 'name',
  payload: 'payload',
  priority: 'priority',
  maxAttempts: 'maxAttempts',
  delayMs: 'delaySeconds',
  scheduledAt: 'runAt',
  idempotencyKey: 'idempotencyKey',
}

const parsePayload = (text) => {
  if (!text.trim()) return { value: {} }
  try {
    const value = JSON.parse(text)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { error: 'Payload must be a JSON object, e.g. { "to": "a@b.com" }' }
    }
    return { value }
  } catch (err) {
    return { error: `Invalid JSON: ${err.message}` }
  }
}

/** Returns `{ errors, payload }`; `payload` is the request body when there are no errors. */
export const buildSubmitPayload = (v, now = new Date()) => {
  const errors = {}
  const name = v.name.trim()
  if (!name) errors.name = 'Enter the job name (the handler to run)'
  else if (name.length > 255) errors.name = 'At most 255 characters'

  const payload = parsePayload(v.payload)
  if (payload.error) errors.payload = payload.error

  const body = { name, payload: payload.value }

  if (v.schedule === 'delay') {
    const seconds = Number(v.delaySeconds)
    if (!v.delaySeconds.trim() || !Number.isFinite(seconds) || seconds < 0 || seconds * 1000 > MAX_DELAY_MS) {
      errors.delaySeconds = 'Seconds from now, up to 365 days'
    } else {
      body.delayMs = Math.round(seconds * 1000)
    }
  } else if (v.schedule === 'at') {
    const at = v.runAt ? new Date(v.runAt) : null
    if (!at || Number.isNaN(at.getTime())) errors.runAt = 'Pick a date and time'
    else if (at <= now) errors.runAt = 'Pick a time in the future'
    else body.scheduledAt = at.toISOString()
  }

  if (v.priority.trim()) {
    if (intIn(v.priority.trim(), -1000, 1000)) body.priority = Number(v.priority)
    else errors.priority = 'A whole number from -1000 to 1000'
  }
  if (v.maxAttempts.trim()) {
    if (intIn(v.maxAttempts.trim(), 1, 100)) body.maxAttempts = Number(v.maxAttempts)
    else errors.maxAttempts = 'A whole number from 1 to 100'
  }
  const key = v.idempotencyKey.trim()
  if (key) {
    if (key.length > 255 || !/^[\x21-\x7E]+$/.test(key)) errors.idempotencyKey = 'Printable ASCII without spaces, up to 255 characters'
    else body.idempotencyKey = key
  }

  return { errors, payload: Object.keys(errors).length ? null : body }
}
