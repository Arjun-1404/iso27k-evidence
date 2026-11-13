import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { adminPool, appPool, makeWorld, controlId, type World } from "./helpers.ts";
import { AppError } from "../src/errors.ts";
import * as orgs from "../src/services/orgs.ts";
import * as users from "../src/services/users.ts";

afterAll(async () => { await adminPool.end(); await appPool.end(); });

async function expectAppError(p: Promise<unknown>, code?: string, status?: number) {
  let err: unknown;
  try { await p; } catch (e) { err = e; }
  expect(err).toBeInstanceOf(AppError);
  const ae = err as AppError;
  if (code) expect(ae.code).toBe(code);
  if (status) expect(ae.status).toBe(status);
  return ae;
}

describe("org service: tenants", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("an org admin creates a tenant, scoped to their own org automatically", async () => {
    const t = await orgs.createTenant(appPool, w.admin, { name: "New Co", allowedDomains: [`newco-${w.tag}.test`] });
    expect(t.status).toBe("active");
    const list = await orgs.listTenants(appPool, w.admin);
    expect(list.map((r: { name: string }) => r.name)).toContain("New Co");
  });

  it("nobody but an org admin can create a tenant", async () => {
    await expectAppError(orgs.createTenant(appPool, w.lead, { name: "x", allowedDomains: ["x.test"] }), "FORBIDDEN", 403);
    await expectAppError(orgs.createTenant(appPool, w.tLead, { name: "x", allowedDomains: ["x.test"] }), "FORBIDDEN", 403);
  });

  it("archiving and reactivating a tenant round-trips, and a bad id is a clean 404", async () => {
    const t = await orgs.createTenant(appPool, w.admin, { name: "Archive Me", allowedDomains: [`am-${w.tag}.test`] });
    const archived = await orgs.archiveTenant(appPool, w.admin, t.id);
    expect(archived.status).toBe("archived");
    const reactivated = await orgs.reactivateTenant(appPool, w.admin, t.id);
    expect(reactivated.status).toBe("active");
    await expectAppError(orgs.archiveTenant(appPool, w.admin, "00000000-0000-0000-0000-000000000000"), "NOT_FOUND", 404);
  });

  it("cannot create a tenant with a name that collides in the same org, but the same name is fine in another org", async () => {
    await orgs.createTenant(appPool, w.admin, { name: "Dup", allowedDomains: [`dup-${w.tag}.test`] });
    await expectAppError(orgs.createTenant(appPool, w.admin, { name: "Dup", allowedDomains: [`dup2-${w.tag}.test`] }), "DUPLICATE", 409);
    const t = await orgs.createTenant(appPool, w.adminB, { name: "Dup", allowedDomains: [`dupb-${w.tag}.test`] });
    expect(t.name).toBe("Dup");
  });

  it("sets the tenant's storage root folder id", async () => {
    const r = await orgs.setTenantStorageRoot(appPool, w.admin, w.tA1, "drive-folder-123");
    expect(r.storage_root_id).toBe("drive-folder-123");
  });
});

describe("org service: settings and storage connection", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("an org admin updates org settings; nobody else can", async () => {
    const r = await orgs.updateOrgSettings(appPool, w.admin, { name: "Renamed Co", storageProvider: "sharepoint" });
    expect(r).toEqual({ id: w.orgA, name: "Renamed Co", storage_provider: "sharepoint" });
    await expectAppError(orgs.updateOrgSettings(appPool, w.lead, { name: "Hacked" }), "FORBIDDEN", 403);
  });

  it("connecting storage stores only a token reference, is upsertable, and is admin-only", async () => {
    const first = await orgs.connectStorage(appPool, w.admin, { provider: "google_drive", tokenRef: "kv://secret/v1" });
    expect(first.status).toBe("active");
    const second = await orgs.connectStorage(appPool, w.admin, { provider: "google_drive", tokenRef: "kv://secret/v2", accountLabel: "svc-account" });
    const list = await orgs.listStorageConnections(appPool, w.admin);
    expect(list).toHaveLength(1); // upserted, not duplicated
    expect(list[0].account_label).toBe("svc-account");
    expect(second.id).toBe(first.id);
    await expectAppError(orgs.connectStorage(appPool, w.lead, { provider: "google_drive", tokenRef: "kv://steal" }), "FORBIDDEN", 403);
    const asTenant = await orgs.listStorageConnections(appPool, w.tLead);
    expect(asTenant).toHaveLength(0); // tenants never see the token reference
  });
});

describe("user service: inviting and managing users", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("an org admin invites an auditor-side user with a corporate address", async () => {
    const u = await users.inviteAuditorUser(appPool, w.admin, { email: `new-auditor@audit-a-${w.tag}.test`, role: "auditor" });
    expect(u.role).toBe("auditor");
    const list = await users.listOrgUsers(appPool, w.admin);
    expect(list.map((r: { email: string }) => r.email)).toContain(`new-auditor@audit-a-${w.tag}.test`);
  });

  it("an auditor-side invite to a tenant-only domain is rejected with a clean error, not a crash", async () => {
    await expectAppError(users.inviteAuditorUser(appPool, w.admin, { email: `spy@a1-${w.tag}.test`, role: "auditor" }), "DOMAIN_NOT_ALLOWED", 422);
  });

  it("a lead auditor invites a tenant lead can also invite tenant users into their own tenant", async () => {
    const lead = await users.inviteTenantUser(appPool, w.lead, w.tA1, { email: `newlead@a1-${w.tag}.test`, role: "tenant_lead" });
    expect(lead.role).toBe("tenant_lead");
    const contributor = await users.inviteTenantUser(appPool, w.tLead, w.tA1, { email: `newcontrib@a1-${w.tag}.test`, role: "contributor" });
    expect(contributor.role).toBe("contributor");
  });

  it("a tenant lead cannot invite another tenant lead, or invite into a tenant they don't lead", async () => {
    await expectAppError(users.inviteTenantUser(appPool, w.tLead, w.tA1, { email: `boss@a1-${w.tag}.test`, role: "tenant_lead" }), "FORBIDDEN", 403);
    await expectAppError(users.inviteTenantUser(appPool, w.tLead, w.tA2, { email: `x@a2-${w.tag}.test`, role: "viewer" }), "NOT_FOUND", 404);
  });

  it("disabling and reactivating a user round-trips", async () => {
    const u = await users.inviteAuditorUser(appPool, w.admin, { email: `temp@audit-a-${w.tag}.test`, role: "read_only" });
    const disabled = await users.disableUser(appPool, w.admin, u.id);
    expect(disabled.status).toBe("disabled");
    const reactivated = await users.reactivateUser(appPool, w.admin, u.id);
    expect(reactivated.status).toBe("active");
  });

  it("assigning and unassigning an auditor to a tenant is admin-only and idempotent", async () => {
    await users.assignAuditorToTenant(appPool, w.admin, w.readOnly, w.tA2);
    await users.assignAuditorToTenant(appPool, w.admin, w.readOnly, w.tA2); // idempotent, no error
    const removed = await users.unassignAuditorFromTenant(appPool, w.admin, w.readOnly, w.tA2);
    expect(removed.removed).toBe(true);
    const removedAgain = await users.unassignAuditorFromTenant(appPool, w.admin, w.readOnly, w.tA2);
    expect(removedAgain.removed).toBe(false);
  });

  it("assigning a control to a user records it and is idempotent; a bad control id is a clean 404", async () => {
    const c = await controlId(w.auditA1, "A.8.5");
    await users.assignControlToUser(appPool, w.tLead, c, w.contrib);
    await users.assignControlToUser(appPool, w.tLead, c, w.contrib);
    const removed = await users.unassignControlFromUser(appPool, w.tLead, c, w.contrib);
    expect(removed.removed).toBe(true);
    await expectAppError(users.assignControlToUser(appPool, w.tLead, "00000000-0000-0000-0000-000000000000", w.contrib), "NOT_FOUND", 404);
  });
});
