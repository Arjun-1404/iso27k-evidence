import { useState } from "react";
import { useApi } from "../api/ApiProvider";
import { ApiError } from "../api/client";
import { useApiQuery } from "../api/useApiQuery";
import { useCurrentAudit } from "../api/useCurrentAudit";
import { useSelectedTenant } from "../api/TenantProvider";
import { useAuth } from "../auth/AuthProvider";
import { AppShell } from "../components/AppShell";
import { StatusBadge } from "../components/StatusBadge";
import { RequirementEditor } from "../components/RequirementEditor";
import { ControlDetailDrawer } from "../components/ControlDetailDrawer";
import { BulkAssign } from "../components/BulkAssign";
import { AuditCyclePicker, CAN_START_CYCLE } from "../components/AuditCyclePicker";
import { AuditCycleLock, CAN_CLOSE_CYCLE } from "../components/AuditCycleLock";
import type { ControlSummary, FileCategory } from "../api/types";

const AUDITOR_WRITE_ROLES = new Set(["org_admin", "lead_auditor"]);
const REMIND_ROLES = new Set(["org_admin", "lead_auditor", "auditor"]);
const REVIEW_ROLES = new Set(["org_admin", "lead_auditor", "auditor"]);
const ASSIGN_ROLES = new Set(["org_admin", "lead_auditor"]);

function ActionCell({ control, canRemind, canReview, onOpen, onRemind }: {
  control: ControlSummary; canRemind: boolean; canReview: boolean; onOpen: () => void; onRemind: () => void;
}) {
  if (!control.applicable) return <span className="text-gray-300">–</span>;
  if (control.status === "accepted") return <span className="text-green-700 text-xs font-semibold">✓ Done</span>;
  const needsEvidence = control.status === "not_started" || control.status === "awaiting_evidence" || control.status === "rejected";
  const canDecide = canReview && (control.status === "submitted" || control.status === "under_review");
  return (
    <div className="flex gap-1.5">
      {canDecide && <button onClick={onOpen} className="rounded-md bg-teal-50 text-teal-700 border border-teal-200 px-2 py-1 text-xs font-semibold">Review</button>}
      {canRemind && needsEvidence && <button onClick={onRemind} className="rounded-md border border-gray-300 px-2 py-1 text-xs font-semibold">Remind</button>}
      {!canDecide && !(canRemind && needsEvidence) && <button onClick={onOpen} className="text-xs text-gray-400">View</button>}
    </div>
  );
}

export function ControlsPage() {
  const api = useApi();
  const { user } = useAuth();
  const { tenants, selectedTenantId, selectTenant } = useSelectedTenant();
  const { data: audit, audits, select: selectAudit, refetch: refetchAudits } = useCurrentAudit(selectedTenantId);
  const { data: controls, loading, error, refetch } = useApiQuery(
    (signal) => (audit ? api.listControls(audit.id, signal) : Promise.resolve(null)),
    [audit?.id],
  );
  const [editing, setEditing] = useState<ControlSummary | null>(null);
  const [detail, setDetail] = useState<ControlSummary | null>(null);
  const [remindedIds, setRemindedIds] = useState<Set<string>>(new Set());

  const role = user?.role ?? "";
  // A closed audit cycle can be looked at but not changed: every way of changing something is taken away.
  const closed = audit?.status === "closed";
  const canEditRequirement = AUDITOR_WRITE_ROLES.has(role) && !closed;
  const canRemind = REMIND_ROLES.has(role) && !closed;
  const canReview = REVIEW_ROLES.has(role) && !closed;
  const canAssign = ASSIGN_ROLES.has(role) && !closed;

  const [remindError, setRemindError] = useState<string | null>(null);
  async function remind(control: ControlSummary) {
    setRemindError(null);
    try {
      await api.remind(control.id);
      setRemindedIds((s) => new Set(s).add(control.id));
    } catch (e) {
      // A rate-limit or "not outstanding" response just means the button does nothing further; no crash.
      // A mail-server failure is different: nothing was sent and nothing was recorded, so say so.
      if (e instanceof ApiError && e.code === "EMAIL_DELIVERY_FAILED") {
        setRemindError(`The reminder for ${control.controlRef} was not sent because the email could not be delivered. Nothing was recorded, so you can try again.`);
      } else if (e instanceof ApiError && e.code === "AUDIT_CLOSED") {
        // Closed by someone else since this page loaded: say so, and bring the page up to date.
        setRemindError(e.message);
        refetchAudits();
      }
    }
  }

  return (
    <AppShell>
      {tenants.length > 0 && (
        <div className="flex flex-wrap items-center justify-end gap-x-6 gap-y-2 border-b border-gray-200 bg-white px-4 sm:px-8 py-3">
          {selectedTenantId && (
            <AuditCyclePicker tenantId={selectedTenantId} audits={audits} current={audit} canCreate={CAN_START_CYCLE.has(role)}
              onSelect={selectAudit} onCreated={(a) => { selectAudit(a.id); refetchAudits(); }} />
          )}
          <div className="flex items-center gap-2">
            <label htmlFor="tenant" className="text-xs text-gray-500">Tenant</label>
            <select id="tenant" value={selectedTenantId ?? ""} onChange={(e) => selectTenant(e.target.value)} className="rounded-lg border border-gray-300 text-sm px-2 py-1">
              {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
        </div>
      )}
      {remindError && <p role="alert" className="mx-8 mt-4 text-sm text-red-600">{remindError}</p>}
      <div className="p-8">
        <h1 className="text-xl font-semibold mb-1">Controls</h1>
        <p className="text-sm text-gray-500 mb-6">{audit?.name ?? "Loading…"}</p>

        {audit && (
          <AuditCycleLock key={`lock-${audit.id}`} audit={audit} canManage={CAN_CLOSE_CYCLE.has(role)}
            notAccepted={(controls ?? []).filter((c) => c.applicable && c.status !== "accepted").length}
            onChanged={() => refetchAudits()} />
        )}

        {loading && <p className="text-sm text-gray-500">Loading…</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}

        {controls && canAssign && audit && selectedTenantId && <BulkAssign key={audit.id} auditId={audit.id} tenantId={selectedTenantId} controls={controls} />}

        {controls && (
          <div className="overflow-x-auto rounded-xl">
          <table className="w-full min-w-[44rem] text-sm border-separate border-spacing-0 rounded-xl overflow-hidden border border-gray-200 bg-white">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="text-left font-semibold px-4 py-2">ID</th>
                <th className="text-left font-semibold px-4 py-2">Control</th>
                <th className="text-left font-semibold px-4 py-2">Evidence required</th>
                <th className="text-left font-semibold px-4 py-2">Applicable</th>
                <th className="text-left font-semibold px-4 py-2">Files</th>
                <th className="text-left font-semibold px-4 py-2">Status</th>
                <th className="text-left font-semibold px-4 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {controls.map((c) => (
                <tr key={c.id} className="border-t border-gray-100 align-top">
                  <td className="px-4 py-2 font-semibold">{c.controlRef}</td>
                  <td className="px-4 py-2 max-w-[180px]">{c.title}</td>
                  <td className="px-4 py-2 max-w-[260px] text-gray-600">
                    {c.effectiveEvidence}
                    {canEditRequirement && (
                      <button aria-label={`Edit evidence required for ${c.controlRef}`} onClick={() => setEditing(c)} className="ml-2 text-teal-600 hover:text-teal-800">✎</button>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <span className={`text-xs font-semibold ${c.applicable ? "text-green-700" : "text-gray-400"}`}>{c.applicable ? "Yes" : "No"}</span>
                  </td>
                  <td className="px-4 py-2 text-gray-500">{c.applicable ? `${c.fileCount} file${c.fileCount === 1 ? "" : "s"}` : "–"}</td>
                  <td className="px-4 py-2"><StatusBadge status={c.status} na={!c.applicable} /></td>
                  <td className="px-4 py-2">
                    <ActionCell
                      control={c}
                      canRemind={canRemind && !remindedIds.has(c.id)}
                      canReview={canReview}
                      onOpen={() => setDetail(c)}
                      onRemind={() => remind(c)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {editing && (
        <RequirementEditor
          control={editing}
          onClose={() => setEditing(null)}
          onSave={async (text, category, maxFiles) => {
            const fileSpec: { types: FileCategory[]; maxFiles: number } = { types: [category], maxFiles };
            await api.updateRequirement(editing.id, { evidenceText: text, fileSpec });
            refetch();
          }}
          onResetToDefault={async () => {
            await api.updateRequirement(editing.id, { resetToDefault: true });
            refetch();
            setEditing(null);
          }}
        />
      )}
      {detail && (
        <ControlDetailDrawer control={detail} canReview={canReview} readOnly={closed} assignTenantId={ASSIGN_ROLES.has(role) ? selectedTenantId : null} onClose={() => setDetail(null)} onChanged={refetch} />
      )}
    </AppShell>
  );
}
