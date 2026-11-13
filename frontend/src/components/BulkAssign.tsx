import { useState } from "react";
import { useApi } from "../api/ApiProvider";
import { ApiError } from "../api/client";
import { useApiQuery } from "../api/useApiQuery";
import type { ControlSummary } from "../api/types";
import { canBeAssigned, personLabel } from "./assignment";

const ALL = "__all__";

/**
 * Gives one person a whole section of controls (or every applicable one) in a single step, instead of control by
 * control. Only controls that apply to the client are offered: a control marked not applicable needs no evidence.
 */
export function BulkAssign({ auditId, tenantId, controls }: { auditId: string; tenantId: string; controls: ControlSummary[] }) {
  const api = useApi();
  const people = useApiQuery((signal) => api.listTenantUsers(tenantId, signal), [tenantId]);
  const [person, setPerson] = useState("");
  const [scope, setScope] = useState(ALL);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const applicable = controls.filter((c) => c.applicable);
  const sections = [...new Set(applicable.map((c) => c.section))];
  const chosen = scope === ALL ? applicable : applicable.filter((c) => c.section === scope);
  const candidates = (people.data ?? []).filter(canBeAssigned);

  async function assign() {
    setBusy(true); setMessage(null);
    try {
      const { assigned } = await api.assignControlsBulk(auditId, person, chosen.map((c) => c.id));
      const who = candidates.find((u) => u.id === person);
      const already = chosen.length - assigned;
      setMessage({
        ok: true,
        text: `${assigned} control${assigned === 1 ? "" : "s"} assigned to ${who ? personLabel(who) : "them"}${already > 0 ? ` (${already} already were)` : ""}.`,
      });
    } catch (e) {
      setMessage({ ok: false, text: e instanceof ApiError ? e.message : "That didn't work. Please try again." });
    } finally { setBusy(false); }
  }

  if (people.data && candidates.length === 0) {
    return <p className="text-sm text-gray-500 mb-6">To hand controls to the client's people, first invite them under <strong>Users</strong>.</p>;
  }
  return (
    <section aria-label="Assign controls" className="rounded-xl border border-gray-200 bg-white p-4 mb-6">
      <h2 className="text-sm font-semibold mb-1">Assign controls</h2>
      <p className="text-xs text-gray-500 mb-3">Contributors only see the controls assigned to them. Pick a person and what to give them.</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-auto">
          <label htmlFor="bulk-person" className="block text-xs font-semibold text-gray-500 mb-1">Person</label>
          <select id="bulk-person" value={person} onChange={(e) => setPerson(e.target.value)} className="rounded-lg border border-gray-300 text-sm px-2 py-1.5 min-w-56 w-full sm:w-auto">
            <option value="">Choose a person…</option>
            {candidates.map((u) => <option key={u.id} value={u.id}>{personLabel(u)}</option>)}
          </select>
        </div>
        <div className="w-full sm:w-auto">
          <label htmlFor="bulk-scope" className="block text-xs font-semibold text-gray-500 mb-1">Controls</label>
          <select id="bulk-scope" value={scope} onChange={(e) => setScope(e.target.value)} className="rounded-lg border border-gray-300 text-sm px-2 py-1.5 min-w-56 w-full sm:w-auto">
            <option value={ALL}>All applicable controls ({applicable.length})</option>
            {sections.map((s) => <option key={s} value={s}>{s} ({applicable.filter((c) => c.section === s).length})</option>)}
          </select>
        </div>
        <button type="button" disabled={busy || !person || chosen.length === 0} onClick={assign}
          className="rounded-lg bg-teal-600 text-white px-4 py-1.5 text-sm font-semibold disabled:opacity-50">{busy ? "Assigning…" : "Assign"}</button>
      </div>
      {message && <p role={message.ok ? "status" : "alert"} className={`mt-3 text-sm ${message.ok ? "text-green-700" : "text-red-600"}`}>{message.text}</p>}
    </section>
  );
}
