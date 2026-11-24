import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useApi } from "./ApiProvider";
import { useAuth } from "../auth/AuthProvider";
import type { Access, Permission } from "./types";

interface AccessValue {
  /** Has this person kept the ability? True unless their custom role took it away (and true while it is still being found out). */
  can: (permission: Permission) => boolean;
  /** The name of the person's custom role, if they have one. */
  customRoleName: string | null;
}

/** Without the provider (a test, or a page shown on its own) nothing is hidden. */
const NOTHING_DENIED: AccessValue = { can: () => true, customRoleName: null };
const AccessContext = createContext<AccessValue>(NOTHING_DENIED);

/**
 * Asks the server what the signed-in person's custom role takes away, so the page can hide the buttons they can't use.
 * This is courtesy only: the database refuses the action whatever the page shows, so if the answer can't be had
 * the page simply shows everything its built-in role allows, and the server says no where it has to.
 */
export function AccessProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const { user } = useAuth();
  const userId = user?.userId;
  const [state, setState] = useState<{ userId: string | undefined; access: Access | null } | null>(null);

  const load = useCallback(() => {
    if (!userId) return () => {};
    let cancelled = false;
    api.getMyAccess()
      .then((access) => { if (!cancelled) setState({ userId, access }); })
      .catch(() => { if (!cancelled) setState({ userId, access: null }); });
    return () => { cancelled = true; };
  }, [api, userId]);
  useEffect(() => load(), [load]);

  const value = useMemo<AccessValue>(() => {
    // An answer belongs to one person: never carry it over to whoever signs in next.
    const access = state && state.userId === userId ? state.access : null;
    if (!access || access.denied.length === 0) return { can: () => true, customRoleName: access?.customRole?.name ?? null };
    const denied = new Set<Permission>(access.denied);
    return { can: (p) => !denied.has(p), customRoleName: access.customRole?.name ?? null };
  }, [state, userId]);

  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>;
}

export function useAccess(): AccessValue {
  return useContext(AccessContext);
}
