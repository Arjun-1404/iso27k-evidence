import { useState } from "react";
import { useApi } from "../api/ApiProvider";
import { useApiQuery } from "../api/useApiQuery";
import { useCurrentAudit } from "../api/useCurrentAudit";
import { useAuth } from "../auth/AuthProvider";
import { AppShell } from "../components/AppShell";
import { StatusBadge } from "../components/StatusBadge";
import { UploadModal } from "../components/UploadModal";
import { ControlDetailDrawer } from "../components/ControlDetailDrawer";
import { AuditCyclePicker } from "../components/AuditCyclePicker";
import { AuditCycleLock } from "../components/AuditCycleLock";
import { ApiError } from "../api/client";
import type { ControlSummary } from "../api/types";

export function MyControlsPage() {
  const api = useApi();
  const { user } = useAuth();
  const { data: audit, audits, select: selectAudit, refetch: refetchAudits } = useCurrentAudit(user?.tenantId ?? null);
  const { data: controls, loading, error, refetch } = useApiQuery(
    (signal) => (audit ? api.listControls(audit.id, signal) : Promise.resolve(null)),
    [audit?.id],
  );
  const [uploading, setUploading] = useState<ControlSummary | null>(null);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ControlSummary | null>(null);
  // A client lead sees every control and decides who does which; a contributor sees only their own.
  const isLead = user?.role === "tenant_lead";
  // A closed audit cycle can be looked at but not changed.
  const closed = audit?.status === "closed";
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function submit(c: ControlSummary) {
    setSubmittingId(c.id);
    setSubmitError(null);
    try {
      await api.submitControl(c.id);
      refetch();
    } catch (e) {
      setSubmitError(e instanceof ApiError ? e.message : "That didn't work. Please try again.");
      if (e instanceof ApiError && e.code === "AUDIT_CLOSED") refetchAudits(); // closed since this page loaded
    } finally {
      setSubmittingId(null);
    }
  }

  const visible = (controls ?? []).filter((c) => c.applicable);

  return (
    <AppShell>
      <div className="p-8 max-w-3xl">
        {user?.tenantId && (
          <div className="mb-4">
            <AuditCyclePicker tenantId={user.tenantId} audits={audits} current={audit} canCreate={false} onSelect={selectAudit} onCreated={() => {}} />
          </div>
        )}
        <h1 className="text-xl font-semibold mb-1">My controls</h1>
        <p className="text-sm text-gray-500 mb-6">{visible.length} applicable to your organisation.</p>
        {audit && <AuditCycleLock key={audit.id} audit={audit} canManage={false} />}
        {submitError && <p role="alert" className="mb-4 text-sm text-red-600">{submitError}</p>}

        {loading && <p className="text-sm text-gray-500">Loading…</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}
        {!loading && !error && controls && visible.length === 0 && <p className="text-sm text-gray-500">Nothing assigned yet.</p>}

        <ul className="space-y-3">
          {visible.map((c) => {
            const canUpload = !closed && (c.status === "not_started" || c.status === "awaiting_evidence" || c.status === "rejected");
            const canSubmit = c.fileCount > 0 && canUpload;
            return (
              <li key={c.id} className="rounded-xl border border-gray-200 bg-white p-4 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4">
                <div className="min-w-0">
                  <div className="font-semibold text-sm">{c.controlRef} {c.title}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{c.effectiveEvidence}</div>
                  {c.dueDate && <div className="text-xs text-amber-700 mt-1">Due {c.dueDate}</div>}
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
                  <StatusBadge status={c.status} />
                  {canUpload && (
                    <button onClick={() => setUploading(c)} className="rounded-lg bg-teal-600 text-white px-3 py-1.5 text-xs font-semibold">
                      Upload
                    </button>
                  )}
                  {isLead && (
                    <button onClick={() => setDetail(c)} aria-label={`Details and assignment for ${c.controlRef}`} className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold">
                      {closed ? "View" : "Assign"}
                    </button>
                  )}
                  {canSubmit && (
                    <button onClick={() => submit(c)} disabled={submittingId === c.id} className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold disabled:opacity-50">
                      Submit
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {detail && user?.tenantId && (
        <ControlDetailDrawer control={detail} canReview={false} readOnly={closed} assignTenantId={user.tenantId} onClose={() => setDetail(null)} onChanged={refetch} />
      )}
      {uploading && (
        <UploadModal
          control={uploading}
          onClose={() => setUploading(null)}
          onUploaded={() => { refetch(); }}
        />
      )}
    </AppShell>
  );
}
