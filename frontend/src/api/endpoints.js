import { apiRequest } from './client.js'

export const authApi = {
  login: (credentials) => apiRequest('/auth/login', { method: 'POST', body: credentials, auth: false }),
  register: (input) => apiRequest('/auth/register', { method: 'POST', body: input, auth: false }),
  me: (options) => apiRequest('/auth/me', options),
}

export const queuesApi = {
  /** `{ page, limit, status: string[], search }` → `{ data, meta }` */
  list: (query, options) => apiRequest('/queues', { query, ...options }),
  get: (queueId, options) => apiRequest(`/queues/${queueId}`, options),
  create: (input) => apiRequest('/queues', { method: 'POST', body: input }),
  update: (queueId, changes) => apiRequest(`/queues/${queueId}`, { method: 'PATCH', body: changes }),
  pause: (queueId) => apiRequest(`/queues/${queueId}/pause`, { method: 'POST' }),
  resume: (queueId) => apiRequest(`/queues/${queueId}/resume`, { method: 'POST' }),
}
