// Queue form logic, kept apart from the component so it can be unit-tested.
// Mirrors backend/api/src/validators/queue.validator.js; the server stays authoritative.

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/
const intIn = (value, min, max) => /^-?\d+$/.test(value) && Number(value) >= min && Number(value) <= max

/** Server validation paths -> form fields. */
export const SERVER_FIELD = {
  name: 'name',
  description: 'description',
  concurrency: 'concurrency',
  status: 'status',
  'defaultJobOptions.maxAttempts': 'maxAttempts',
  'defaultJobOptions.priority': 'priority',
}

export const toForm = (queue) => ({
  name: queue?.name ?? '',
  description: queue?.description ?? '',
  concurrency: String(queue?.concurrency ?? 1),
  maxAttempts: queue?.defaultJobOptions?.maxAttempts?.toString() ?? '',
  priority: queue?.defaultJobOptions?.priority?.toString() ?? '',
  status: queue?.status ?? 'ACTIVE',
})

export const validateQueueForm = (v) => {
  const errors = {}
  if (!NAME.test(v.name.trim())) {
    errors.name = 'Use 1–100 letters, digits, "_", ".", ":" or "-", starting with a letter or digit'
  }
  if (v.description.length > 1000) errors.description = 'At most 1000 characters'
  if (!intIn(v.concurrency.trim(), 1, 1000)) errors.concurrency = 'A whole number from 1 to 1000'
  if (v.maxAttempts.trim() && !intIn(v.maxAttempts.trim(), 1, 100)) errors.maxAttempts = 'A whole number from 1 to 100'
  if (v.priority.trim() && !intIn(v.priority.trim(), -1000, 1000)) errors.priority = 'A whole number from -1000 to 1000'
  return errors
}

const defaultJobOptions = (v) => ({
  ...(v.maxAttempts.trim() ? { maxAttempts: Number(v.maxAttempts) } : {}),
  ...(v.priority.trim() ? { priority: Number(v.priority) } : {}),
})

/** Create payload, or only the changed fields for an edit (defaultJobOptions is replaced whole). */
export const buildQueuePayload = (v, queue) => {
  const next = {
    name: v.name.trim(),
    description: v.description.trim() || null,
    concurrency: Number(v.concurrency),
    defaultJobOptions: defaultJobOptions(v),
  }
  if (!queue) {
    const { description, ...rest } = next
    return description ? { ...rest, description } : rest
  }
  const changes = {}
  if (next.name !== queue.name) changes.name = next.name
  if (next.description !== (queue.description ?? null)) changes.description = next.description
  if (next.concurrency !== queue.concurrency) changes.concurrency = next.concurrency
  if (JSON.stringify(next.defaultJobOptions) !== JSON.stringify(defaultJobOptions(toForm(queue)))) {
    changes.defaultJobOptions = next.defaultJobOptions
  }
  if (v.status !== queue.status) changes.status = v.status
  return changes
}
