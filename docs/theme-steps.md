# QueueForge — Theme Implementation Steps (`docs/theme.md`)

`docs/theme.md` is a large spec (1,260 lines). Implement it in **5 incremental steps** so the AI agent stays focused, preserves existing API/Socket.IO functionality, and avoids wasting tokens.

> **Rules for every step:**
> - Follow `CLAUDE.md`: do **not** write or run `npm test` unless explicitly requested.
> - Verify each step with `npm run build` (and `npm run lint` at the end).
> - Never invent fake/mock metrics — only use real data from `backend/api`.

---

## Step 1 — Design System, Dark/Light Theme & App Layout
**Covers `docs/theme.md` Sections:** `3` (Theme System), `4` (Application Layout), `13` (Component Architecture), `14` (Visual Quality), `19` (Development Rules)

- [ ] Add CSS design tokens (Dark default + Light palette) and typography/spacing variables in `frontend/src/index.css`.
- [ ] Implement `ThemeProvider` (`dark` | `light` | `system`) with `localStorage` persistence.
- [ ] Upgrade `Layout.jsx` with the new Sidebar + Top Header (theme toggle, live Socket.IO status pill, user menu/logout).
- [ ] Keep all existing routes and pages working.

**Prompt to copy-paste:**
```text
Read docs/theme.md Sections 3, 4, 13, 14, and 19 only. Implement the Dark/Light/System theme system (CSS variables, ThemeProvider, localStorage persistence, header toggle) and the new Sidebar + Header Layout.jsx shell in frontend/. Keep all existing routes and pages working. Do not write or run tests; run `npm run build` once at the end.
```

---

## Step 2 — Overview Dashboard, System Health & Settings Pages
**Covers `docs/theme.md` Sections:** `5` (Overview Dashboard), `10` (System Health), `11` (Settings)

- [ ] Inspect `backend/api/src/routes/` first so only real endpoints are used (no fake analytics).
- [ ] Build Overview Dashboard page (`/`) with real queue/worker/job summary cards and recent activity.
- [ ] Build System Health page (`/health`) using `/api/v1/health/ready` (and real worker/queue health).
- [ ] Build Settings page (`/settings`) for appearance (theme) and UI preferences (e.g. live refresh/auto-polling preferences).
- [ ] Wire new routes into `App.jsx` and the Sidebar.

**Prompt to copy-paste:**
```text
Read docs/theme.md Sections 5, 10, and 11. First inspect backend/api/src/routes/ to see which endpoints actually exist. Then implement the Overview Dashboard, System Health, and Settings pages in frontend/ using real API data only (no fake numbers). Wire them into App.jsx and the sidebar. Do not write or run tests; run `npm run build` once at the end.
```

---

## Step 3 — Queues Page & Auth Pages Redesign
**Covers `docs/theme.md` Sections:** `6` (Queues Page) + Auth polish

- [ ] Upgrade `QueuesPage.jsx` and `QueueFormModal.jsx` to match the new design system (clean table/cards, status badges, search, status filter, pagination, empty/error states).
- [ ] Keep pause, resume, create, edit, and Socket.IO live refresh working.
- [ ] Polish `AuthPages.jsx` (Login / Register) so both Dark and Light themes look crisp.

**Prompt to copy-paste:**
```text
Read docs/theme.md Section 6. Upgrade QueuesPage.jsx, QueueFormModal.jsx, and AuthPages.jsx to match the new design system, status badges, search/filters, pagination, and empty/error states while preserving all existing API + Socket.IO behavior. Do not write or run tests; run `npm run build` once at the end.
```

---

## Step 4 — Jobs Explorer, Submit Modal & Job Detail Page
**Covers `docs/theme.md` Sections:** `7` (Jobs Explorer), `8` (Job Detail Page)

- [ ] Upgrade `JobsPage.jsx` (filters, search, status badges, pagination, cancel action, live updates).
- [ ] Upgrade `SubmitJobModal.jsx` (built-in handler presets, JSON validation, delay/schedule, priority, maxAttempts, idempotency key).
- [ ] Upgrade `JobDetailPage.jsx` (header summary, lifecycle timeline, `job_attempts` breakdown, copyable JSON payload/result/error blocks).

**Prompt to copy-paste:**
```text
Read docs/theme.md Sections 7 and 8. Upgrade JobsPage.jsx, SubmitJobModal.jsx, and JobDetailPage.jsx (including lifecycle timeline, attempts list, and copyable JSON payload/result/error blocks) using existing endpoints and Socket.IO live refresh. Do not write or run tests; run `npm run build` once at the end.
```

---

## Step 5 — Workers Page, Responsive Design & Final Polish
**Covers `docs/theme.md` Sections:** `9` (Workers Page), `15` (Responsive Design), `16` (Accessibility), `17` (Performance)

- [ ] Upgrade `WorkersPage.jsx` (health indicators, capacity bars, live heartbeat age, status filter tabs).
- [ ] Verify mobile/tablet responsiveness (collapsible sidebar, scrollable tables) and keyboard/focus accessibility across all pages.
- [ ] Run `npm run lint` and `npm run build` in `frontend/`.

**Prompt to copy-paste:**
```text
Read docs/theme.md Sections 9, 15, 16, and 17. Upgrade WorkersPage.jsx (health indicators, capacity bars, live heartbeat age) and do a final responsive + keyboard accessibility pass across all pages in frontend/. Do not write or run tests; run `npm run lint` and `npm run build` at the end.
```

---

## Testing in Docker After Any Step
To rebuild and serve only the updated frontend container on `http://localhost:8080`:
```powershell
docker compose --profile full up -d --build frontend
```
