# QueueForge dashboard

React + Vite dashboard for the QueueForge API.

## Run

```bash
# 1. API (backend/api): PostgreSQL configured and migrated
npm run dev            # http://localhost:4000

# 2. Dashboard (this folder)
npm install
npm run dev            # http://localhost:5173
```

The dev server proxies `/api` to `http://localhost:4000`. Set `VITE_API_PROXY_TARGET` to point it elsewhere.
For a build served from another origin, set `VITE_API_BASE_URL` (e.g. `https://api.example.com/api/v1`) and allow that origin in the API's `CORS_ORIGIN`.

## Scripts

| Script | |
|---|---|
| `npm run dev` | Dev server with HMR |
| `npm test` | Vitest (jsdom) |
| `npm run lint` | ESLint |
| `npm run build` | Production build to `dist/` |

On Windows, run `npm test` from PowerShell or cmd. In Git Bash, a lowercase drive letter in the working directory makes Vitest load twice ("failed to find the current suite").

## Layout

- `src/api/`: fetch client (`client.js`: token, `ApiError`, 401 handling) and endpoint functions
- `src/auth/`: session context and route guards
- `src/components/`: shell layout, modal, toasts, shared UI
- `src/pages/`: Login/Register, Queues (+ create/edit dialog)
- `src/test/`: test setup, fetch mock, `renderApp` helper

See `docs/queueforge-sprint-wise-integration.md` (Sprint 6A) for behaviour details.
