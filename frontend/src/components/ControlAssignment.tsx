import { useState } from "react";
import { useApi } from "../api/ApiProvider";
import { ApiError } from "../api/client";
import { useApiQuery } from "../api/useApiQuery";
import type { ControlSummary } from "../api/types";
import { canBeAssigned, personLabel } from "./assignment";

/**
 * Who a control is assigned to, with the means to change it. A client's contributor only sees the controls assigned to
 * them, so without this nobody but the client's leads can see any work to do.
 */
export function ControlAssignment({ control, tenantId, readOnly = false }: {
  control: ControlSummary; tenantId: string;
  /** A closed audit cycle: show who it is assigned to, but offer no way to change it. */
  readOnly?: boolean;
}) {
  const api = useApi();
  const assignees = useApiQuery((signal) => api.listControlAssignees(control.id, signal), [control.id]);
  const people = useApiQuery((signal) => api.listTenantUsers(tenantId, signal), [tenantId]);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const assigned = new Set((assignees.data ?? []).map((a) => a.userId));
  const candidates = (people.data ?? []).filter((u) => canBeAssigned(u) && !assigned.has(u.id));

  async function change(action: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await action(); setPick(""); assignees.refetch(); } catch (e) {
      setError(e instanceof ApiError ? e.message : "That didn't work. Please try again.");
    } finally { setBusy(false); }
  }

  return (
    <section aria-label="Assigned to" className="mb-4">
      <h3 className="text-xs font-semibold text-gray-500 mb-1">Assigned to</h3>
      <p className="text-xs text-gray-400 mb-2">
        {readOnly ? "This audit cycle is closed, so assignments can't be changed." : "Contributors only see the controls assigned to them. Client leads see every control."}
      </p>
      {assignees.error && <p role="alert" className="text-sm text-red-600 mb-2">{assignees.error}</p>}
      <ul className="space-y-1 mb-2">
        {(assignees.data ?? []).map((a) => (
          <li key={a.userId} className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-1.5 text-sm">
            <span className="truncate">{personLabel(a)}</span>
            {!readOnly && (
              <button type="button" disabled={busy} onClick={() => change(() => api.unassignControl(control.id, a.userId))}
                aria-label={`Remove ${a.email}`} className="text-xs text-red-700 disabled:opacity-50">Remove</button>
            )}
          </li>
        ))}
        {assignees.data && assignees.data.length === 0 && <li className="text-sm text-gray-400">No one yet.</li>}
      </ul>
      {error && <p role="alert" className="text-sm text-red-600 mb-2">{error}</p>}
      {people.error && <p role="alert" className="text-sm text-red-600 mb-2">{people.error}</p>}
      {!readOnly && people.data && candidates.length === 0 && <p className="text-xs text-gray-400">{assigned.size > 0 ? "Everyone who can be assigned already is." : "There is no one to assign yet. Invite the client's people under Users."}</p>}
      {!readOnly && candidates.length > 0 && (
        <div className="flex gap-2">
          <label htmlFor={`assign-${control.id}`} className="sr-only">Person to assign</label>
          <select id={`assign-${control.id}`} value={pick} onChange={(e) => setPick(e.target.value)} className="flex-1 min-w-0 rounded-lg border border-gray-300 text-sm px-2 py-1.5">
            <option value="">Choose a person…</option>
            {candidates.map((u) => <option key={u.id} value={u.id}>{personLabel(u)}</option>)}
          </select>
          <button type="button" disabled={busy || !pick} onClick={() => change(() => api.assignControl(control.id, pick))}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-semibold disabled:opacity-50">Assign</button>
        </div>
      )}
    </section>
  );
}
