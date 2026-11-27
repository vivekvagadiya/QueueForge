import { useState } from 'react'
import { queuesApi } from '../api/endpoints.js'
import { Modal } from '../components/Modal.jsx'
import { Field } from '../components/ui.jsx'
import { buildQueuePayload, SERVER_FIELD, toForm, validateQueueForm } from './queueForm.js'

/** Create (no `queue`) or edit a queue. Calls onSaved with the persisted queue. */
export function QueueFormModal({ queue, onClose, onSaved }) {
  const editing = Boolean(queue)
  const [values, setValues] = useState(() => toForm(queue))
  const [errors, setErrors] = useState({})
  const [formError, setFormError] = useState(null)
  const [saving, setSaving] = useState(false)
  const set = (key) => (e) => setValues((v) => ({ ...v, [key]: e.target.value }))

  const submit = async (event) => {
    event.preventDefault()
    const clientErrors = validateQueueForm(values)
    setErrors(clientErrors)
    setFormError(null)
    if (Object.keys(clientErrors).length) return

    const payload = buildQueuePayload(values, queue)
    if (editing && Object.keys(payload).length === 0) {
      onClose()
      return
    }
    setSaving(true)
    try {
      const res = editing ? await queuesApi.update(queue.id, payload) : await queuesApi.create(payload)
      onSaved(res.data)
    } catch (err) {
      const fieldErrors = {}
      for (const [path, message] of Object.entries(err.fieldErrors?.() ?? {})) {
        if (SERVER_FIELD[path]) fieldErrors[SERVER_FIELD[path]] = message
      }
      if (err.code === 'QUEUE_NAME_TAKEN') fieldErrors.name = err.message
      setErrors(fieldErrors)
      if (Object.keys(fieldErrors).length === 0) setFormError(err.message)
      setSaving(false)
    }
  }

  const describedBy = (key) => (errors[key] ? `${key}-error` : undefined)

  return (
    <Modal
      title={editing ? `Edit ${queue.name}` : 'Create queue'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="queue-form" className="button button-primary" disabled={saving}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create queue'}
          </button>
        </>
      }
    >
      {formError && (
        <div className="alert alert-error" role="alert">
          {formError}
        </div>
      )}
      <form id="queue-form" onSubmit={submit} noValidate>
        <Field label="Name" htmlFor="name" error={errors.name}>
          <input id="name" value={values.name} onChange={set('name')} aria-describedby={describedBy('name')} />
        </Field>
        <Field label="Description" htmlFor="description" error={errors.description}>
          <textarea id="description" rows={2} value={values.description} onChange={set('description')} />
        </Field>
        <Field
          label="Concurrency"
          htmlFor="concurrency"
          error={errors.concurrency}
          hint="Most jobs of this queue that may run at once, across all workers."
        >
          <input id="concurrency" inputMode="numeric" value={values.concurrency} onChange={set('concurrency')} />
        </Field>
        <div className="field-row">
          <Field label="Default max attempts" htmlFor="maxAttempts" error={errors.maxAttempts} hint="Blank = 3">
            <input id="maxAttempts" inputMode="numeric" value={values.maxAttempts} onChange={set('maxAttempts')} />
          </Field>
          <Field label="Default priority" htmlFor="priority" error={errors.priority} hint="Blank = 0">
            <input id="priority" inputMode="numeric" value={values.priority} onChange={set('priority')} />
          </Field>
        </div>
        {editing && (
          <Field
            label="Status"
            htmlFor="status"
            error={errors.status}
            hint="Paused queues accept jobs but run none. Archived queues reject new jobs."
          >
            <select id="status" value={values.status} onChange={set('status')}>
              <option value="ACTIVE">Active</option>
              <option value="PAUSED">Paused</option>
              <option value="ARCHIVED">Archived</option>
            </select>
          </Field>
        )}
      </form>
    </Modal>
  )
}
