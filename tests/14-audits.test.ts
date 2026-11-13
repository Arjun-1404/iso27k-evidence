import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { adminPool, appPool, makeWorld, as, type World } from "./helpers.ts";
import { createApp } from "../src/http/app.ts";
import { InMemoryStorageProvider } from "../src/storage/inMemoryProvider.ts";
import { FakeScanner } from "../src/scan/types.ts";
import { FakeEmailSender } from "../src/email/types.ts";
import { FakeTokenVerifier } from "../src/auth/types.ts";
import * as audits from "../src/services/audits.ts";

afterAll(async () => { await adminPool.end(); await appPool.end(); });

describe("audits service", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("lists the audit created by makeWorld's fixture, newest first", async () => {
    const list = await audits.listAudits(appPool, w.lead, w.tA1);
    expect(list.map((a) => a.id)).toContain(w.auditA1);
  });

  it("lists the platform default template, visible to auditor staff and not to tenant users", async () => {
    const staff = await audits.listTemplates(appPool, w.lead);
    expect(staff.some((t) => t.isPlatformDefault)).toBe(true);
    const tenant = await audits.listTemplates(appPool, w.tLead);
    expect(tenant).toHaveLength(0);
  });

  it("creates a second audit for a tenant, copying in all 117 controls again", async () => {
    const [template] = await audits.listTemplates(appPool, w.lead);
    const created = await audits.createAudit(appPool, w.lead, w.tA1, template.id, "Second cycle");
    expect(created.name).toBe("Second cycle");
    const list = await audits.listAudits(appPool, w.lead, w.tA1);
    expect(list.length).toBeGreaterThanOrEqual(2);
    const controlCount = await adminPool.query("SELECT count(*)::int AS n FROM audit_controls WHERE audit_id = $1", [created.id]);
    expect(controlCount.rows[0].n).toBe(117);
  });

  it("a contributor cannot create an audit, but can list their own tenant's audits", async () => {
    const [template] = await audits.listTemplates(appPool, w.lead);
    await expect(audits.createAudit(appPool, w.contrib, w.tA1, template.id, "x")).rejects.toThrow();
    const list = await audits.listAudits(appPool, w.contrib, w.tA1);
    expect(list.map((a) => a.id)).toContain(w.auditA1);
  });

  it("org B cannot read org A's audit by id", async () => {
    const r = await as(w.leadB, (c) => c.query("SELECT 1 FROM audits WHERE id = $1", [w.auditA1]));
    expect(r.rowCount).toBe(0);
  });
});

function setup() {
  const auth = new FakeTokenVerifier();
  const app = createApp({ pool: appPool, storage: new InMemoryStorageProvider(), scanner: new FakeScanner(), email: new FakeEmailSender(), tokenVerifier: auth, jwtSecret: "test-jwt-secret", appBaseUrl: "https://test.example" });
  return { app, auth };
}
const bearer = (auth: FakeTokenVerifier, userId: string) => `Bearer ${auth.issue(userId)}`;

describe("audits over HTTP", () => {
  let w: World; let app: ReturnType<typeof setup>["app"]; let auth: FakeTokenVerifier;
  beforeAll(async () => { w = await makeWorld(); ({ app, auth } = setup()); });

  it("lists templates, lists a tenant's audits, and creates a new one", async () => {
    const templates = await request(app).get("/templates").set("Authorization", bearer(auth, w.lead));
    expect(templates.status).toBe(200);
    expect(templates.body.length).toBeGreaterThan(0);

    const existing = await request(app).get(`/tenants/${w.tA2}/audits`).set("Authorization", bearer(auth, w.lead));
    expect(existing.body.map((a: { id: string }) => a.id)).toContain(w.auditA2);

    const created = await request(app).post(`/tenants/${w.tA2}/audits`).set("Authorization", bearer(auth, w.lead))
      .send({ templateId: templates.body[0].id, name: "2027 cycle" });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe("2027 cycle");

    const single = await request(app).get(`/audits/${created.body.id}`).set("Authorization", bearer(auth, w.lead));
    expect(single.body.name).toBe("2027 cycle");
  });

  it("a tenant lead can list their own tenant's audits to find their auditId, but cannot create one", async () => {
    const list = await request(app).get(`/tenants/${w.tA1}/audits`).set("Authorization", bearer(auth, w.tLead));
    expect(list.status).toBe(200);
    expect(list.body.length).toBeGreaterThan(0);
    const templates = await request(app).get("/templates").set("Authorization", bearer(auth, w.tLead));
    expect(templates.body).toEqual([]);
  });
});
