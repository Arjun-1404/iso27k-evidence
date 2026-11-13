import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useApi } from "./ApiProvider";
import { useAuth } from "../auth/AuthProvider";
import type { Tenant } from "./types";

interface TenantContextValue {
  tenants: Tenant[];
  selectedTenantId: string | null;
  selectTenant: (id: string) => void;
  loading: boolean;
  /** Why the tenant list couldn't be loaded, if it couldn't — so a failure isn't mistaken for "no tenants". */
  error: string | null;
}

const TenantContext = createContext<TenantContextValue | null>(null);

// Remembering the selected tenant is a convenience only. Private windows and blocked site data make browser storage
// throw, and the app must work the same without it (it then just starts on the first tenant each time).
function rememberedTenant(): string | null {
  try { return localStorage.getItem("selectedTenantId"); } catch { return null; }
}
function rememberTenant(id: string) {
  try { localStorage.setItem("selectedTenantId", id); } catch { /* not remembered; nothing else depends on it */ }
}

/**
 * For an auditor-side user this loads their tenant list and tracks which one is selected (persisted
 * across reloads). For a tenant-side user there is nothing to select — their session already carries
 * their own tenantId — so this just exposes that single tenant instead of calling the tenant-list
 * endpoint (which they don't have access to anyway).
 */
export function TenantProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const { user } = useAuth();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(rememberedTenant);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) { setLoading(false); return; }
    if (user.tenantId) { setSelectedTenantId(user.tenantId); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.listTenants().then((list) => {
      if (cancelled) return;
      setTenants(list);
      setSelectedTenantId((current) => (current && list.some((t) => t.id === current) ? current : (list[0]?.id ?? null)));
    }).catch((e: unknown) => {
      if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't load your tenants.");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [api, user]);

  function selectTenant(id: string) {
    setSelectedTenantId(id);
    rememberTenant(id);
  }

  return <TenantContext.Provider value={{ tenants, selectedTenantId, selectTenant, loading, error }}>{children}</TenantContext.Provider>;
}

export function useSelectedTenant() {
  const ctx = useContext(TenantContext);
  if (!ctx) throw new Error("useSelectedTenant must be used inside a TenantProvider");
  return ctx;
}
