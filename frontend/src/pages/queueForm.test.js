import { describe, expect, test } from 'vitest'
import { queueFixture } from '../test/mockApi.js'
import { buildQueuePayload, toForm, validateQueueForm } from './queueForm.js'

const form = (overrides = {}) => ({ ...toForm(), name: 'emails', ...overrides })

describe('validateQueueForm', () => {
  test('accepts valid input', () => {
    expect(validateQueueForm(form({ concurrency: '5', maxAttempts: '10', priority: '-3' }))).toEqual({})
  })

  test('mirrors the server rules', () => {
    const errors = validateQueueForm(
      form({ name: 'bad name!', concurrency: '0', maxAttempts: '101', priority: '1.5', description: 'x'.repeat(1001) })
    )
    expect(Object.keys(errors).sort()).toEqual(['concurrency', 'description', 'maxAttempts', 'name', 'priority'])
  })
})

describe('buildQueuePayload', () => {
  test('create omits empty optional fields', () => {
    expect(buildQueuePayload(form({ concurrency: '3' }))).toEqual({
      name: 'emails',
      concurrency: 3,
      defaultJobOptions: {},
    })
    expect(buildQueuePayload(form({ description: ' Mail ', maxAttempts: '5' }))).toEqual({
      name: 'emails',
      description: 'Mail',
      concurrency: 1,
      defaultJobOptions: { maxAttempts: 5 },
    })
  })

  test('edit sends only changed fields; job defaults are sent whole', () => {
    const queue = queueFixture({ description: 'Mail', defaultJobOptions: { maxAttempts: 5, priority: 2 } })
    expect(buildQueuePayload(toForm(queue), queue)).toEqual({})

    const changed = { ...toForm(queue), description: '', priority: '', status: 'PAUSED' }
    expect(buildQueuePayload(changed, queue)).toEqual({
      description: null,
      defaultJobOptions: { maxAttempts: 5 },
      status: 'PAUSED',
    })
  })
})
