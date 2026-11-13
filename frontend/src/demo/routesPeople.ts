// Clients (tenants), users, auditor assignments, the organisation, and where evidence is kept (the real server's
// routes/orgs.ts, users.ts and storage.ts and the services behind them).

import type { ChoosableStorage, OrgUser, StorageOptions, Tenant } from "../api/types";
import type { DemoBackend, Route } from "./backend";
import { asObject, enumField, fail, FORBIDDEN, stringList, textField } from "./http";
import { AUDITOR_SIDE_ROLES, TENANT_SIDE_ROLES } from "./rules";
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
    ...(viewer.role === "org_admin" ? { mfaEnabled: api.mfaEnabled(u) } : {}),
  }));
}

/** Can this person see `target` at all? (001_core: users_select) */
function canSeeUser(api: DemoBackend, viewer: DemoUser, target: DemoUser): boolean {
  if (target.id === viewer.id) return true;
  return target.tenantId ? api.canSeeTenant(viewer, target.tenantId) : AUDITOR_SIDE_ROLES.includes(viewer.role);
}

/** May this person create or change `target`'s account? (001_core: users_insert / users_update) */
function canManageUser(api: DemoBackend, actor: DemoUser, tenantId: string | null, role: string): boolean {
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

function newUser(api: DemoBackend, actor: DemoUser, email: string, fullName: string | undefined, role: DemoUser["role"], tenantId: string | null): DemoUser {
  if (api.userByEmail(email)) fail(409, "DUPLICATE", "That value is already in use.");
  const u: DemoUser = { id: api.newId(), email, fullName: fullName ?? null, role, status: "invited", tenantId, password: "", failedLogins: 0, lockedUntil: null, sessionEpoch: 0, mfa: null };
  api.state.users.push(u);
  api.log(actor, "user.invited", tenantId, "user", u.id, { role, side: tenantId ? "tenant" : "auditor" });
  return u;
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
      method: "PUT", path: "/tenants/:id/auditors/:userId",
      handle: ({ api, user, params }) => {
        if (user.role !== "org_admin") FORBIDDEN();
        const exists = api.state.auditorAssignments.some((a) => a.userId === params.userId && a.tenantId === params.id);
        if (!exists && api.user(params.userId) && api.tenant(params.id)) {
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
        const role = enumField(b, "role", AUDITOR_SIDE_ROLES);
        const clean = checkDomain(email, api.state.org.allowedDomains);
        if (!canManageUser(api, user, null, role)) FORBIDDEN();
        const u = newUser(api, user, clean, fullName, role, null);
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
        const role = enumField(b, "role", TENANT_SIDE_ROLES);
        const t = api.tenant(params.id);
        if (!t || !api.canSeeTenant(user, t.id)) fail(404, "NOT_FOUND", "Tenant not found or not visible to you.");
        const clean = checkDomain(email, t!.allowedDomains);
        if (!canManageUser(api, user, t!.id, role)) FORBIDDEN();
        const u = newUser(api, user, clean, fullName, role, t!.id);
        return { status: 201, json: { id: u.id, email: u.email, role: u.role, status: u.status } };
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
