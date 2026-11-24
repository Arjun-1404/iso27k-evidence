import { useState } from "react";
import { useApi } from "../api/ApiProvider";
import { ApiError } from "../api/client";
import { useApiQuery } from "../api/useApiQuery";
import type { Tenant } from "../api/types";
import { personLabel } from "./assignment";
import { roleLabel } from "./roleLabels";

/**
 * Which of the firm's staff are assigned to a client. Only an organisation admin does this: a lead auditor, auditor or
 * read-only reviewer sees only the clients they've been assigned to (organisation admins see every client, so they are not listed).
 */
export function TenantAuditorsPanel({ tenant }: { tenant: Tenant }) {
  const api = useApi();
  const assigned = useApiQuery((signal) => api.listTenantAuditors(tenant.id, signal), [tenant.id]);
  const staff = useApiQuery((signal) => api.listOrgUsers(signal), []);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const have = new Set((assigned.data ?? []).map((a) => a.id));
  const candidates = (staff.data ?? []).filter((u) => u.role !== "org_admin" && u.status !== "disabled" && !have.has(u.id));

  async function change(action: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await action(); setPick(""); assigned.refetch(); }
    catch (e) { setError(e instanceof ApiError ? e.message : "That didn't work. Please try again."); }
    finally { setBusy(false); }
  }

  return (
    <section aria-label={`Auditors assigned to ${tenant.name}`} className="mt-3 border-t border-gray-100 pt-3">
      <h3 className="text-sm font-semibold mb-1">Auditors assigned to {tenant.name}</h3>
      <p className="text-xs text-gray-500 mb-3">These staff can see this client and its audits. Organisation admins always can.</p>
      {assigned.error && <p role="alert" className="text-sm text-red-600 mb-2">{assigned.error}</p>}
      {error && <p role="alert" className="text-sm text-red-600 mb-2">{error}</p>}
      <ul className="space-y-1 mb-3">
        {(assigned.data ?? []).map((a) => (
          <li key={a.id} className="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm">
            <span className="min-w-0 truncate">{personLabel(a)} <span className="text-xs text-gray-500 ml-1">{roleLabel(a.role)}{a.customRoleName ? ` · ${a.customRoleName}` : ""}</span></span>
            <button type="button" disabled={busy} onClick={() => change(() => api.unassignAuditor(tenant.id, a.id))} aria-label={`Remove ${a.email} from ${tenant.name}`} className="text-xs text-red-700 disabled:opacity-50">Remove</button>
          </li>
        ))}
        {assigned.data && assigned.data.length === 0 && <li className="text-sm text-gray-400">No one is assigned yet, so only organisation admins can see this client.</li>}
      </ul>
      {staff.data && candidates.length === 0 ? (
        <p className="text-xs text-gray-400">{have.size > 0 ? "Everyone who can be assigned already is." : "There are no auditors to assign yet. Invite them under Users."}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <select aria-label={`Auditor to assign to ${tenant.name}`} value={pick} onChange={(e) => setPick(e.target.value)} className="flex-1 min-w-[12rem] rounded-lg border border-gray-300 text-sm px-2 py-1.5">
            <option value="">Choose a person…</option>
            {candidates.map((u) => <option key={u.id} value={u.id}>{personLabel(u)} · {roleLabel(u.role)}</option>)}
          </select>
          <button type="button" disabled={busy || !pick} onClick={() => change(() => api.assignAuditor(tenant.id, pick))} className="rounded-lg bg-teal-600 text-white px-4 py-1.5 text-sm font-semibold disabled:opacity-50">Assign to {tenant.name}</button>
        </div>
      )}
    </section>
  );
}
