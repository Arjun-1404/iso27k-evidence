import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";

/** Where someone whose organisation requires two-step sign-in (and who hasn't set it up) is kept until they do. */
export const SECURITY_PATH = "/settings/security";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, mfaSetupRequired } = useAuth();
  const { pathname } = useLocation();
  if (!user) return <Navigate to="/login" replace />;
  if (mfaSetupRequired && pathname !== SECURITY_PATH) return <Navigate to={SECURITY_PATH} replace />;
  return <>{children}</>;
}
