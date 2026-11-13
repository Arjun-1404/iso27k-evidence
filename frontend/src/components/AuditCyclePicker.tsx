import { useState } from "react";
import { useApi } from "../api/ApiProvider";
import { ApiError } from "../api/client";
import { useApiQuery } from "../api/useApiQuery";
import type { AuditSummary } from "../api/types";

/** Who may start a new audit cycle for a client (the database enforces the same). */
export const CAN_START_CYCLE = new Set(["org_admin", "lead_auditor"]);

const day = (iso: string) => iso.slice(0, 10);
const optionText = (a: AuditSummary) => `${a.name} · ${day(a.createdAt)}${a.status === "closed" ? " · closed" : ""}`;

function NewCycleForm({ tenantId, onCreated, onCancel }: { tenantId: string; onCreated: (a: AuditSummary) => void; onCancel: () => void }) {
  const api = useApi();
  const templates = useApiQuery((signal) => api.listTemplates(signal), []);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [typedName, setTypedName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const list = templates.data ?? [];
  const template = list.find((t) => t.id === templateId) ?? list.find((t) => t.isPlatformDefault) ?? list[0];
  // Suggest a name, but let the person type their own.
  const name = typedName ?? (template ? `${template.framework} audit ${new Date().getFullYear()}` : "");

  async function create() {
    if (!template) return;
    setBusy(true); setError(null);
    try {
      onCreated(await api.createAudit(tenantId, template.id, name.trim()));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "That didn't work. Please try again.");
      setBusy(false);
    }
  }

  return (
    <section aria-label="New audit cycle" className="rounded-xl border border-gray-200 bg-white p-4 mb-6 max-w-xl">
      <h2 className="text-sm font-semibold mb-1">New audit cycle</h2>
      <p className="text-xs text-gray-500 mb-3">
        Starts a fresh set of controls from the template, with its own folder in your storage. Earlier cycles and their
        evidence stay exactly as they are.
      </p>
      {templates.error && <p role="alert" className="text-sm text-red-600 mb-2">{templates.error}</p>}
      <div className="space-y-3">
        <div>
          <label htmlFor="cycle-template" className="block text-xs font-semibold text-gray-500 mb-1">Template</label>
          <select id="cycle-template" value={template?.id ?? ""} onChange={(e) => setTemplateId(e.target.value)} className="w-full rounded-lg border border-gray-300 text-sm px-2 py-1.5">
            {list.map((t) => <option key={t.id} value={t.id}>{t.name} (version {t.version})</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="cycle-name" className="block text-xs font-semibold text-gray-500 mb-1">Name</label>
          <input id="cycle-name" value={name} maxLength={200} onChange={(e) => setTypedName(e.target.value)} className="w-full rounded-lg border border-gray-300 text-sm px-2 py-1.5" />
        </div>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
      <div className="mt-4 flex gap-2">
        <button type="button" disabled={busy || !template || name.trim() === ""} onClick={create} className="rounded-lg bg-teal-600 text-white px-4 py-1.5 text-sm font-semibold disabled:opacity-50">
          {busy ? "Creating…" : "Create"}
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm font-semibold disabled:opacity-50">Cancel</button>
      </div>
    </section>
  );
}

/**
 * Chooses which of a client's audit cycles the page shows, and (for people allowed to) starts a new one.
 * Shows nothing when there is only one cycle and the person can't start another, since there is nothing to choose.
 */
export function AuditCyclePicker({ tenantId, audits, current, canCreate, onSelect, onCreated }: {
  tenantId: string;
  audits: AuditSummary[];
  current: AuditSummary | null;
  canCreate: boolean;
  onSelect: (auditId: string) => void;
  /** Called with the new cycle once it exists. */
  onCreated: (audit: AuditSummary) => void;
}) {
  const [creating, setCreating] = useState(false);
  if (audits.length <= 1 && !canCreate) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {audits.length > 0 && (
        <>
          <label htmlFor="audit-cycle" className="text-xs text-gray-500">Audit cycle</label>
          <select id="audit-cycle" value={current?.id ?? ""} onChange={(e) => onSelect(e.target.value)} className="rounded-lg border border-gray-300 text-sm px-2 py-1 max-w-64">
            {audits.map((a) => <option key={a.id} value={a.id}>{optionText(a)}</option>)}
          </select>
        </>
      )}
      {canCreate && !creating && (
        <button type="button" onClick={() => setCreating(true)} className="rounded-lg border border-gray-300 px-3 py-1 text-xs font-semibold">New audit cycle</button>
      )}
      {creating && (
        <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 p-8 overflow-auto" role="dialog" aria-label="New audit cycle form">
          <NewCycleForm tenantId={tenantId} onCancel={() => setCreating(false)} onCreated={(a) => { setCreating(false); onCreated(a); }} />
        </div>
      )}
    </div>
  );
}
