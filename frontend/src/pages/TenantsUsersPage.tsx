import { useState } from "react";
import { useApi } from "../api/ApiProvider";
import { useAuth } from "../auth/AuthProvider";
import { ApiError } from "../api/client";
import { useApiQuery } from "../api/useApiQuery";
import { AppShell } from "../components/AppShell";
import { TenantPeoplePanel } from "../components/TenantPeoplePanel";
import { TenantAuditorsPanel } from "../components/TenantAuditorsPanel";
import { RoleSelect, builtInValue, parseRoleValue, valueOfUser } from "../components/RoleSelect";
import { FIRM_ROLES, isFirmBase } from "../components/roleLabels";

/** The roles a member of staff can be changed to here (the organisation admin role is never changed from a screen). */
const CHANGEABLE_FIRM_ROLES = FIRM_ROLES.filter((r) => r !== "org_admin");

export function TenantsUsersPage() {
  const api = useApi();
  const { data: tenants, refetch: refetchTenants } = useApiQuery((signal) => api.listTenants(signal), []);
  const { data: users, refetch: refetchUsers } = useApiQuery((signal) => api.listOrgUsers(signal), []);

  const [newTenantName, setNewTenantName] = useState("");
  const [newTenantDomain, setNewTenantDomain] = useState("");
  const [newUserEmail, setNewUserEmail] = useState("");
  const roles = useApiQuery((signal) => api.listRoles(signal), []);
  const firmCustom = (roles.data?.custom ?? []).filter((r) => isFirmBase(r.baseRole));
  const [newUserChoice, setNewUserChoice] = useState(builtInValue("auditor"));
  /** The tenant whose People or Auditors panel is open (one at a time keeps the page short). */
  const [openPanel, setOpenPanel] = useState<{ tenantId: string; kind: "people" | "auditors" } | null>(null);
  const [editingStaff, setEditingStaff] = useState<{ id: string; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);
  /** The person whose two-step reset is waiting for a second click to confirm. */
  const [confirmingReset, setConfirmingReset] = useState<string | null>(null);
  const { user: me } = useAuth();

  /** Every button below funnels through this so a failed request always shows something, instead of
   *  the action silently doing nothing (and, in the browser, becoming an unhandled promise rejection). */
  async function runAction(action: () => Promise<unknown>, failureMessage: string) {
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (e) {
      // A mail-server problem is something the admin can act on, so say so rather than a generic failure.
      setError(e instanceof ApiError && e.code === "EMAIL_DELIVERY_FAILED"
        ? "The email could not be sent. Check the mail server settings and try again."
        : failureMessage);
    }
  }

  async function createTenant() {
    setError(null);
    try {
      await api.createTenant(newTenantName.trim(), [newTenantDomain.trim()]);
      setNewTenantName(""); setNewTenantDomain("");
      refetchTenants();
    } catch {
      setError("Could not create the tenant. Check the details and try again.");
    }
  }

  async function inviteUser() {
    setError(null);
    setNotice(null);
    try {
      const email = newUserEmail.trim();
      const { role, customRoleId } = parseRoleValue(newUserChoice);
      const invited = await api.inviteAuditorUser(email, role, customRoleId);
      setNewUserEmail("");
      refetchUsers();
      setNotice(invited.emailSent === false
        ? { tone: "warn", text: `${email} was invited, but the invitation email could not be sent. Once the mail server is working, press "Resend invite" next to their name.` }
        : { tone: "ok", text: `Invitation sent to ${email}.` });
    } catch {
      setError("Could not invite that user. Check the email domain and try again.");
    }
  }

  return (
    <AppShell>
      <div className="p-8 max-w-3xl space-y-8">
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        {notice && <p role="status" className={`text-sm ${notice.tone === "warn" ? "text-amber-700" : "text-green-700"}`}>{notice.text}</p>}

        <section>
          <h1 className="text-xl font-semibold mb-4">Tenants</h1>
          <ul className="space-y-2 mb-4">
            {(tenants ?? []).map((t) => (
              <li key={t.id} className="rounded-lg border border-gray-200 bg-white p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>{t.name}</span>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`text-xs font-semibold ${t.status === "active" ? "text-green-700" : "text-gray-400"}`}>{t.status}</span>
                    <button type="button" aria-expanded={openPanel?.tenantId === t.id && openPanel.kind === "people"} aria-label={`People at ${t.name}`}
                      onClick={() => setOpenPanel(openPanel?.tenantId === t.id && openPanel.kind === "people" ? null : { tenantId: t.id, kind: "people" })}
                      className="text-xs font-semibold text-teal-700">People</button>
                    {me?.role === "org_admin" && (
                      <button type="button" aria-expanded={openPanel?.tenantId === t.id && openPanel.kind === "auditors"} aria-label={`Auditors assigned to ${t.name}`}
                        onClick={() => setOpenPanel(openPanel?.tenantId === t.id && openPanel.kind === "auditors" ? null : { tenantId: t.id, kind: "auditors" })}
                        className="text-xs font-semibold text-teal-700">Auditors</button>
                    )}
                    {t.status === "active"
                      ? <button onClick={() => runAction(() => api.archiveTenant(t.id).then(refetchTenants), "Could not archive that tenant.")} className="text-xs text-gray-500">Archive</button>
                      : <button onClick={() => runAction(() => api.reactivateTenant(t.id).then(refetchTenants), "Could not reactivate that tenant.")} className="text-xs text-gray-500">Reactivate</button>}
                  </div>
                </div>
                {openPanel?.tenantId === t.id && openPanel.kind === "people" && <TenantPeoplePanel tenant={t} />}
                {openPanel?.tenantId === t.id && openPanel.kind === "auditors" && <TenantAuditorsPanel tenant={t} />}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <input value={newTenantName} onChange={(e) => setNewTenantName(e.target.value)} placeholder="Tenant name" className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm flex-1 min-w-[10rem]" />
            <input value={newTenantDomain} onChange={(e) => setNewTenantDomain(e.target.value)} placeholder="Allowed email domain" className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm flex-1 min-w-[10rem]" />
            <button onClick={createTenant} disabled={!newTenantName || !newTenantDomain} className="rounded-lg bg-teal-600 text-white px-4 py-1.5 text-sm font-semibold disabled:opacity-50">
              Add tenant
            </button>
          </div>
        </section>

        <section>
          <h2 className="text-lg font-semibold mb-4">Auditor-side users</h2>
          <ul className="space-y-2 mb-4">
            {(users ?? []).map((u) => (
              <li key={u.id} className="rounded-lg border border-gray-200 bg-white p-3 text-sm">
               <div className="flex flex-wrap items-center justify-between gap-2">
                <span>{u.email} <span className="text-gray-400 ml-1">{u.role}</span>
                  {u.customRoleId && <span className="ml-2 rounded-full border border-teal-300 bg-teal-50 px-2 py-0.5 text-[11px] font-semibold text-teal-800">{u.customRoleName ?? "Restricted"}</span>}
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  {me?.role === "org_admin" && u.role !== "org_admin" && u.id !== me.userId && (
                    <button type="button" onClick={() => setEditingStaff(editingStaff?.id === u.id ? null : { id: u.id, value: valueOfUser(u) })} aria-label={`Change access for ${u.email}`} className="text-xs text-teal-700">Access</button>
                  )}
                  {u.mfaEnabled !== undefined && (
                    <span className={`text-xs ${u.mfaEnabled ? "text-green-700" : "text-gray-400"}`}>{u.mfaEnabled ? "Two-step on" : "Two-step off"}</span>
                  )}
                  {u.mfaEnabled && u.id !== me?.userId && (confirmingReset === u.id ? (
                    <>
                      <button
                        onClick={() => runAction(async () => {
                          await api.resetUserMfa(u.id);
                          setConfirmingReset(null);
                          refetchUsers();
                          setNotice({ tone: "ok", text: `Two-step sign-in reset for ${u.email}. They have been signed out everywhere and can sign in with just their password until they set it up again.` });
                        }, "Could not reset two-step sign-in for that user.")}
                        className="text-xs text-red-700 font-semibold"
                      >Confirm reset</button>
                      <button onClick={() => setConfirmingReset(null)} className="text-xs text-gray-500">Cancel</button>
                    </>
                  ) : (
                    <button onClick={() => setConfirmingReset(u.id)} className="text-xs text-gray-500">Reset two-step</button>
                  ))}
                  <span className={`text-xs font-semibold ${u.status === "active" ? "text-green-700" : "text-gray-400"}`}>{u.status}</span>
                  {u.status === "invited" && (
                    <button onClick={() => runAction(() => api.resendInvite(u.id).then(() => setNotice({ tone: "ok", text: `Invitation re-sent to ${u.email}.` })), "Could not resend that invite.")} className="text-xs text-gray-500">Resend invite</button>
                  )}
                  {u.status === "disabled"
                    ? <button onClick={() => runAction(() => api.reactivateUser(u.id).then(refetchUsers), "Could not reactivate that user.")} className="text-xs text-gray-500">Reactivate</button>
                    : u.status === "active" && <button onClick={() => runAction(() => api.disableUser(u.id).then(refetchUsers), "Could not disable that user.")} className="text-xs text-gray-500">Disable</button>}
                </div>
               </div>
               {editingStaff?.id === u.id && (
                 <div className="mt-2 flex flex-wrap items-start gap-2 border-t border-gray-100 pt-2">
                   <RoleSelect label={`Role for ${u.email}`} value={editingStaff.value} onChange={(value) => setEditingStaff({ id: u.id, value })}
                     builtIn={CHANGEABLE_FIRM_ROLES} custom={firmCustom} />
                   <button type="button" disabled={editingStaff.value === valueOfUser(u)}
                     onClick={() => runAction(async () => {
                       const { role, customRoleId } = parseRoleValue(editingStaff.value);
                       await api.setUserAccess(u.id, customRoleId ? { customRoleId } : { role, customRoleId: null });
                       setEditingStaff(null);
                       refetchUsers();
                       setNotice({ tone: "ok", text: `${u.email}'s access was changed.` });
                     }, "Could not change that person's access.")}
                     className="rounded-lg bg-teal-600 text-white px-3 py-1.5 text-sm font-semibold disabled:opacity-50">Save</button>
                   <button type="button" onClick={() => setEditingStaff(null)} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm">Cancel</button>
                 </div>
               )}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <input value={newUserEmail} onChange={(e) => setNewUserEmail(e.target.value)} placeholder="Work email" className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm flex-1 min-w-[10rem]" />
            <RoleSelect label="Role" value={newUserChoice} onChange={setNewUserChoice} builtIn={FIRM_ROLES} custom={firmCustom} />
            <button onClick={inviteUser} disabled={!newUserEmail} className="rounded-lg bg-teal-600 text-white px-4 py-1.5 text-sm font-semibold disabled:opacity-50">
              Invite
            </button>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
