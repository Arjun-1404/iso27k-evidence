import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { adminPool, appPool, makeWorld, type World } from "./helpers.ts";
import { createApp } from "../src/http/app.ts";
import { InMemoryStorageProvider } from "../src/storage/inMemoryProvider.ts";
import { FakeScanner } from "../src/scan/types.ts";
import { FakeEmailSender } from "../src/email/types.ts";
import { FakeTokenVerifier } from "../src/auth/types.ts";

afterAll(async () => { await adminPool.end(); await appPool.end(); });

function setup() {
  const auth = new FakeTokenVerifier();
  const app = createApp({ pool: appPool, storage: new InMemoryStorageProvider(), scanner: new FakeScanner(), email: new FakeEmailSender(), tokenVerifier: auth, jwtSecret: "test-jwt-secret", appBaseUrl: "https://test.example" });
  return { app, auth };
}
const bearer = (auth: FakeTokenVerifier, userId: string) => `Bearer ${auth.issue(userId)}`;

describe("tenant management over HTTP", () => {
  let w: World; let app: ReturnType<typeof setup>["app"]; let auth: FakeTokenVerifier;
  beforeAll(async () => { w = await makeWorld(); ({ app, auth } = setup()); });

  it("an org admin creates a tenant; a lead auditor cannot", async () => {
    const ok = await request(app).post("/tenants").set("Authorization", bearer(auth, w.admin)).send({ name: "Riverside LLC", allowedDomains: [`riverside-${w.tag}.test`] });
    expect(ok.status).toBe(201);
    expect(ok.body.status).toBe("active");
    const denied = await request(app).post("/tenants").set("Authorization", bearer(auth, w.lead)).send({ name: "x", allowedDomains: ["x.test"] });
    expect(denied.status).toBe(403);
  });

  it("rejects a tenant with no allowed domain at all, before it reaches the database", async () => {
    const res = await request(app).post("/tenants").set("Authorization", bearer(auth, w.admin)).send({ name: "No Domain Co", allowedDomains: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION");
  });

  it("archives, then reactivates, a tenant", async () => {
    const created = await request(app).post("/tenants").set("Authorization", bearer(auth, w.admin)).send({ name: "Cycle Co", allowedDomains: [`cycle-${w.tag}.test`] });
    const archived = await request(app).post(`/tenants/${created.body.id}/archive`).set("Authorization", bearer(auth, w.admin));
    expect(archived.body.status).toBe("archived");
    const reactivated = await request(app).post(`/tenants/${created.body.id}/reactivate`).set("Authorization", bearer(auth, w.admin));
    expect(reactivated.body.status).toBe("active");
  });

  it("sets the tenant's storage root folder", async () => {
    const res = await request(app).patch(`/tenants/${w.tA1}/storage-root`).set("Authorization", bearer(auth, w.admin)).send({ storageRootId: "folder-abc" });
    expect(res.status).toBe(200);
    expect(res.body.storageRootId).toBe("folder-abc");
  });

  it("lists tenants, scoped to the caller's own org", async () => {
    const res = await request(app).get("/tenants").set("Authorization", bearer(auth, w.lead));
    const namesFromOrgB = res.body.filter((t: { name: string }) => t.name === "Tenant B1");
    expect(namesFromOrgB).toHaveLength(0);
  });
});

describe("org settings and storage connection over HTTP", () => {
  let w: World; let app: ReturnType<typeof setup>["app"]; let auth: FakeTokenVerifier;
  beforeAll(async () => { w = await makeWorld(); ({ app, auth } = setup()); });

  it("updates org settings as admin, rejected for anyone else", async () => {
    const ok = await request(app).patch("/org").set("Authorization", bearer(auth, w.admin)).send({ name: "Harbor Audit Partners Ltd" });
    expect(ok.status).toBe(200);
    const denied = await request(app).patch("/org").set("Authorization", bearer(auth, w.auditor)).send({ name: "Hacked" });
    expect(denied.status).toBe(403);
  });

  it("connects storage and never leaks the token reference back over HTTP", async () => {
    const res = await request(app).put("/org/storage-connections").set("Authorization", bearer(auth, w.admin))
      .send({ provider: "google_drive", tokenRef: "kv://secret/abc", accountLabel: "svc-account" });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("kv://secret/abc");
    const list = await request(app).get("/org/storage-connections").set("Authorization", bearer(auth, w.admin));
    expect(JSON.stringify(list.body)).not.toContain("kv://secret/abc");
    const asTenant = await request(app).get("/org/storage-connections").set("Authorization", bearer(auth, w.tLead));
    expect(asTenant.body).toHaveLength(0);
  });
});

describe("user management over HTTP", () => {
  let w: World; let app: ReturnType<typeof setup>["app"]; let auth: FakeTokenVerifier;
  beforeAll(async () => { w = await makeWorld(); ({ app, auth } = setup()); });

  it("invites an auditor-side user with a role, rejects an invalid role before the database sees it", async () => {
    const ok = await request(app).post("/users").set("Authorization", bearer(auth, w.admin)).send({ email: `newbie@audit-a-${w.tag}.test`, role: "auditor" });
    expect(ok.status).toBe(201);
    const badRole = await request(app).post("/users").set("Authorization", bearer(auth, w.admin)).send({ email: `x@audit-a-${w.tag}.test`, role: "super_admin" });
    expect(badRole.status).toBe(400);
  });

  it("invites a tenant user, and a tenant-side role cannot be used for an auditor-side invite", async () => {
    const ok = await request(app).post(`/tenants/${w.tA1}/users`).set("Authorization", bearer(auth, w.tLead)).send({ email: `person@a1-${w.tag}.test`, role: "contributor" });
    expect(ok.status).toBe(201);
    const wrongShape = await request(app).post("/users").set("Authorization", bearer(auth, w.admin)).send({ email: `x@audit-a-${w.tag}.test`, role: "contributor" });
    expect(wrongShape.status).toBe(400);
  });

  it("lists tenant users, visible to the tenant lead and to auditor staff, not to another tenant", async () => {
    const res = await request(app).get(`/tenants/${w.tA1}/users`).set("Authorization", bearer(auth, w.tLead));
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    const other = await request(app).get(`/tenants/${w.tA1}/users`).set("Authorization", bearer(auth, w.tLead2));
    expect(other.body).toHaveLength(0);
  });

  it("disables then reactivates a user", async () => {
    const created = await request(app).post("/users").set("Authorization", bearer(auth, w.admin)).send({ email: `temp2@audit-a-${w.tag}.test`, role: "read_only" });
    const disabled = await request(app).post(`/users/${created.body.id}/disable`).set("Authorization", bearer(auth, w.admin));
    expect(disabled.body.status).toBe("disabled");
    const reactivated = await request(app).post(`/users/${created.body.id}/reactivate`).set("Authorization", bearer(auth, w.admin));
    expect(reactivated.body.status).toBe("active");
  });

  it("assigns and unassigns an auditor to a tenant", async () => {
    const put = await request(app).put(`/tenants/${w.tA2}/auditors/${w.readOnly}`).set("Authorization", bearer(auth, w.admin));
    expect(put.status).toBe(200);
    const del = await request(app).delete(`/tenants/${w.tA2}/auditors/${w.readOnly}`).set("Authorization", bearer(auth, w.admin));
    expect(del.body.removed).toBe(true);
  });

  it("assigns and unassigns a contributor to a control", async () => {
    const controlsList = await request(app).get(`/audits/${w.auditA1}/controls`).set("Authorization", bearer(auth, w.tLead));
    const c85 = controlsList.body.find((c: { controlRef: string }) => c.controlRef === "A.8.5").id;
    const put = await request(app).post(`/controls/${c85}/assignments`).set("Authorization", bearer(auth, w.tLead)).send({ userId: w.contrib });
    expect(put.status).toBe(201);
    const del = await request(app).delete(`/controls/${c85}/assignments/${w.contrib}`).set("Authorization", bearer(auth, w.tLead));
    expect(del.body.removed).toBe(true);
  });
});
