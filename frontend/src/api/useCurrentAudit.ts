import { useCallback, useState } from "react";
import { useApi } from "./ApiProvider";
import { useApiQuery } from "./useApiQuery";
import type { AuditSummary } from "./types";
import { ApiError } from "./client";

const keyFor = (tenantId: string) => `selectedAudit:${tenantId}`;

// Remembering the choice is a convenience only: private windows and blocked site data make storage throw, and the app
// must work exactly the same without it (it then just opens the newest cycle each time).
function remembered(tenantId: string | null): string | null {
  if (!tenantId) return null;
  try { return localStorage.getItem(keyFor(tenantId)); } catch { return null; }
}
function remember(tenantId: string | null, auditId: string) {
  if (!tenantId) return;
  try { localStorage.setItem(keyFor(tenantId), auditId); } catch { /* not remembered; nothing else depends on it */ }
}

/**
 * Most of the app works on one of a client's audit cycles at a time. This loads the client's cycles (newest first) and
 * picks the one to show: the one the person last chose for this client, or else the newest.
 *
 * If a client has no audit at all yet and the caller is on the auditor side, the first one is created automatically
 * from the platform's default template. A client-side user just sees "not set up yet".
 */
export function useCurrentAudit(tenantId: string | null) {
  const api = useApi();

  const load = useCallback(async (signal: AbortSignal): Promise<AuditSummary[]> => {
    if (!tenantId) return [];
    const existing = await api.listTenantAudits(tenantId, signal);
    if (existing.length > 0) return existing;
    let templates;
    try {
      templates = await api.listTemplates(signal);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) return []; // tenant-side caller: nothing to do
      throw e;
    }
    if (templates.length === 0) return [];
    const platformDefault = templates.find((t) => t.isPlatformDefault) ?? templates[0];
    return [await api.createAudit(tenantId, platformDefault.id, `${platformDefault.framework} audit`)];
  }, [api, tenantId]);

  const list = useApiQuery(load, [tenantId]);

  // The choice belongs to one client; when the client changes, it is read afresh from what was remembered for that one.
  const [picked, setPicked] = useState<{ tenantId: string | null; auditId: string | null }>({ tenantId, auditId: remembered(tenantId) });
  const chosen = picked.tenantId === tenantId ? picked.auditId : remembered(tenantId);

  const audits = list.data ?? [];
  const current = list.data ? (audits.find((a) => a.id === chosen) ?? audits[0] ?? null) : null;

  const select = useCallback((auditId: string) => {
    setPicked({ tenantId, auditId });
    remember(tenantId, auditId);
  }, [tenantId]);

  return { data: current, audits, loading: list.loading, error: list.error, refetch: list.refetch, select };
}
