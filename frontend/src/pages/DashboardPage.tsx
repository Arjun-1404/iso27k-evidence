import { useApi } from "../api/ApiProvider";
import { useApiQuery } from "../api/useApiQuery";
import { useCurrentAudit } from "../api/useCurrentAudit";
import { useSelectedTenant } from "../api/TenantProvider";
import { useAuth } from "../auth/AuthProvider";
import { AppShell } from "../components/AppShell";
import { AuditCyclePicker, CAN_START_CYCLE } from "../components/AuditCyclePicker";
import { AuditCycleLock } from "../components/AuditCycleLock";
import { ReadinessRing } from "../components/dashboard/ReadinessRing";
import { NeedsAttention } from "../components/dashboard/NeedsAttention";
import { StatusBar } from "../components/dashboard/StatusBar";
import { ControlHeatmap } from "../components/dashboard/ControlHeatmap";
import { SectionMeters } from "../components/dashboard/SectionMeters";
import { useCallback, type ReactNode } from "react";
import type { ControlSummary, Dashboard } from "../api/types";

function Card({ title, children, className = "" }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={`rounded-xl border border-gray-200 bg-white p-5 ${className}`}>
      {title && <h2 className="mb-3 text-sm font-semibold">{title}</h2>}
      {children}
    </section>
  );
}

function DashboardBody({ dashboard, title, auditId, auditorSide }: { dashboard: Dashboard; title: string; auditId: string; auditorSide: boolean }) {
  const api = useApi();
  // The tiles need the controls themselves. Some people are never shown them (a dashboard-only role gets an empty list), and
  // for them the grid simply is not drawn; the numbers above it stand on their own.
  const { data: controls } = useApiQuery((signal) => api.listControls(auditId, signal), [auditId]);
  const hrefFor = (c: ControlSummary) => {
    if (auditorSide) return `/controls?control=${c.id}`;
    return c.applicable ? `/my-controls?control=${c.id}` : null; // a client's own list does not show what is not applicable
  };

  return (
    <div className="p-4 sm:p-8 max-w-5xl">
      <h1 className="text-xl font-semibold mb-1">{title}</h1>
      <p className="text-sm text-gray-500 mb-6">
        {dashboard.total} items · {dashboard.notApplicable} marked not applicable
      </p>

      <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)] mb-4">
        <Card title="Audit readiness" className="flex flex-col">
          <div className="flex flex-1 items-center justify-center py-2">
            <ReadinessRing accepted={dashboard.accepted} applicable={dashboard.applicable} completionPct={dashboard.completionPct} />
          </div>
        </Card>
        <div className="grid gap-4 content-start">
          <Card title="Needs attention"><NeedsAttention dashboard={dashboard} auditorSide={auditorSide} /></Card>
          <Card title="Where the controls stand"><StatusBar byStatus={dashboard.byStatus} notApplicable={dashboard.notApplicable} /></Card>
        </div>
      </div>

      {controls && controls.length > 0 && (
        <div className="mb-4">
          <ControlHeatmap controls={controls} hrefFor={hrefFor} visibleOfTotal={dashboard.total} />
        </div>
      )}

      <Card title="Progress by section"><SectionMeters sections={dashboard.bySection} /></Card>
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
      {dashboard && audit && <DashboardBody dashboard={dashboard} auditId={audit.id} auditorSide={isAuditorSide} title={tenantName ? `${tenantName} · Dashboard` : "Dashboard"} />}
    </AppShell>
  );
}
