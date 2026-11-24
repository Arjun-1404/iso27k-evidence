import { useState } from "react";
import { useApi } from "../api/ApiProvider";
import { ApiError } from "../api/client";
import { useApiQuery } from "../api/useApiQuery";
import { useAuth } from "../auth/AuthProvider";
import { AppShell } from "../components/AppShell";
import { AbilityChecklist, deniedFrom, keptFrom } from "../components/AbilityChecklist";
import { ROLE_HINT, roleLabel } from "../components/roleLabels";
import type { BaseRole, CustomRole, Permission, Role, RoleCatalog } from "../api/types";

const BUILT_IN: Role[] = ["org_admin", "lead_auditor", "auditor", "read_only", "dashboard_only", "tenant_lead", "contributor", "viewer", "tenant_dashboard"];

interface Draft { name: string; description: string; base: BaseRole; kept: Set<Permission> }

function RoleForm({ catalog, initial, lockedBase, submitLabel, onSubmit, onCancel, idPrefix }: {
  catalog: RoleCatalog;
  initial: Draft;
  /** Editing: the base role can't be changed (people with the role are tied to it). */
  lockedBase: boolean;
  submitLabel: string;
  onSubmit: (d: Draft) => Promise<void>;
  onCancel?: () => void;
  idPrefix: string;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true); setError(null);
    try { await onSubmit(draft); }
    catch (e) { setError(e instanceof ApiError ? e.message : "That didn't work. Please try again."); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        <div className="flex-1 min-w-[12rem]">
          <label htmlFor={`${idPrefix}-name`} className="block text-xs font-semibold text-gray-500 mb-1">Name</label>
          <input id={`${idPrefix}-name`} value={draft.name} maxLength={60} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="For example: Junior auditor" className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm" />
        </div>
        <div>
          <label htmlFor={`${idPrefix}-base`} className="block text-xs font-semibold text-gray-500 mb-1">Based on</label>
          <select id={`${idPrefix}-base`} value={draft.base} disabled={lockedBase}
            onChange={(e) => { const base = e.target.value as BaseRole; setDraft({ ...draft, base, kept: keptFrom(catalog, base, []) }); }}
            className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm">
            {catalog.baseRoles.map((b) => <option key={b.role} value={b.role}>{roleLabel(b.role)} ({b.side === "firm" ? "your staff" : "client's people"})</option>)}
          </select>
        </div>
      </div>
      <div>
        <label htmlFor={`${idPrefix}-desc`} className="block text-xs font-semibold text-gray-500 mb-1">Description (optional)</label>
        <input id={`${idPrefix}-desc`} value={draft.description} maxLength={500} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="What this role is for" className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm" />
      </div>
      <div>
        <p className="text-xs font-semibold text-gray-500 mb-1">What this role can do</p>
        <p className="text-xs text-gray-500 mb-2">Everything a {roleLabel(draft.base).toLowerCase()} can do is ticked. Untick what should be taken away. A custom role can never do more than the role it is based on.</p>
        <AbilityChecklist catalog={catalog} base={draft.base} kept={draft.kept} onChange={(kept) => setDraft({ ...draft, kept })} idPrefix={idPrefix} />
      </div>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button type="button" onClick={() => void submit()} disabled={busy || !draft.name.trim()} className="rounded-lg bg-teal-600 text-white px-4 py-1.5 text-sm font-semibold disabled:opacity-50">{busy ? "Saving…" : submitLabel}</button>
        {onCancel && <button type="button" onClick={onCancel} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm">Cancel</button>}
      </div>
    </div>
  );
}

export function RolesPage() {
  const api = useApi();
  const { user } = useAuth();
  const roles = useApiQuery((signal) => api.listRoles(signal), []);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [formKey, setFormKey] = useState(0);
  const isAdmin = user?.role === "org_admin";
  const catalog = roles.data?.catalog;

  async function remove(r: CustomRole) {
    setNotice(null);
    try {
      await api.deleteRole(r.id);
      setConfirmDelete(null);
      setNotice({ tone: "ok", text: `The role "${r.name}" was deleted.` });
      roles.refetch();
    } catch (e) {
      setConfirmDelete(null);
      setNotice({ tone: "error", text: e instanceof ApiError ? e.message : "Could not delete that role." });
    }
  }

  return (
    <AppShell>
      <div className="p-4 sm:p-8 max-w-3xl space-y-8">
        <header>
          <h1 className="text-xl font-semibold mb-1">Roles</h1>
          <p className="text-sm text-gray-500">
            Every person has one of the built-in roles. When one of them can do too much, make a custom role: the same role with some abilities taken away, and a name of your own. Give it to people from <strong>Users</strong> (your staff) or from <strong>Tenants → People</strong> (a client's people).
          </p>
        </header>

        {!isAdmin && <p role="status" className="text-sm text-amber-700">Only an organisation admin can create or change custom roles.</p>}
        {notice && <p role={notice.tone === "error" ? "alert" : "status"} className={`text-sm ${notice.tone === "error" ? "text-red-600" : "text-green-700"}`}>{notice.text}</p>}
        {roles.error && <p role="alert" className="text-sm text-red-600">{roles.error}</p>}

        <section aria-label="Custom roles">
          <h2 className="text-lg font-semibold mb-3">Custom roles</h2>
          {roles.loading && <p className="text-sm text-gray-500">Loading…</p>}
          <ul className="space-y-3 mb-4">
            {(roles.data?.custom ?? []).map((r) => (
              <li key={r.id} className="rounded-xl border border-gray-200 bg-white p-4">
                <div className="flex flex-wrap items-start justify-between gap-2 mb-1">
                  <div>
                    <h3 className="text-sm font-semibold">{r.name}</h3>
                    <p className="text-xs text-gray-500">Based on {roleLabel(r.baseRole).toLowerCase()} · {r.memberCount === 1 ? "1 person has it" : `${r.memberCount} people have it`}</p>
                  </div>
                  {isAdmin && editing !== r.id && (
                    <div className="flex items-center gap-3">
                      <button type="button" onClick={() => { setEditing(r.id); setConfirmDelete(null); }} aria-label={`Edit ${r.name}`} className="text-xs font-semibold text-teal-700">Edit</button>
                      {confirmDelete === r.id ? (
                        <>
                          <button type="button" onClick={() => void remove(r)} className="text-xs font-semibold text-red-700">Confirm delete</button>
                          <button type="button" onClick={() => setConfirmDelete(null)} className="text-xs text-gray-500">Cancel</button>
                        </>
                      ) : (
                        <button type="button" onClick={() => setConfirmDelete(r.id)} aria-label={`Delete ${r.name}`} className="text-xs text-gray-500">Delete</button>
                      )}
                    </div>
                  )}
                </div>
                {r.description && <p className="text-sm text-gray-600 mb-2">{r.description}</p>}
                {catalog && editing === r.id ? (
                  <RoleForm
                    key={`${r.id}-${r.name}-${r.denied.join()}`} idPrefix={`edit-${r.id}`} catalog={catalog} lockedBase submitLabel="Save changes"
                    initial={{ name: r.name, description: r.description ?? "", base: r.baseRole, kept: keptFrom(catalog, r.baseRole, r.denied) }}
                    onCancel={() => setEditing(null)}
                    onSubmit={async (d) => {
                      await api.updateRole(r.id, { name: d.name.trim(), description: d.description.trim() || null, denied: deniedFrom(catalog, r.baseRole, d.kept) });
                      setEditing(null); setNotice({ tone: "ok", text: `The role "${d.name.trim()}" was saved. It applies to everyone who has it straight away.` }); roles.refetch();
                    }}
                  />
                ) : catalog ? (
                  <p className="text-sm">
                    {r.denied.length === 0
                      ? <span className="text-gray-500">Nothing is taken away: the same as {roleLabel(r.baseRole).toLowerCase()}.</span>
                      : <><span className="text-gray-500">Can't: </span>{r.denied.map((p) => catalog.permissions.find((x) => x.key === p)?.label ?? p).join(", ")}.</>}
                  </p>
                ) : null}
              </li>
            ))}
            {roles.data && roles.data.custom.length === 0 && <li className="text-sm text-gray-500">No custom roles yet.</li>}
          </ul>

          {isAdmin && catalog && (
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <h3 className="text-sm font-semibold mb-3">New custom role</h3>
              <RoleForm
                key={formKey} idPrefix="new" catalog={catalog} lockedBase={false} submitLabel="Create role"
                initial={{ name: "", description: "", base: "auditor", kept: keptFrom(catalog, "auditor", []) }}
                onSubmit={async (d) => {
                  await api.createRole({ name: d.name.trim(), description: d.description.trim() || null, baseRole: d.base, denied: deniedFrom(catalog, d.base, d.kept) });
                  setFormKey((k) => k + 1); setNotice({ tone: "ok", text: `The role "${d.name.trim()}" was created.` }); roles.refetch();
                }}
              />
            </div>
          )}
        </section>

        <section aria-label="Built-in roles">
          <h2 className="text-lg font-semibold mb-3">Built-in roles</h2>
          <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white text-sm">
            {BUILT_IN.map((r) => (
              <li key={r} className="flex flex-wrap gap-x-4 gap-y-0.5 px-4 py-2.5">
                <span className="w-44 shrink-0 font-semibold">{roleLabel(r)}</span>
                <span className="flex-1 min-w-[14rem] text-gray-600">{ROLE_HINT[r]}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </AppShell>
  );
}
