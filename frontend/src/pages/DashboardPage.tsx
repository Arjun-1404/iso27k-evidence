import { useApi } from "../api/ApiProvider";
import { useApiQuery } from "../api/useApiQuery";
import { useCurrentAudit } from "../api/useCurrentAudit";
import { useSelectedTenant } from "../api/TenantProvider";
import { useAuth } from "../auth/AuthProvider";
import { AppShell } from "../components/AppShell";
import { AuditCyclePicker, CAN_START_CYCLE } from "../components/AuditCyclePicker";
import { AuditCycleLock } from "../components/AuditCycleLock";
import { useCallback } from "react";
import type { Dashboard } from "../api/types";

function StatTile({ label, value, tone = "text-gray-900" }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="text-xs font-semibold text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${tone}`}>{value}</div>
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  not_started: "Not started", awaiting_evidence: "Awaiting evidence", submitted: "Submitted",
  under_review: "Under review", accepted: "Accepted", rejected: "Rejected",
};

function DashboardBody({ dashboard, title }: { dashboard: Dashboard; title: string }) {
  return (
    <div className="p-8 max-w-5xl">
      <h1 className="text-xl font-semibold mb-1">{title}</h1>
      <p className="text-sm text-gray-500 mb-6">
        {dashboard.total} items · {dashboard.notApplicable} marked not applicable
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
        <StatTile label="Accepted" value={dashboard.accepted} tone="text-green-700" />
        <StatTile label="Applicable" value={dashboard.applicable} />
        <StatTile label="Overdue" value={dashboard.overdue} tone={dashboard.overdue > 0 ? "text-red-700" : undefined} />
        <StatTile label="Completion" value={dashboard.completionPct} tone="text-teal-700" />
        <StatTile label="Total" value={dashboard.total} />
      </div>
      <div className="rounded-xl border border-gray-200 bg-white p-5 mb-6">
        <h2 className="text-sm font-semibold mb-3">Status of applicable controls</h2>
        <ul className="space-y-1 text-sm">
          {dashboard.byStatus.map((s) => (
            <li key={s.status} className="flex justify-between">
              <span>{STATUS_LABEL[s.status] ?? s.status}</span>
              <span className="font-semibold">{s.count}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="text-sm font-semibold mb-3">Progress by section</h2>
        <ul className="space-y-2 text-sm">
          {dashboard.bySection.map((s) => (
            <li key={s.section} className="flex items-center gap-3">
              <span className="w-56 shrink-0 truncate">{s.section}</span>
              <div className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden">
                <div className="h-full bg-teal-600" style={{ width: `${s.applicable ? (100 * s.accepted) / s.applicable : 0}%` }} />
              </div>
              <span className="w-16 text-right text-gray-500">{s.accepted} of {s.applicable}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function DashboardPage() {
  const api = useApi();
  const { user } = useAuth();
  const { tenants, selectedTenantId, selectTenant, loading: tenantsLoading, error: tenantsError } = useSelectedTenant();
  const { data: audit, audits, select: selectAudit, refetch: refetchAudits, loading: auditLoading, error: auditError } = useCurrentAudit(selectedTenantId);

  const loadDashboard = useCallback((signal: AbortSignal) => {
    if (!audit) return Promise.resolve(null);
    return api.getDashboard(audit.id, signal);
  }, [api, audit]);
  const { data: dashboard, loading: dashboardLoading, error: dashboardError } = useApiQuery(loadDashboard, [audit?.id]);

  const isAuditorSide = !user?.tenantId;
  const tenantName = tenants.find((t) => t.id === selectedTenantId)?.name;

  return (
    <AppShell>
      {isAuditorSide && tenants.length > 0 && (
        <div className="flex flex-wrap items-center justify-end gap-x-6 gap-y-2 border-b border-gray-200 bg-white px-4 sm:px-8 py-3">
          {selectedTenantId && (
            <AuditCyclePicker tenantId={selectedTenantId} audits={audits} current={audit} canCreate={CAN_START_CYCLE.has(user?.role ?? "")}
              onSelect={selectAudit} onCreated={(a) => { selectAudit(a.id); refetchAudits(); }} />
          )}
          <div className="flex items-center gap-2">
            <label htmlFor="tenant" className="text-xs text-gray-500">Tenant</label>
            <select
              id="tenant"
              value={selectedTenantId ?? ""}
              onChange={(e) => selectTenant(e.target.value)}
              className="rounded-lg border border-gray-300 text-sm px-2 py-1"
            >
              {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
        </div>
      )}
      {(tenantsLoading || auditLoading || dashboardLoading) && <p className="p-8 text-sm text-gray-500">Loading…</p>}
      {(tenantsError || auditError || dashboardError) && <p className="p-8 text-sm text-red-600">{tenantsError ?? auditError ?? dashboardError}</p>}
      {!tenantsLoading && !tenantsError && !auditLoading && !audit && (
        <p className="p-8 text-sm text-gray-500">No audit has been set up for this tenant yet.</p>
      )}
      {audit?.status === "closed" && <div className="px-8 pt-8"><AuditCycleLock key={audit.id} audit={audit} canManage={false} /></div>}
      {dashboard && <DashboardBody dashboard={dashboard} title={tenantName ? `${tenantName} · Dashboard` : "Dashboard"} />}
    </AppShell>
  );
}
