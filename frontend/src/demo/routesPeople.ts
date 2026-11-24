// Clients (tenants), users, auditor assignments, the organisation, and where evidence is kept (the real server's
// routes/orgs.ts, users.ts and storage.ts and the services behind them).

import type { ChoosableStorage, OrgUser, StorageOptions, Tenant } from "../api/types";
import type { DemoBackend, Route } from "./backend";
import { asObject, enumField, fail, FORBIDDEN, stringList, textField } from "./http";
import { AUDITOR_SIDE_ROLES, TENANT_SIDE_ROLES, isAuditorSide, isBaseRole, isFirmBase } from "./rules";
import type { DemoTenant, DemoUser } from "./state";

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);

const LOCKED_MESSAGE = "This organisation already has evidence recorded in its current storage, so the storage can't be changed any more.";
const NOT_IN_DEMO = (what: string) => `${what} isn't available in this demo: it never contacts anything outside your browser. A real installation can.`;

function tenantsVisibleTo(api: DemoBackend, user: DemoUser): DemoTenant[] {
  return api.state.tenants.filter((t) => api.canSeeTenant(user, t.id));
}

const toTenant = (t: DemoTenant): Tenant => ({ id: t.id, name: t.name, status: t.status, storageRootId: t.storageRootId });

/** Everyone in the list, plus (for organisation admins only) whether each has two-step sign-in on. */
function toUsers(api: DemoBackend, viewer: DemoUser, list: DemoUser[]): OrgUser[] {
  return [...list].sort((a, b) => a.email.localeCompare(b.email)).map((u) => ({
    id: u.id, email: u.email, fullName: u.fullName, role: u.role, status: u.status,
    // Everyone is told that a person has a custom role; only the firm's staff are told its name (they are the only ones who can read the firm's roles).
    customRoleId: u.customRoleId ?? null,
    customRoleName: isAuditorSide(viewer.role) && u.customRoleId ? api.customRole(u.customRoleId)?.name ?? null : null,
    ...(viewer.role === "org_admin" ? { mfaEnabled: api.mfaEnabled(u) } : {}),
  }));
}

/** Can this person see `target` at all? (001_core: users_select) */
export function canSeeUser(api: DemoBackend, viewer: DemoUser, target: DemoUser): boolean {
  if (target.id === viewer.id) return true;
  return target.tenantId ? api.canSeeTenant(viewer, target.tenantId) : AUDITOR_SIDE_ROLES.includes(viewer.role);
}

/** May this person create or change `target`'s account? (001_core: users_insert / users_update) */
function canManageUser(api: DemoBackend, actor: DemoUser, tenantId: string | null, role: string): boolean {
  if (!api.allows(actor, "manage_people")) return false; // a custom role may have taken this ability away (016)
  if (actor.role === "org_admin") return true;
  if (tenantId === null) return false;
  if (!api.canSeeTenant(actor, tenantId)) return false;
  if (actor.role === "lead_auditor") return true;
  return actor.role === "tenant_lead" && actor.tenantId === tenantId && ["contributor", "viewer", "tenant_dashboard"].includes(role);
}

/** The address must belong to one of the allowed domains (001_core: enforce_email_domain). */
function checkDomain(email: string, domains: string[]): string {
  const clean = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) fail(422, "INVALID_EMAIL", "INVALID_EMAIL");
  const domain = clean.split("@")[1];
  if (!domains.map((d) => d.toLowerCase()).includes(domain)) fail(422, "DOMAIN_NOT_ALLOWED", domain);
  return clean;
}

function newUser(api: DemoBackend, actor: DemoUser, email: string, fullName: string | undefined, role: DemoUser["role"], customRoleId: string | null, tenantId: string | null): DemoUser {
  if (api.userByEmail(email)) fail(409, "DUPLICATE", "That value is already in use.");
  const u: DemoUser = { id: api.newId(), email, fullName: fullName ?? null, role, customRoleId, status: "invited", tenantId, password: "", failedLogins: 0, lockedUntil: null, sessionEpoch: 0, mfa: null };
  api.state.users.push(u);
  api.log(actor, "user.invited", tenantId, "user", u.id, { role, customRoleId, side: tenantId ? "tenant" : "auditor" });
  return u;
}

/**
 * What an invite or a change of access asks for, with plain errors (services/users.ts resolveRole): a built-in role, or a
 * custom role (whose base role then becomes the person's role). `side` is which kind of person it is for.
 */
function resolveRole(api: DemoBackend, actor: DemoUser, side: "auditor" | "tenant", role: string | undefined, customRoleId: string | null | undefined): { role: DemoUser["role"]; customRoleId: string | null } {
  if (customRoleId) {
    // The firm's roles are only readable by the firm's staff: to anyone else the role simply isn't there.
    const cr = isAuditorSide(actor.role) ? api.customRole(customRoleId) : undefined;
    if (!cr) fail(404, "NOT_FOUND", "That custom role was not found.");
    if (!isBaseRole(cr!.baseRole) || (side === "auditor") !== isFirmBase(cr!.baseRole)) {
      fail(400, "INVALID_CUSTOM_ROLE", side === "auditor" ? "That custom role is for a client's people, not for your own staff." : "That custom role is for your own staff, not for a client's people.");
    }
    if (role && role !== cr!.baseRole) fail(400, "INVALID_CUSTOM_ROLE", "That custom role is based on a different role than the one chosen.");
    return { role: cr!.baseRole, customRoleId };
  }
  if (!role) fail(400, "VALIDATION", "role: Choose a role.");
  return { role: role as DemoUser["role"], customRoleId: null };
}

/** Only the audit firm hands out custom roles (users_custom_role_who): otherwise a client lead could clear a restriction the firm set. */
function requireFirmToGiveCustomRole(actor: DemoUser): void {
  if (actor.role !== "org_admin" && actor.role !== "lead_auditor") fail(403, "FORBIDDEN_ROLE", "only the audit firm can give someone a custom role");
}

/** The role or custom role an invite names: both optional in the request, but one of the two must be there. */
function roleChoice(b: Record<string, unknown>, allowed: readonly string[]): { role: string | undefined; customRoleId: string | undefined } {
  const role = b.role === undefined ? undefined : enumField(b, "role", allowed);
  const customRoleId = b.customRoleId === undefined ? undefined : textField(b, "customRoleId", { max: 100 });
  if (!role && !customRoleId) fail(400, "VALIDATION", "role: Choose a role.");
  return { role, customRoleId };
}

function storageOptions(api: DemoBackend): StorageOptions {
  const local = api.state.storageConnections.find((c) => c.provider === "local");
  return {
    current: api.state.org.storageProvider,
    locked: api.state.files.length > 0,
    options: [
      { provider: "google_drive", available: false, unavailableReason: NOT_IN_DEMO("Google Drive"), connected: false },
      { provider: "local", available: true, connected: !!local, ...(local ? { status: local.status, label: local.label } : {}) },
      { provider: "s3", available: false, unavailableReason: NOT_IN_DEMO("S3 storage"), connected: false },
      { provider: "sharepoint", available: false, unavailableReason: "SharePoint is coming in a later release.", connected: false },
    ],
  };
}

function requireAdmin(user: DemoUser, what: string): void {
  if (user.role !== "org_admin") fail(403, "FORBIDDEN", `Only an org admin can ${what}.`);
}

export function peopleRoutes(): Route[] {
  return [
    // ---- clients -----------------------------------------------------------------------------------------------------
    {
      method: "GET", path: "/tenants",
      handle: ({ api, user }) => ({ json: tenantsVisibleTo(api, user).sort((a, b) => a.name.localeCompare(b.name)).map(toTenant) }),
    },
    {
      method: "POST", path: "/tenants",
      handle: ({ api, user, req }) => {
        const b = asObject(req.body);
        const name = textField(b, "name", { max: 200 });
        const domains = stringList(b, "allowedDomains", { min: 1, item: { max: 253 } });
        if (user.role !== "org_admin") FORBIDDEN();
        const t: DemoTenant = { id: api.newId(), name, status: "active", storageRootId: null, allowedDomains: domains.map((d) => d.trim().toLowerCase()) };
        api.state.tenants.push(t);
        api.log(user, "tenant.created", t.id, "tenant", t.id, { name });
        return { status: 201, json: { id: t.id, name: t.name, status: t.status } };
      },
    },
    ...(["archive", "reactivate"] as const).map((verb): Route => ({
      method: "POST", path: `/tenants/:id/${verb}`,
      handle: ({ api, user, params }) => {
        const t = api.tenant(params.id);
        if (!t || user.role !== "org_admin" || !api.canSeeTenant(user, t.id)) fail(404, "NOT_FOUND", "Tenant not found or not visible to you.");
        t!.status = verb === "archive" ? "archived" : "active";
        api.log(user, `tenant.${t!.status}`, t!.id, "tenant", t!.id);
        return { json: { id: t!.id, status: t!.status } };
      },
    })),
    {
      method: "PATCH", path: "/tenants/:id/storage-root",
      handle: ({ api, user, params, req }) => {
        const root = textField(asObject(req.body), "storageRootId", { max: 1000 });
        const t = api.tenant(params.id);
        if (!t || user.role !== "org_admin") fail(404, "NOT_FOUND", "Tenant not found or not visible to you.");
        t!.storageRootId = root;
        api.log(user, "tenant.storage_root_set", t!.id, "tenant", t!.id);
        return { json: { id: t!.id, storageRootId: root } };
      },
    },
    {
      method: "POST", path: "/tenants/:id/storage-root/create",
      handle: ({ api, user, params }) => {
        requireAdmin(user, "set up a tenant's storage folder");
        const t = api.tenant(params.id);
        if (!t) fail(404, "NOT_FOUND", "Tenant not found or not visible to you.");
        if (t!.storageRootId) fail(409, "STORAGE_ROOT_EXISTS", "This tenant already has a storage folder.");
        t!.storageRootId = `demo-disk:${slug(t!.name)}`;
        api.log(user, "tenant.storage_root_created", t!.id, "tenant", t!.id);
        return { status: 201, json: { id: t!.id, storageRootId: t!.storageRootId } };
      },
    },
    {
      // The firm's staff assigned to a client. Only the organisation admin sees them all; everyone else sees at most themselves
      // (RLS on auditor_assignments); organisation admins see every client without being assigned, so they are not listed.
      method: "GET", path: "/tenants/:id/auditors",
      handle: ({ api, user, params }) => {
        if (!api.canSeeTenant(user, params.id)) fail(404, "NOT_FOUND", "Tenant not found or not visible to you.");
        const rows = api.state.auditorAssignments
          .filter((a) => a.tenantId === params.id && (user.role === "org_admin" || a.userId === user.id))
          .map((a) => api.user(a.userId))
          .filter((u): u is DemoUser => !!u && canSeeUser(api, user, u));
        return { json: toUsers(api, user, rows) };
      },
    },
    {
      method: "PUT", path: "/tenants/:id/auditors/:userId",
      handle: ({ api, user, params }) => {
        // Plain-language reasons first; then the database's own rule (only an organisation admin may assign).
        const target = api.user(params.userId);
        if (!target || !canSeeUser(api, user, target)) fail(404, "NOT_FOUND", "That person was not found.");
        if (target!.tenantId) fail(400, "ASSIGNEE_ROLE", "That person works for a client, not for your firm.");
        if (target!.role === "org_admin") fail(400, "ASSIGNEE_ROLE", "Organisation admins already see every client.");
        if (user.role !== "org_admin") FORBIDDEN();
        if (!api.tenant(params.id)) fail(404, "NOT_FOUND", "Tenant not found or not visible to you.");
        const exists = api.state.auditorAssignments.some((a) => a.userId === params.userId && a.tenantId === params.id);
        if (!exists) {
          api.state.auditorAssignments.push({ userId: params.userId, tenantId: params.id });
          api.log(user, "auditor.assigned", params.id, "user", params.userId);
        }
        return { json: { auditorUserId: params.userId, tenantId: params.id } };
      },
    },
    {
      method: "DELETE", path: "/tenants/:id/auditors/:userId",
      handle: ({ api, user, params }) => {
        const at = api.state.auditorAssignments.findIndex((a) => a.userId === params.userId && a.tenantId === params.id);
        if (user.role !== "org_admin" || at < 0) return { json: { removed: false } };
        api.state.auditorAssignments.splice(at, 1);
        return { json: { removed: true } };
      },
    },

    // ---- people ---------------------------------------------------------------------------------------------------------
    {
      method: "GET", path: "/users",
      handle: ({ api, user }) => ({ json: toUsers(api, user, api.state.users.filter((u) => u.tenantId === null && canSeeUser(api, user, u))) }),
    },
    {
      method: "POST", path: "/users",
      handle: ({ api, user, req }) => {
        const b = asObject(req.body);
        const email = textField(b, "email", { max: 254 });
        const fullName = textField(b, "fullName", { max: 200, optional: true });
        const choice = roleChoice(b, AUDITOR_SIDE_ROLES);
        const want = resolveRole(api, user, "auditor", choice.role, choice.customRoleId);
        if (want.customRoleId) requireFirmToGiveCustomRole(user);
        const clean = checkDomain(email, api.state.org.allowedDomains);
        if (!canManageUser(api, user, null, want.role)) FORBIDDEN();
        const u = newUser(api, user, clean, fullName, want.role, want.customRoleId, null);
        return { status: 201, json: { id: u.id, email: u.email, role: u.role, status: u.status } };
      },
    },
    {
      method: "GET", path: "/tenants/:id/users",
      handle: ({ api, user, params }) => ({
        json: api.canSeeTenant(user, params.id) ? toUsers(api, user, api.state.users.filter((u) => u.tenantId === params.id)) : [],
      }),
    },
    {
      method: "POST", path: "/tenants/:id/users",
      handle: ({ api, user, params, req }) => {
        const b = asObject(req.body);
        const email = textField(b, "email", { max: 254 });
        const fullName = textField(b, "fullName", { max: 200, optional: true });
        const choice = roleChoice(b, TENANT_SIDE_ROLES);
        const want = resolveRole(api, user, "tenant", choice.role, choice.customRoleId);
        const t = api.tenant(params.id);
        if (!t || !api.canSeeTenant(user, t.id)) fail(404, "NOT_FOUND", "Tenant not found or not visible to you.");
        if (want.customRoleId) requireFirmToGiveCustomRole(user);
        const clean = checkDomain(email, t!.allowedDomains);
        if (!canManageUser(api, user, t!.id, want.role)) FORBIDDEN();
        const u = newUser(api, user, clean, fullName, want.role, want.customRoleId, t!.id);
        return { status: 201, json: { id: u.id, email: u.email, role: u.role, status: u.status } };
      },
    },
    {
      // Changes a person's built-in role and/or custom role. Never your own, and never anything to do with the organisation admin role.
      method: "PATCH", path: "/users/:id/access",
      handle: ({ api, user, params, req }) => {
        const b = asObject(req.body);
        const role = b.role === undefined ? undefined : enumField(b, "role", [...AUDITOR_SIDE_ROLES, ...TENANT_SIDE_ROLES]);
        let customRoleId: string | null | undefined;
        if (b.customRoleId === null) customRoleId = null;
        else if (b.customRoleId !== undefined) customRoleId = textField(b, "customRoleId", { max: 100 });
        if (role === undefined && customRoleId === undefined) fail(400, "VALIDATION", "role: Say what to change.");

        if (params.id === user.id) fail(403, "SELF_CHANGE", "You can't change your own access. Ask another administrator.");
        const target = api.user(params.id);
        if (!target || !canSeeUser(api, user, target)) fail(404, "NOT_FOUND", "User not found or not visible to you.");
        const side = target!.tenantId ? "tenant" : "auditor";
        const allowed: readonly string[] = side === "tenant" ? TENANT_SIDE_ROLES : AUDITOR_SIDE_ROLES.filter((r) => r !== "org_admin");
        if (target!.role === "org_admin" || role === "org_admin") fail(403, "ORG_ADMIN_LOCKED", "The organisation admin role can't be changed here.");
        if (role && !allowed.includes(role)) fail(400, "VALIDATION", "That role is not for this kind of person.");

        let want: { role: DemoUser["role"]; customRoleId: string | null };
        if (customRoleId) want = resolveRole(api, user, side, role, customRoleId);
        else {
          const next = (role ?? target!.role) as DemoUser["role"];
          // Keeping the current custom role only makes sense while its base role is still the person's role.
          const keep = customRoleId === undefined ? target!.customRoleId ?? null : null;
          if (keep && next !== target!.role) fail(400, "INVALID_CUSTOM_ROLE", "This person has a custom role. Choose the new role together with a custom role, or remove the custom role first.");
          want = { role: next, customRoleId: keep };
        }

        // users_update: the person must be one this caller may manage, before and after the change.
        if (!canManageUser(api, user, target!.tenantId, target!.role)) FORBIDDEN();
        if (want.customRoleId !== (target!.customRoleId ?? null)) requireFirmToGiveCustomRole(user);
        if (!canManageUser(api, user, target!.tenantId, want.role)) FORBIDDEN();

        const from = { role: target!.role, customRoleId: target!.customRoleId ?? null };
        target!.role = want.role;
        target!.customRoleId = want.customRoleId;
        api.log(user, "user.access_changed", target!.tenantId, "user", target!.id, { from, to: { role: want.role, customRoleId: want.customRoleId } });
        return { json: { id: target!.id, role: target!.role, customRoleId: target!.customRoleId } };
      },
    },
    ...(["disable", "reactivate"] as const).map((verb): Route => ({
      method: "POST", path: `/users/:id/${verb}`,
      handle: ({ api, user, params }) => {
        const u = api.user(params.id);
        if (!u || !canSeeUser(api, user, u) || !canManageUser(api, user, u.tenantId, u.role)) fail(404, "NOT_FOUND", "User not found or not visible to you.");
        u!.status = verb === "disable" ? "disabled" : "active";
        api.log(user, `user.${u!.status}`, u!.tenantId, "user", u!.id);
        return { json: { id: u!.id, status: u!.status } };
      },
    })),
    {
      // A demo has no mail server, so there is nothing to send; the invite stays pending.
      method: "POST", path: "/users/:id/resend-invite",
      handle: ({ api, user, params }) => {
        const u = api.user(params.id);
        if (!u || u.status !== "invited" || !canSeeUser(api, user, u) || !canManageUser(api, user, u.tenantId, u.role)) {
          fail(404, "NOT_FOUND", "That invite no longer exists or has already been accepted.");
        }
        return { json: { id: u!.id } };
      },
    },

    // ---- the organisation ----------------------------------------------------------------------------------------------------
    {
      method: "PATCH", path: "/org",
      handle: ({ api, user, req }) => {
        const b = asObject(req.body);
        const name = textField(b, "name", { max: 200, optional: true });
        const provider = b.storageProvider === undefined ? undefined : enumField(b, "storageProvider", ["google_drive", "sharepoint"] as const);
        if (name === undefined && provider === undefined) fail(400, "VALIDATION", "No fields to update.");
        if (user.role !== "org_admin") FORBIDDEN();
        if (provider !== undefined) {
          if (api.state.files.length > 0) fail(409, "STORAGE_PROVIDER_LOCKED", LOCKED_MESSAGE);
          fail(409, "DEMO_UNAVAILABLE", NOT_IN_DEMO(provider === "google_drive" ? "Google Drive" : "SharePoint"));
        }
        api.state.org.name = name!;
        api.log(user, "org.settings_changed", null, "org", api.state.org.id, { name });
        return { json: { id: api.state.org.id, name: api.state.org.name, storageProvider: api.state.org.storageProvider } };
      },
    },

    // ---- where evidence is kept ----------------------------------------------------------------------------------------------------
    {
      method: "GET", path: "/org/storage-connections",
      handle: ({ api, user }) => ({
        json: user.role === "org_admin" ? api.state.storageConnections.map((c) => ({ id: c.id, provider: c.provider, accountLabel: c.label, status: c.status })) : [],
      }),
    },
    {
      method: "PUT", path: "/org/storage-connections",
      handle: ({ user }) => {
        requireAdmin(user, "choose where evidence is kept");
        return fail(409, "DEMO_UNAVAILABLE", NOT_IN_DEMO("Connecting a storage account"));
      },
    },
    {
      method: "POST", path: "/org/storage-connections/google/start",
      handle: ({ user }) => {
        requireAdmin(user, "connect Google Drive");
        return fail(409, "DEMO_UNAVAILABLE", NOT_IN_DEMO("Connecting Google Drive"));
      },
    },
    {
      method: "GET", path: "/org/storage-options",
      handle: ({ api, user }) => {
        requireAdmin(user, "see the storage settings");
        return { json: storageOptions(api) };
      },
    },
    {
      method: "POST", path: "/org/storage-connections/local",
      handle: ({ api, user }) => {
        requireAdmin(user, "choose where evidence is kept");
        let c = api.state.storageConnections.find((x) => x.provider === "local");
        if (!c) {
          c = { id: api.newId(), provider: "local", label: "This server's disk", status: "active" };
          api.state.storageConnections.push(c);
        }
        api.state.org.storageProvider = "local";
        api.log(user, "org.storage_connected", null, "storage_connection", c.id, { provider: "local" });
        return { json: { id: c.id, provider: "local", folder: `demo-disk/${slug(api.state.org.name)}` } };
      },
    },
    {
      method: "POST", path: "/org/storage-connections/s3/test",
      handle: ({ user }) => {
        requireAdmin(user, "test a storage connection");
        return fail(409, "DEMO_UNAVAILABLE", NOT_IN_DEMO("Testing an S3 connection"));
      },
    },
    {
      method: "PUT", path: "/org/storage-connections/s3",
      handle: ({ user }) => {
        requireAdmin(user, "choose where evidence is kept");
        return fail(409, "DEMO_UNAVAILABLE", NOT_IN_DEMO("Connecting S3 storage"));
      },
    },
    {
      method: "PUT", path: "/org/storage-provider",
      handle: ({ api, user, req }) => {
        requireAdmin(user, "choose where evidence is kept");
        const provider: ChoosableStorage = enumField(asObject(req.body), "provider", ["google_drive", "local", "s3"] as const);
        const conn = api.state.storageConnections.find((c) => c.provider === provider);
        if (!conn || conn.status !== "active") fail(409, "STORAGE_NOT_CONNECTED", "Connect that storage first, then choose it.");
        if (api.state.org.storageProvider !== provider && api.state.files.length > 0) fail(409, "STORAGE_PROVIDER_LOCKED", LOCKED_MESSAGE);
        api.state.org.storageProvider = provider;
        return { json: { provider } };
      },
    },
  ];
}
