import { useState } from "react";
import { useApi } from "../api/ApiProvider";
import { ApiError } from "../api/client";
import { useApiQuery } from "../api/useApiQuery";
import { useAccess } from "../api/AccessProvider";
import { useAuth } from "../auth/AuthProvider";
import type { OrgUser, Tenant } from "../api/types";
import { RoleSelect, builtInValue, parseRoleValue, valueOfUser } from "./RoleSelect";
import { CLIENT_ROLES, isFirmBase, roleLabel } from "./roleLabels";

/**
 * A client's people, managed by the audit firm: who has been invited, what each of them can do, and the means to invite
 * more. Inviting happens here so that the firm decides who the client's people are and can limit what each may do with a
 * custom role. (A client's own lead can still add contributors and viewers; the firm can switch that off with a role.)
 */
export function TenantPeoplePanel({ tenant }: { tenant: Tenant }) {
  const api = useApi();
  const { user: me } = useAuth();
  const { can } = useAccess();
  const people = useApiQuery((signal) => api.listTenantUsers(tenant.id, signal), [tenant.id]);
  const roles = useApiQuery((signal) => api.listRoles(signal), []);
  const custom = (roles.data?.custom ?? []).filter((r) => !isFirmBase(r.baseRole));
  const canManage = can("manage_people") && tenant.status === "active";

  const [email, setEmail] = useState("");
  const [choice, setChoice] = useState(builtInValue("contributor"));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);

  async function act(action: () => Promise<unknown>, failure: string, success?: string) {
    setBusy(true); setMessage(null);
    try {
      await action();
      if (success) setMessage({ tone: "ok", text: success });
      people.refetch();
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof ApiError && e.code !== "INTERNAL" ? e.message : failure });
    } finally { setBusy(false); }
  }

  const invite = () => {
    const to = email.trim();
    const { role, customRoleId } = parseRoleValue(choice);
    return act(async () => {
      const invited = await api.inviteTenantUser(tenant.id, to, role, customRoleId);
      setEmail("");
      setMessage(invited.emailSent === false
        ? { tone: "warn", text: `${to} was invited, but the invitation email could not be sent. Once the mail server is working, press "Resend invite".` }
        : { tone: "ok", text: `Invitation sent to ${to}.` });
    }, "Could not invite that person. Check the email domain is one this client allows.");
  };

  const saveAccess = (u: OrgUser, value: string) => {
    const { role, customRoleId } = parseRoleValue(value);
    return act(async () => {
      await api.setUserAccess(u.id, customRoleId ? { customRoleId } : { role, customRoleId: null });
      setEditing(null);
    }, "Could not change that person's access.", `${u.email}'s access was changed.`);
  };

  return (
    <section aria-label={`People at ${tenant.name}`} className="mt-3 border-t border-gray-100 pt-3">
      <h3 className="text-sm font-semibold mb-1">People at {tenant.name}</h3>
      <p className="text-xs text-gray-500 mb-3">Everyone from this client who can sign in. Their email must use a domain the client allows.</p>
      {message && <p role={message.tone === "error" ? "alert" : "status"} className={`text-sm mb-2 ${message.tone === "error" ? "text-red-600" : message.tone === "warn" ? "text-amber-700" : "text-green-700"}`}>{message.text}</p>}
      {people.error && <p role="alert" className="text-sm text-red-600 mb-2">{people.error}</p>}

      <ul className="space-y-2 mb-3">
        {(people.data ?? []).map((u) => (
          <li key={u.id} className="rounded-lg border border-gray-200 bg-white p-2.5 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <span className="break-all">{u.email}</span>
                <span className="ml-2 text-xs text-gray-500">{roleLabel(u.role)}</span>
                {u.customRoleId && (
                  <span className="ml-2 rounded-full border border-teal-300 bg-teal-50 px-2 py-0.5 text-[11px] font-semibold text-teal-800">
                    {u.customRoleName ?? "Restricted"}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`text-xs font-semibold ${u.status === "active" ? "text-green-700" : "text-gray-400"}`}>{u.status}</span>
                {canManage && u.status === "invited" && (
                  <button type="button" disabled={busy} onClick={() => act(() => api.resendInvite(u.id), "Could not resend that invite.", `Invitation re-sent to ${u.email}.`)} className="text-xs text-gray-500">Resend invite</button>
                )}
                {canManage && u.id !== me?.userId && (
                  <button type="button" disabled={busy} onClick={() => setEditing(editing?.id === u.id ? null : { id: u.id, value: valueOfUser(u) })} aria-label={`Change access for ${u.email}`} className="text-xs text-teal-700">Access</button>
                )}
                {canManage && u.status === "disabled" && <button type="button" disabled={busy} onClick={() => act(() => api.reactivateUser(u.id), "Could not switch that person back on.")} className="text-xs text-gray-500">Reactivate</button>}
                {canManage && u.status === "active" && u.id !== me?.userId && <button type="button" disabled={busy} onClick={() => act(() => api.disableUser(u.id), "Could not switch that person off.")} className="text-xs text-gray-500">Disable</button>}
              </div>
            </div>
            {editing?.id === u.id && (
              <div className="mt-2 flex flex-wrap items-start gap-2 border-t border-gray-100 pt-2">
                <RoleSelect label={`Role for ${u.email}`} value={editing.value} onChange={(value) => setEditing({ id: u.id, value })} builtIn={CLIENT_ROLES} custom={custom} />
                <button type="button" disabled={busy || editing.value === valueOfUser(u)} onClick={() => void saveAccess(u, editing.value)} className="rounded-lg bg-teal-600 text-white px-3 py-1.5 text-sm font-semibold disabled:opacity-50">Save</button>
                <button type="button" onClick={() => setEditing(null)} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm">Cancel</button>
              </div>
            )}
          </li>
        ))}
        {people.data && people.data.length === 0 && <li className="text-sm text-gray-400">No one has been invited yet.</li>}
      </ul>

      {canManage ? (
        <div className="flex flex-wrap items-start gap-2">
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Their work email" aria-label={`Email of the person to invite to ${tenant.name}`} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm flex-1 min-w-[12rem]" />
          <RoleSelect label={`Role for the person invited to ${tenant.name}`} value={choice} onChange={setChoice} builtIn={CLIENT_ROLES} custom={custom} />
          <button type="button" onClick={() => void invite()} disabled={busy || !email.trim()} className="rounded-lg bg-teal-600 text-white px-4 py-1.5 text-sm font-semibold disabled:opacity-50">Invite to {tenant.name}</button>
        </div>
      ) : (
        <p className="text-xs text-gray-400">{tenant.status !== "active" ? "This client is archived, so people can't be invited." : "Your role doesn't include inviting or changing people."}</p>
      )}
    </section>
  );
}
