import { BrowserRouter, Link, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './auth/AuthContext.jsx'
import { PublicOnly, RequireAuth } from './auth/guards.jsx'
import { Layout } from './components/Layout.jsx'
import { ToastProvider } from './components/Toasts.jsx'
import { EmptyState } from './components/ui.jsx'
import { LoginPage, RegisterPage } from './pages/AuthPages.jsx'
import { DashboardPage } from './pages/DashboardPage.jsx'
import { HealthPage } from './pages/HealthPage.jsx'
import { JobDetailPage } from './pages/jobs/JobDetailPage.jsx'
import { JobsPage } from './pages/jobs/JobsPage.jsx'
import { QueuesPage } from './pages/QueuesPage.jsx'
import { SettingsPage } from './pages/SettingsPage.jsx'
import { RealtimeProvider } from './realtime/RealtimeProvider.jsx'
import { PreferencesProvider } from './theme/PreferencesContext.jsx'
import { ThemeProvider } from './theme/ThemeContext.jsx'
import { WorkersPage } from './pages/WorkersPage.jsx'

function NotFoundPage() {
  return (
    <EmptyState title="Page not found" action={<Link to="/">Go to overview</Link>}>
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
          <Route index element={<DashboardPage />} />
          <Route path="/queues" element={<QueuesPage />} />
          <Route path="/queues/:queueId/jobs" element={<JobsPage />} />
          <Route path="/jobs/:jobId" element={<JobDetailPage />} />
          <Route path="/workers" element={<WorkersPage />} />
          <Route path="/health" element={<HealthPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  )
}

export default function App() {
  return (
    <ThemeProvider>
      <PreferencesProvider>
        <BrowserRouter>
          <AuthProvider>
            <RealtimeProvider>
              <ToastProvider>
                <AppRoutes />
              </ToastProvider>
            </RealtimeProvider>
          </AuthProvider>
        </BrowserRouter>
      </PreferencesProvider>
    </ThemeProvider>
  )
}
