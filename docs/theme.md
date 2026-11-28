# QueueForge — Production-Grade Dashboard UI Redesign & Implementation

## Role

Act as a Senior Frontend Engineer, Product Designer, and UI/UX Architect.

Your task is to transform the existing QueueForge frontend into a polished, production-quality distributed job queue management dashboard suitable for:

- Technical interviews
- Recruiter demonstrations
- Portfolio presentations
- Real-world developer operations
- Monitoring background job processing systems

This is an existing application. Do not build a new project from scratch or replace the current architecture without justification.

The goal is to make the frontend quality match the strength of the backend implementation.

---

# 1. Project Context

QueueForge is a distributed job queue system built to demonstrate backend engineering, distributed systems, job processing, workers, retries, scheduling, concurrency, Redis, PostgreSQL, and real-time monitoring.

The frontend already contains functional features. Your first responsibility is to understand the existing implementation before modifying it.

### Existing frontend stack

- React 19
- Vite
- JavaScript (ES Modules)
- React Router 7
- Custom CSS
- Socket.IO
- Existing authentication implementation
- Existing API client and hooks

### Existing functional capabilities

- Authentication and protected routes
- Queue listing
- Queue creation and updates
- Queue pause and resume
- Queue-specific jobs
- Job submission
- Job priority
- Scheduled and delayed jobs
- Retry configuration
- Idempotency keys
- Job cancellation
- Job detail and attempts
- Job result and errors
- Worker listing
- Worker status
- Worker hostname and PID
- Worker concurrency
- Queue subscriptions
- Worker heartbeat
- Socket.IO real-time invalidation
- REST-based data refresh

### Existing files to inspect

Start by exploring these files and their related components:

- `frontend/src/App.jsx`
- `frontend/src/components/Layout.jsx`
- `frontend/src/pages/QueuesPage.jsx`
- `frontend/src/pages/jobs/JobsPage.jsx`
- `frontend/src/pages/jobs/SubmitJobModal.jsx`
- `frontend/src/pages/jobs/JobDetailPage.jsx`
- `frontend/src/pages/WorkersPage.jsx`
- `frontend/src/api/endpoints.js`
- `frontend/src/realtime/RealtimeProvider.jsx`
- `frontend/src/realtime/useLiveRefresh.js`
- `frontend/src/index.css`

Inspect the entire frontend structure and the backend API routes, controllers, services, models, validations, and response formats before making API assumptions.

---

# 2. Primary Design Objective

Create a modern distributed job queue operations dashboard.

The application should feel like a professional infrastructure/developer tool rather than a generic admin template.

Design references in terms of visual quality and UX direction:

- Linear
- Vercel Dashboard
- Supabase Dashboard
- Modern observability tools
- Modern developer infrastructure platforms

Do not directly copy any product.

The interface should communicate:

- Operational visibility
- Reliability
- System status
- Job lifecycle
- Worker health
- Queue performance
- Failure investigation
- Real-time processing

Use a clean, modern, premium visual design.

Avoid:

- Excessive gradients
- Glassmorphism everywhere
- Oversized cards
- Excessive rounded corners
- Too many colors
- Fake analytics
- Unnecessary animations
- Generic template appearance
- Decorative components without purpose
- Excessive empty space
- Cluttered dashboards

---

# 3. Theme System — Light & Dark

Implement a complete dual-theme system.

Both themes must be first-class experiences. Neither theme should look like an afterthought.

## Theme options

Support:

- Dark
- Light
- System (if practical and reliable)

Default theme: Dark.

## Theme toggle

Implement a compact, accessible theme toggle in the dashboard header.

Use appropriate icons:

- Sun for switching to light
- Moon for switching to dark

The toggle must:

- Work immediately without page reload
- Preserve the current user preference
- Be keyboard accessible
- Have an accessible label
- Include a tooltip
- Avoid unnecessary visual clutter

Add theme preference controls in Settings:

- Dark
- Light
- System

## Persistence

Persist the user's selected theme using localStorage.

Suggested key:

`queueforge-theme`

Requirements:

- Restore the selected theme on reload
- Avoid flashing the wrong theme during initial load
- Handle invalid localStorage values gracefully
- Respect system preferences when System mode is selected
- Update when system preference changes, if System mode is active

## Architecture

Use CSS custom properties and semantic design tokens.

Implement the theme through:

`data-theme="dark"`

and

`data-theme="light"`

Apply the theme at the application root.

Do not scatter hardcoded theme colors throughout components.

Create a centralized theme system.

## Dark palette

Use this palette as the starting point:

- App background: `#0B1020`
- Sidebar background: `#0E1528`
- Main surface: `#121B2E`
- Elevated surface: `#18243A`
- Border: `#26344D`
- Primary text: `#E8EEF8`
- Secondary text: `#91A0B8`
- Primary accent: `#6D8DFF`
- Success: `#35C98A`
- Warning: `#F2B84B`
- Danger: `#F16D78`

Adjust the palette if necessary to improve contrast and visual quality.

## Light palette

Starting point:

- App background: `#F5F7FB`
- Sidebar background: `#FFFFFF`
- Main surface: `#FFFFFF`
- Elevated surface: `#F0F3F9`
- Border: `#E2E8F0`
- Primary text: `#172033`
- Secondary text: `#64748B`
- Primary accent: `#4F6FE8`
- Success: `#16865B`
- Warning: `#A66A0A`
- Danger: `#D14352`

Adjust the palette for accessibility, hierarchy, and readability.

## Theme coverage

Every UI element must support both themes:

- Sidebar
- Header
- Navigation
- Cards
- Tables
- Table hover
- Status badges
- Buttons
- Inputs
- Textareas
- Selects
- Search
- Filters
- Dropdowns
- Modals
- Tooltips
- Toast notifications
- Empty states
- Loading states
- Error states
- Job detail
- JSON viewer
- Code blocks
- Timeline
- Charts
- Chart grid lines
- Chart labels
- Chart tooltips
- Pagination
- Confirmation dialogs

Do not leave white elements in dark mode or dark elements in light mode unintentionally.

Avoid using CSS filters to invert the entire application.

Ensure text contrast meets accessibility expectations.

Use subtle theme transition animations, but respect `prefers-reduced-motion`.

---

# 4. Application Layout

Implement a professional dashboard layout.

## Sidebar

Create a persistent sidebar containing:

- QueueForge logo/wordmark
- Overview
- Queues
- Jobs
- Workers
- System Health
- Settings

Use icons consistently.

Requirements:

- Active navigation state
- Hover states
- Tooltips when collapsed
- Responsive behavior
- Collapsible sidebar on desktop, if practical
- Mobile drawer navigation

At the bottom of the sidebar, show an application/product identity area.

Do not add fake user profile information.

## Header

The header should include:

- Current page title
- Breadcrumbs where appropriate
- Global search if supported by the actual application
- Realtime connection status
- Theme toggle
- User/authentication controls already supported by the backend

Avoid introducing nonfunctional search boxes.

## Main content

Use consistent:

- Page spacing
- Maximum widths where appropriate
- Typography hierarchy
- Card spacing
- Section spacing
- Table layouts
- Responsive behavior

The UI should feel cohesive across all pages.

---

# 5. Overview Dashboard

Route:

`/`

This should be the strongest page visually.

The dashboard should answer:

1. Is the queue system operational?
2. How many jobs are waiting?
3. How many are currently processing?
4. How many completed?
5. How many failed?
6. Are workers healthy?
7. What is currently happening?

## Metrics

Display real metrics wherever the backend supports them:

- Total Queues
- Waiting Jobs
- Active Jobs
- Completed Jobs
- Failed Jobs
- Active Workers

Use compact KPI cards.

Each card should have:

- Clear title
- Real value
- Relevant icon
- Status/description
- Optional trend only when real historical data exists

Never fabricate percentages, trends, throughput, or statistics.

If aggregate metrics are unavailable, inspect the existing backend.

If necessary, implement a minimal, secure, read-only dashboard endpoint using the existing architecture.

Do not make the frontend perform dozens of requests merely to calculate dashboard totals.

Do not introduce fake data.

## Queue overview

Display a queue overview section with:

- Queue name
- Queue status
- Waiting jobs
- Active jobs
- Completed jobs
- Failed jobs
- Queue concurrency/configuration, where available

Include actions:

- View queue
- Pause
- Resume

Use confirmation dialogs where necessary.

## Recent jobs

Display the latest jobs if the backend supports an appropriate endpoint.

Include:

- Job ID
- Job name/type
- Queue
- Status
- Priority
- Created time
- Duration, if available

Clicking a job opens its detail page.

## Worker overview

Display:

- Worker name/hostname
- Worker status
- Active jobs
- Concurrency
- Last heartbeat
- Queue subscriptions

Use meaningful health indicators.

## Recent activity

Show recent system activity only if real data is available.

Do not create a fake activity feed.

## Empty state

When no queues/jobs/workers exist, provide a clear empty state and useful action.

Example:

"Your system is ready. Create your first queue and submit a job to start processing."

---

# 6. Queues Page

Route:

`/queues`

Create a professional queue management interface.

## Features

- Queue listing
- Queue search
- Status filters
- Queue creation
- Queue editing
- Pause/resume
- Queue details
- Queue statistics
- Jobs associated with each queue

## Queue cards or table

Display:

- Queue name
- Status
- Job counts
- Concurrency
- Retry configuration
- Created date, if available

Choose a table or card layout based on the number of items and existing backend response.

Avoid unnecessary duplication.

## Queue details

Route:

`/queues/:queueId`

Display:

- Queue configuration
- Queue health
- Job statistics
- Associated workers
- Jobs belonging to the queue
- Actions

Maintain existing API functionality.

---

# 7. Jobs Explorer

Route:

`/jobs`

This page should make job investigation easy.

Important:

The existing jobs API is queue-scoped.

Do not pretend that a global jobs endpoint exists if it does not.

Inspect the backend.

If a real global jobs endpoint exists, use it.

If it does not, implement a proper endpoint only if justified and consistent with the backend architecture.

Do not fetch partial pages from every queue to create an unreliable global explorer.

## Jobs table

Display:

- Job ID
- Job name/type
- Queue
- Status
- Priority
- Attempts
- Created time
- Scheduled time, if applicable
- Duration, if available

## Filters

Support real backend filtering:

- Queue
- Status
- Priority
- Search
- Date range, only if supported

## UX

- Pagination
- Loading skeletons
- Empty states
- Error handling
- Refresh
- Clear filters
- Responsive table

## Job submission

Provide a prominent Submit Job button.

Preserve the existing submission functionality.

Submission modal should support:

- Queue selection
- Job name/type
- JSON payload
- Priority
- Delay
- Scheduled time
- Maximum attempts
- Idempotency key

Only expose options actually supported by the backend.

Improve the modal UI without breaking validation.

Provide JSON validation and clear validation errors.

---

# 8. Job Detail Page

Route:

`/jobs/:jobId`

This is an important interview/demo screen.

Create a polished job detail experience.

## Header

Display:

- Job ID
- Job name/type
- Current status
- Queue
- Created time

Actions depending on actual job state:

- Cancel
- Retry, only if supported
- Refresh

Do not show invalid actions for terminal jobs.

## Job overview

Show:

- Status
- Priority
- Attempt count
- Maximum attempts
- Created time
- Started time
- Completed time
- Scheduled time
- Duration
- Worker information, if available

## Lifecycle timeline

Show the job lifecycle visually.

Example:

Created → Queued → Processing → Completed

For failed jobs:

Created → Queued → Processing → Failed → Retry → Processing

Only display events supported by real backend data.

Do not invent timestamps or lifecycle transitions.

## Attempts

Display individual attempts:

- Attempt number
- Worker
- Start time
- End time
- Status
- Error
- Retry information

## Payload

Display the submitted JSON payload in a readable code/JSON viewer.

## Result

Display job result if available.

## Errors

Display error details with:

- Error message
- Stack trace, if available
- Attempt context

Ensure errors are readable in both themes.

---

# 9. Workers Page

Route:

`/workers`

Build a professional worker monitoring interface.

## Worker cards/table

Display:

- Worker ID
- Hostname
- PID
- Status
- Active jobs
- Concurrency
- Queue subscriptions
- Heartbeat
- Last seen

## Health indicators

Show:

- Online
- Offline
- Busy
- Idle

Use actual backend statuses.

Do not infer worker health from missing data without clearly defining the logic.

## Worker details

If supported by the backend, show:

- Active jobs
- Worker configuration
- Queue subscriptions
- Recent activity
- Heartbeat history

Do not invent worker controls.

---

# 10. System Health

Route:

`/health`

Create a system health page using real backend information.

Possible checks:

- API
- PostgreSQL
- Redis
- Workers
- Socket.IO

Only implement checks that can be reliably verified.

Display:

- Healthy
- Degraded
- Unavailable
- Unknown

Provide details for failed services.

Do not show fake uptime, response times, or health data.

If the backend does not expose dependency health, inspect it and implement a proper health endpoint if necessary.

---

# 11. Settings

Route:

`/settings`

Create a clean settings interface.

Include:

## Appearance

- Dark
- Light
- System

## Application preferences

Only include preferences that are actually implemented.

Do not create meaningless settings or fake save actions.

Theme preference must persist.

---

# 12. Realtime Integration

Preserve the existing Socket.IO architecture.

Inspect:

- RealtimeProvider
- useLiveRefresh
- Socket.IO events
- REST refresh mechanisms

Realtime events should invalidate or refresh authoritative data.

Do not blindly trust event payloads as the source of truth if the current architecture uses REST refresh.

Display a connection indicator:

- Connected
- Reconnecting
- Disconnected

Ensure:

- Proper event cleanup
- No duplicate listeners
- No unnecessary requests
- No memory leaks
- No broken refresh loops

If a realtime update changes job status, the UI should update naturally without requiring manual page refresh.

---

# 13. Component Architecture

Create reusable components where useful.

Suggested architecture:

components/
layout/
navigation/
ui/
dashboard/
queues/
jobs/
workers/
health/
theme/

features/
queues/
jobs/
workers/
dashboard/
settings/

hooks/
api/
realtime/
utils/

This is a suggested structure, not a requirement to reorganize the entire application.

Do not create excessive abstractions.

Keep components maintainable.

Use reusable components for:

- Button
- Card
- StatusBadge
- Modal
- Dropdown
- Table
- Pagination
- Input
- Select
- Search
- Tooltip
- Toast
- EmptyState
- LoadingState
- ErrorState
- ConfirmationDialog

Keep existing API functions and hooks where possible.

Do not introduce Zustand.

Do not migrate to TypeScript.

Continue using JavaScript.

Do not add unnecessary dependencies.

If adding an icon library, prefer a consistent icon set such as lucide-react.

---

# 14. Visual Quality Requirements

## Typography

Create a clear hierarchy:

- Page title
- Section heading
- Card title
- Body
- Secondary text
- Metadata

Avoid excessive font sizes.

## Spacing

Use a consistent spacing system.

## Borders

Use subtle borders and dividers.

## Shadows

Use restrained shadows.

## Status colors

Use consistent semantic colors:

- Success: Green
- Waiting: Neutral/Blue
- Active: Blue
- Failed: Red
- Paused: Amber
- Cancelled: Gray

Ensure status badges work in both themes.

## Tables

Tables must have:

- Clear headers
- Consistent row height
- Hover states
- Readable spacing
- Responsive handling
- Useful empty states

## Interaction

Add:

- Hover states
- Focus states
- Active states
- Loading states
- Disabled states
- Success feedback
- Error feedback

Animations must be subtle.

---

# 15. Responsive Design

Support:

- Desktop
- Laptop
- Tablet
- Mobile

Desktop should be the primary dashboard experience.

Mobile should still be usable.

Requirements:

- Responsive sidebar/drawer
- Responsive tables
- Responsive forms
- Modal sizing
- Responsive KPI cards
- Responsive spacing
- No horizontal overflow

Do not merely shrink the desktop UI.

Adapt layouts appropriately.

---

# 16. Accessibility

Implement:

- Semantic HTML
- Accessible buttons
- Keyboard navigation
- Focus states
- Accessible modals
- Escape key support where appropriate
- Labels for inputs
- ARIA labels where necessary
- Contrast in both themes
- Reduced-motion support

---

# 17. Performance

Avoid:

- Unnecessary rerenders
- Excessive API calls
- Duplicate Socket.IO listeners
- Huge component files
- Excessive dependencies
- Unnecessary polling
- Fetching large datasets without pagination

Use existing pagination and refresh patterns.

---

# 18. Implementation Strategy

Do not attempt to redesign every page in a single uncontrolled change.

Follow these phases.

## Phase 1 — Repository Audit

Inspect:

- Frontend architecture
- Backend APIs
- Existing routes
- Existing components
- Existing styles
- API response formats
- Realtime events
- Current functionality

Document:

- What already exists
- What can be reused
- What needs redesign
- What backend functionality is missing

Do not start implementation until you understand the existing code.

## Phase 2 — Design System

Implement:

- Theme architecture
- Dark theme
- Light theme
- Theme persistence
- Typography
- Spacing
- Color tokens
- Buttons
- Cards
- Inputs
- Tables
- Badges
- Modals
- Toasts

Test the theme toggle.

## Phase 3 — Application Layout

Implement:

- Sidebar
- Header
- Breadcrumbs
- Navigation
- Responsive layout
- Theme toggle
- Connection indicator

## Phase 4 — Dashboard

Implement:

- KPI metrics
- Queue overview
- Recent jobs
- Worker overview
- Real data integration
- Loading states
- Empty states
- Error states

## Phase 5 — Queues

Improve:

- Queue list
- Queue details
- Creation
- Editing
- Pause/resume
- Statistics
- Responsive UX

## Phase 6 — Jobs

Improve:

- Jobs explorer
- Filters
- Pagination
- Submission modal
- Job detail
- Attempts
- Payload
- Result
- Errors
- Timeline

## Phase 7 — Workers & Health

Improve:

- Worker monitoring
- Worker details
- Heartbeat
- System health

## Phase 8 — Final Polish

Verify:

- Every page in Dark mode
- Every page in Light mode
- Responsive behavior
- API functionality
- Realtime behavior
- Error handling
- Accessibility
- Loading states
- Empty states

---

# 19. Important Development Rules

1. Inspect existing code before modifying it.
2. Do not break existing functionality.
3. Do not invent API endpoints.
4. Do not fabricate dashboard statistics.
5. Do not use fake production data.
6. Do not remove existing functionality just to simplify UI.
7. Do not replace the authentication system.
8. Do not rewrite the backend unnecessarily.
9. Do not migrate JavaScript to TypeScript.
10. Do not add Zustand.
11. Do not introduce unnecessary dependencies.
12. Preserve existing API client conventions.
13. Preserve existing validation.
14. Preserve Socket.IO behavior.
15. Use reusable components where appropriate.
16. Maintain clean component boundaries.
17. Handle loading, errors, and empty states.
18. Test both themes.
19. Test responsive layouts.
20. Run the available lint, test, and production build commands.

If backend changes are needed, explain why before making significant architectural changes.

---

# 20. Final Acceptance Criteria

The redesign is complete when:

- The dashboard looks professional and polished.
- The UI visually matches the backend quality.
- Dark mode works across the entire application.
- Light mode works across the entire application.
- Theme preference persists.
- The theme toggle works without refreshing.
- All existing functionality remains operational.
- Queue management works.
- Job submission works.
- Job cancellation works.
- Job details are readable.
- Workers are properly displayed.
- Realtime updates work.
- Connection status is visible.
- System health reflects actual backend data.
- No fake metrics are displayed.
- Responsive layouts work.
- No major console errors exist.
- No broken API requests exist.
- Production build succeeds.

---

# 21. Recruiter Demo Experience

Optimize the application for a 3–5 minute demonstration.

The ideal flow:

1. Open the Overview dashboard.
2. Show system metrics.
3. Show available queues.
4. Show worker health.
5. Submit a new job.
6. Watch the job move from Waiting to Active to Completed.
7. Open the job detail page.
8. Show attempts, payload, result, and lifecycle.
9. Demonstrate a failure/retry scenario if supported.
10. Switch between Dark and Light themes.
11. Show realtime updates.

The UI should make this demonstration intuitive without requiring explanations for every button.

---

# 22. Execution Instructions

Start with Phase 1.

First, inspect the repository and provide a concise audit:

- Existing architecture
- Existing functionality
- Current UI problems
- Missing APIs/data
- Proposed implementation sequence

Then proceed with implementation phase by phase.

Do not stop after giving a plan.

Implement the changes.

After each phase:

- Summarize files changed
- Explain important design decisions
- Identify any backend dependencies
- Run relevant checks

At completion, provide:

- Summary of UI changes
- New components
- Updated routes
- Theme architecture
- Backend changes, if any
- Tests performed
- Build status
- Known limitations

Prioritize correctness, maintainability, real data, and professional visual quality over unnecessary complexity.

**Begin with repository audit and Phase 1.**
