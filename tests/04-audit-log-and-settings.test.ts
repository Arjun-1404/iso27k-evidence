import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PoolClient } from "pg";
import { adminPool, appPool, as, makeWorld, denied, type World } from "./helpers";

afterAll(async () => { await adminPool.end(); await appPool.end(); });

let w: World;
const log = (uid: string, org: string, action: string, extra: { tenant?: string | null; actor?: string } = {}) => (c: PoolClient) =>
  c.query("INSERT INTO audit_log (org_id, tenant_id, actor_id, action, entity, entity_id, change) VALUES ($1,$2,$3,$4,'audit_control','c1','{\"to\":\"accepted\"}')",
    [org, extra.tenant ?? null, extra.actor ?? uid, action]);
const verify = async (org: string) => (await adminPool.query("SELECT verify_audit_chain($1) AS bad", [org])).rows[0].bad as string | null;

describe("tamper-evident audit log", () => {
  beforeAll(async () => { w = await makeWorld(); });

  it("every entry links to the previous one and the chain verifies", async () => {
    for (let i = 0; i < 5; i++) await as(w.lead, log(w.lead, w.orgA, `step.${i}`, { tenant: w.tA1 }));
    const rows = (await adminPool.query("SELECT seq, prev_hash, hash FROM audit_log WHERE org_id=$1 ORDER BY seq", [w.orgA])).rows;
    expect(rows.length).toBe(5);
    expect(rows[0].prev_hash).toBe("genesis");
    for (let i = 1; i < rows.length; i++) expect(rows[i].prev_hash).toBe(rows[i - 1].hash);
    expect(await verify(w.orgA)).toBeNull();
  });

  it("each org has its own chain (org B starts from genesis, unaffected by org A)", async () => {
    await as(w.leadB, log(w.leadB, w.orgB, "b.first"));
    const r = (await adminPool.query("SELECT prev_hash FROM audit_log WHERE org_id=$1", [w.orgB])).rows;
    expect(r[0].prev_hash).toBe("genesis");
    expect(await verify(w.orgB)).toBeNull();
  });

  it("nobody can write an entry as someone else, into another org, or for a tenant they cannot see", async () => {
    await denied(as(w.auditor, log(w.auditor, w.orgA, "forged", { actor: w.lead })), /row-level security/);
    await denied(as(w.auditor, log(w.auditor, w.orgB, "cross-org")), /row-level security/);
    await denied(as(w.auditor, log(w.auditor, w.orgA, "wrong-tenant", { tenant: w.tA2 })), /row-level security/);
  });

  it("the application cannot change or delete entries; even a superuser update is blocked by the database", async () => {
    await denied(as(w.admin, (c) => c.query("UPDATE audit_log SET action='x'")), /permission denied/);
    await denied(as(w.admin, (c) => c.query("DELETE FROM audit_log")), /permission denied/);
    await denied(adminPool.query("UPDATE audit_log SET action='x' WHERE org_id=$1", [w.orgA]), /AUDIT_LOG_IMMUTABLE/);
    await denied(adminPool.query("DELETE FROM audit_log WHERE org_id=$1", [w.orgA]), /AUDIT_LOG_IMMUTABLE/);
  });

  it("if someone bypasses the triggers and edits a row, verification pinpoints the first altered entry", async () => {
    const before = (await adminPool.query("SELECT seq FROM audit_log WHERE org_id=$1 ORDER BY seq", [w.orgA])).rows;
    const target = before[2].seq as string;
    const c = await adminPool.connect();
    try {
      await c.query("SET session_replication_role = replica");           // superuser-only trick that skips triggers
      await c.query("UPDATE audit_log SET action='tampered' WHERE seq=$1", [target]);
      await c.query("SET session_replication_role = origin");
    } finally { c.release(); }
    expect(await verify(w.orgA)).toBe(target);
    expect(await verify(w.orgB)).toBeNull();                              // the other org's chain is intact
  });

  it("verification does not depend on the database time zone", async () => {
    const w2 = await makeWorld();
    for (let i = 0; i < 3; i++) await as(w2.lead, log(w2.lead, w2.orgA, `tz.${i}`));
    const c = await adminPool.connect();
    try {
      for (const tz of ["UTC", "Asia/Kolkata", "America/Los_Angeles"]) {
        await c.query(`SET TIME ZONE '${tz}'`);
        expect((await c.query("SELECT verify_audit_chain($1) AS bad", [w2.orgA])).rows[0].bad, tz).toBeNull();
      }
    } finally { c.release(); }
  });

  it("20 simultaneous writers still produce one unbroken chain with unique sequence numbers", async () => {
    const w3 = await makeWorld();
    const res = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => as(w3.lead, log(w3.lead, w3.orgA, `parallel.${i}`))));
    expect(res.every((r) => r.status === "fulfilled")).toBe(true);
    const rows = (await adminPool.query("SELECT seq FROM audit_log WHERE org_id=$1", [w3.orgA])).rows;
    expect(new Set(rows.map((r) => r.seq)).size).toBe(20);
    expect(await verify(w3.orgA)).toBeNull();
  });

  it("only org admins and lead auditors can read the log, and only their own org's", async () => {
    const w4 = await makeWorld();
    await as(w4.lead, log(w4.lead, w4.orgA, "visible.to.leads"));
    await as(w4.contrib, log(w4.contrib, w4.orgA, "written.by.tenant.user", { tenant: w4.tA1 }));   // tenant users may write...
    for (const u of [w4.admin, w4.lead]) expect((await as(u, (c) => c.query("SELECT count(*)::int AS n FROM audit_log"))).rows[0].n).toBe(2);
    for (const u of [w4.auditor, w4.readOnly, w4.dash, w4.tLead, w4.contrib, w4.viewer, w4.adminB, w4.leadB])
      expect((await as(u, (c) => c.query("SELECT count(*)::int AS n FROM audit_log"))).rows[0].n).toBe(0);  // ...but not read
  });
});

describe("organisation settings", () => {
  beforeAll(async () => { w = await makeWorld(); });

  it("the org admin can change name, storage provider and allowed domains", async () => {
    const r = await as(w.admin, (c) => c.query("UPDATE orgs SET name='Renamed', storage_provider='sharepoint', allowed_domains=ARRAY['new-domain.test'] WHERE id=$1", [w.orgA]));
    expect(r.rowCount).toBe(1);
  });

  it("nobody else can, and the status can never be changed by the app, nor can a new org be created outside onboarding", async () => {
    for (const u of [w.lead, w.auditor, w.tLead]) expect((await as(u, (c) => c.query("UPDATE orgs SET name='x' WHERE id=$1", [w.orgA]))).rowCount).toBe(0);
    await denied(as(w.admin, (c) => c.query("UPDATE orgs SET status='suspended' WHERE id=$1", [w.orgA])), /permission denied/);
    await denied(as(w.admin, (c) => c.query("INSERT INTO orgs (name, allowed_domains) VALUES ('rogue',ARRAY['x.test'])")), /permission denied/);
    await denied(as(w.admin, (c) => c.query("DELETE FROM orgs")), /permission denied/);
  });

  it("auditor assignments are managed by the org admin only", async () => {
    const ins = (uid: string) => (c: PoolClient) => c.query("INSERT INTO auditor_assignments (org_id, user_id, tenant_id) VALUES ($1,$2,$3)", [w.orgA, w.auditor, w.tA2]);
    await denied(as(w.lead, ins(w.lead)), /row-level security/);
    await as(w.admin, ins(w.admin));
    expect((await as(w.auditor, (c) => c.query("SELECT id FROM tenants"))).rowCount).toBe(2);   // now sees A2 too
    await as(w.admin, (c) => c.query("DELETE FROM auditor_assignments WHERE user_id=$1 AND tenant_id=$2", [w.auditor, w.tA2]));
    expect((await as(w.auditor, (c) => c.query("SELECT id FROM tenants"))).rowCount).toBe(1);
  });
});
