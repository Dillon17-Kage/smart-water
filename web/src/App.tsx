import type { ReactNode } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { Permission } from './auth/permissions';
import { Layout } from './components/Layout';
import { AlertsPage } from './pages/AlertsPage';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { NetworkPage } from './pages/NetworkPage';
import { ValvesPage } from './pages/ValvesPage';
import { AuthProvider, useAuth } from './state/AuthContext';
import { LiveDataProvider } from './state/LiveDataContext';

/** Sends signed-out users to the login page and remembers where they were going. */
function RequireAuth({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  // Keyed on the user so signing in as someone else starts with fresh data.
  return <LiveDataProvider key={user.username}>{children}</LiveDataProvider>;
}

/** Each user sees only the functions that belong to their role. */
function RequirePermission({ permission, children }: { permission: Permission; children: ReactNode }) {
  const { can } = useAuth();
  if (!can(permission)) {
    return (
      <div className="rounded-xl border border-line bg-surface p-6 text-sm">
        <h1 className="text-base font-semibold">Not available for your role</h1>
        <p className="mt-1 text-ink-2">Ask an administrator if you need access to this page.</p>
        <Link to="/" className="mt-3 inline-block font-medium text-accent underline underline-offset-2">
          Back to the dashboard
        </Link>
      </div>
    );
  }
  return children;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            element={
              <RequireAuth>
                <Layout />
              </RequireAuth>
            }
          >
            <Route index element={<RequirePermission permission="dashboard.view"><DashboardPage /></RequirePermission>} />
            <Route path="network" element={<RequirePermission permission="network.view"><NetworkPage /></RequirePermission>} />
            <Route path="alerts" element={<RequirePermission permission="alerts.view"><AlertsPage /></RequirePermission>} />
            <Route path="valves" element={<RequirePermission permission="valves.view"><ValvesPage /></RequirePermission>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
