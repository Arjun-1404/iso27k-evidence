import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AuthClient, AuthUser } from "./types";

interface AuthContextValue {
  client: AuthClient;
  user: AuthUser | null;
  mfaSetupRequired: boolean;
  setMfaSetupRequired: (required: boolean) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ client, children }: { client: AuthClient; children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(client.getUser());
  // True while the server is refusing everything but "set up two-step sign-in" for this person (the organisation
  // requires it). Belongs to one signed-in person: it never carries over to whoever signs in next.
  const [mfaSetupRequired, setMfaSetupRequiredState] = useState(false);
  const setMfaSetupRequired = useCallback((required: boolean) => setMfaSetupRequiredState(required), []);
  useEffect(() => client.subscribe(setUser), [client]);
  const userId = user?.userId;
  useEffect(() => setMfaSetupRequiredState(false), [userId]);
  const value = useMemo(() => ({ client, user, mfaSetupRequired, setMfaSetupRequired }), [client, user, mfaSetupRequired, setMfaSetupRequired]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside an AuthProvider");
  const c = ctx.client;
  return {
    user: ctx.user,
    mfaSetupRequired: ctx.mfaSetupRequired,
    setMfaSetupRequired: ctx.setMfaSetupRequired,
    login: c.login.bind(c),
    completeMfa: c.completeMfa.bind(c),
    cancelMfa: c.cancelMfa.bind(c),
    replaceSession: c.replaceSession.bind(c),
    logout: c.logout.bind(c),
  };
}
