import { Routes, Route, Navigate } from "react-router-dom";
import { RequireAuth } from "./components/RequireAuth";
import { LoginPage } from "./pages/LoginPage";
import { AcceptInvitePage } from "./pages/AcceptInvitePage";
import { ForgotPasswordPage } from "./pages/ForgotPasswordPage";
import { ResetPasswordPage } from "./pages/ResetPasswordPage";
import { DashboardPage } from "./pages/DashboardPage";
import { ControlsPage } from "./pages/ControlsPage";
import { MyControlsPage } from "./pages/MyControlsPage";
import { TenantsUsersPage } from "./pages/TenantsUsersPage";
import { AuditLogPage } from "./pages/AuditLogPage";
import { IntegrationsPage } from "./pages/IntegrationsPage";
import { SecurityPage } from "./pages/SecurityPage";
import { ServerSettingsPage } from "./pages/ServerSettingsPage";
import { useAuth } from "./auth/AuthProvider";

const AUDITOR_ROLES = new Set(["org_admin", "lead_auditor", "auditor", "read_only", "dashboard_only"]);

function HomeRedirect() {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={AUDITOR_ROLES.has(user.role) ? "/dashboard" : "/my-controls"} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/accept-invite" element={<AcceptInvitePage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/" element={<HomeRedirect />} />
      <Route path="/dashboard" element={<RequireAuth><DashboardPage /></RequireAuth>} />
      <Route path="/controls" element={<RequireAuth><ControlsPage /></RequireAuth>} />
      <Route path="/my-controls" element={<RequireAuth><MyControlsPage /></RequireAuth>} />
      <Route path="/tenants" element={<RequireAuth><TenantsUsersPage /></RequireAuth>} />
      <Route path="/users" element={<RequireAuth><TenantsUsersPage /></RequireAuth>} />
      <Route path="/settings/security" element={<RequireAuth><SecurityPage /></RequireAuth>} />
      <Route path="/settings/integrations" element={<RequireAuth><IntegrationsPage /></RequireAuth>} />
      <Route path="/settings/server" element={<RequireAuth><ServerSettingsPage /></RequireAuth>} />
      <Route path="/audit-log" element={<RequireAuth><AuditLogPage /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
