import { useState } from 'react'
import { jobsApi } from '../../api/endpoints.js'
import { Modal } from '../../components/Modal.jsx'
import { Field } from '../../components/ui.jsx'
import { BUILTIN_HANDLERS } from './jobConstants.js'
import { buildSubmitPayload, EMPTY_FORM, SERVER_FIELD } from './submitJobForm.js'

const PRESET_PAYLOADS = {
  'system.echo': '{\n  "message": "Hello from QueueForge"\n}',
  'system.sleep': '{\n  "ms": 2000\n}',
  'system.fail': '{\n  "message": "Simulated failure"\n}',
}

/** Submits a job to `queue`; calls onSubmitted with the persisted job. */
export function SubmitJobModal({ queue, onClose, onSubmitted }) {
  const [values, setValues] = useState(EMPTY_FORM)
  const [errors, setErrors] = useState({})
  const [formError, setFormError] = useState(null)
  const [saving, setSaving] = useState(false)
  const set = (key) => (e) => setValues((v) => ({ ...v, [key]: e.target.value }))
  const defaults = queue.defaultJobOptions ?? {}

  const applyPreset = (handler) => {
    setValues((v) => ({
      ...v,
      name: handler,
      payload: PRESET_PAYLOADS[handler] ?? v.payload,
    }))
    setErrors((e) => ({ ...e, name: undefined, payload: undefined }))
  }

  const formatPayload = () => {
    try {
      const parsed = JSON.parse(values.payload || '{}')
      setValues((v) => ({ ...v, payload: JSON.stringify(parsed, null, 2) }))
      setErrors((e) => ({ ...e, payload: undefined }))
    } catch {
      setErrors((e) => ({ ...e, payload: 'Payload must be valid JSON' }))
    }
  }

  const submit = async (event) => {
    event.preventDefault()
    const { errors: clientErrors, payload } = buildSubmitPayload(values)
    setErrors(clientErrors)
    setFormError(null)
    if (!payload) return

    setSaving(true)
    try {
      const res = await jobsApi.submit(queue.id, payload)
      onSubmitted(res.data)
    } catch (err) {
      const fieldErrors = {}
      for (const [path, message] of Object.entries(err.fieldErrors?.() ?? {})) {
        const field = SERVER_FIELD[path.split('.')[0]]
        if (field && !fieldErrors[field]) fieldErrors[field] = message
      }
      if (err.code === 'IDEMPOTENCY_KEY_CONFLICT') fieldErrors.idempotencyKey = err.message
      setErrors(fieldErrors)
      if (Object.keys(fieldErrors).length === 0) setFormError(err.message)
      setSaving(false)
    }
  }

  return (
    <Modal
      title={`Submit job to ${queue.name}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="submit-job-form" className="button button-primary" disabled={saving}>
            {saving ? 'Submitting…' : 'Submit job'}
          </button>
        </>
      }
    >
      {queue.status === 'PAUSED' && (
        <div className="alert alert-info">This queue is paused: the job will wait until the queue is resumed.</div>
      )}
      {formError && (
        <div className="alert alert-error" role="alert">
          {formError}
        </div>
      )}
      <form id="submit-job-form" onSubmit={submit} noValidate>
        <Field label="Job name" htmlFor="job-name" error={errors.name} hint="The registered handler that runs this job.">
          <input
            id="job-name"
            list="job-handlers"
            autoFocus
            value={values.name}
            onChange={set('name')}
            autoComplete="off"
          />
          <datalist id="job-handlers">
            {BUILTIN_HANDLERS.map((h) => (
              <option key={h} value={h} />
            ))}
          </datalist>
          <div className="preset-row" aria-label="Built-in handler presets">
            <span className="cell-sub">Presets:</span>
            {BUILTIN_HANDLERS.map((h) => (
              <button
                key={h}
                type="button"
                className={`preset-chip${values.name === h ? ' active' : ''}`}
                onClick={() => applyPreset(h)}
              >
                {h}
              </button>
            ))}
          </div>
        </Field>
        <div className="field-label-row">
          <label htmlFor="job-payload">Payload (JSON object)</label>
          <button type="button" className="button button-ghost button-small" onClick={formatPayload}>
            Format JSON
          </button>
        </div>
        <div className={`field${errors.payload ? ' field-invalid' : ''}`}>
          <textarea
            id="job-payload"
            className="code-input"
            rows={6}
            spellCheck={false}
            value={values.payload}
            onChange={set('payload')}
          />
          {errors.payload && (
            <p className="field-error" id="job-payload-error">
              {errors.payload}
            </p>
          )}
        </div>

        <fieldset className="field">
          <legend>When</legend>
          <div className="radio-row">
            {[
              ['now', 'Now'],
              ['delay', 'After a delay'],
              ['at', 'At a time'],
            ].map(([value, label]) => (
              <label key={value} className="radio">
                <input
                  type="radio"
                  name="schedule"
                  value={value}
                  checked={values.schedule === value}
                  onChange={set('schedule')}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        {values.schedule === 'delay' && (
          <Field label="Delay (seconds)" htmlFor="job-delay" error={errors.delaySeconds}>
            <input id="job-delay" inputMode="decimal" value={values.delaySeconds} onChange={set('delaySeconds')} />
          </Field>
        )}
        {values.schedule === 'at' && (
          <Field label="Run at (your local time)" htmlFor="job-run-at" error={errors.runAt}>
            <input id="job-run-at" type="datetime-local" value={values.runAt} onChange={set('runAt')} />
          </Field>
        )}

        <div className="field-row">
          <Field
            label="Priority"
            htmlFor="job-priority"
            error={errors.priority}
            hint={`Blank = queue default (${defaults.priority ?? 0})`}
          >
            <input id="job-priority" inputMode="numeric" value={values.priority} onChange={set('priority')} />
          </Field>
          <Field
            label="Max attempts"
            htmlFor="job-max-attempts"
            error={errors.maxAttempts}
            hint={`Blank = queue default (${defaults.maxAttempts ?? 3})`}
          >
            <input id="job-max-attempts" inputMode="numeric" value={values.maxAttempts} onChange={set('maxAttempts')} />
          </Field>
        </div>
        <Field
          label="Idempotency key (optional)"
          htmlFor="job-idempotency-key"
          error={errors.idempotencyKey}
          hint="Submitting the same key again returns the original job instead of creating a duplicate."
        >
          <input id="job-idempotency-key" value={values.idempotencyKey} onChange={set('idempotencyKey')} autoComplete="off" />
        </Field>
      </form>
    </Modal>
  )
}
