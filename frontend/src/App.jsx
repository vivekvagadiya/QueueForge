import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './auth/AuthContext.jsx'
import { PublicOnly, RequireAuth } from './auth/guards.jsx'
import { Layout } from './components/Layout.jsx'
import { ToastProvider } from './components/Toasts.jsx'
import { EmptyState } from './components/ui.jsx'
import { LoginPage, RegisterPage } from './pages/AuthPages.jsx'
import { QueuesPage } from './pages/QueuesPage.jsx'

function WorkersPage() {
  return (
    <section>
      <div className="page-header">
        <div>
          <h1>Workers</h1>
          <p className="muted">Worker health, active jobs and heartbeats.</p>
        </div>
      </div>
      <EmptyState title="Coming in Sprint 6B">
        Worker visibility needs the read-only workers endpoint, which is part of the next increment.
      </EmptyState>
    </section>
  )
}

function NotFoundPage() {
  return (
    <EmptyState title="Page not found" action={<Link to="/queues">Go to queues</Link>}>
      The page you asked for doesn’t exist.
    </EmptyState>
  )
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<PublicOnly />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
      </Route>
      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/queues" replace />} />
          <Route path="/queues" element={<QueuesPage />} />
          <Route path="/workers" element={<WorkersPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <AppRoutes />
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}
