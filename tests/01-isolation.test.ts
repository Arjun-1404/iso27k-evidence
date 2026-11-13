import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { adminPool, appPool, as, makeWorld, controlId, denied, type World } from "./helpers";
import { withoutUser } from "../src/db/pool";

let w: World;
beforeAll(async () => { w = await makeWorld(); });
afterAll(async () => { await adminPool.end(); await appPool.end(); });

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

describe("isolation between audit companies (orgs)", () => {
  it("an org admin sees only their own org's tenants", async () => {
    const r = await as(w.admin, (c) => c.query("SELECT id FROM tenants"));
    expect(ids(r.rows)).toEqual([w.tA1, w.tA2].sort());
  });

  it("org B cannot see any org A tenant, user, audit or control, even when asking by exact id", async () => {
    const t = await as(w.adminB, (c) => c.query("SELECT id FROM tenants WHERE id = ANY($1)", [[w.tA1, w.tA2]]));
    const u = await as(w.adminB, (c) => c.query("SELECT id FROM users WHERE id = $1", [w.lead]));
    const a = await as(w.leadB, (c) => c.query("SELECT id FROM audits WHERE id = $1", [w.auditA1]));
    const k = await as(w.leadB, (c) => c.query("SELECT id FROM audit_controls WHERE audit_id = $1", [w.auditA1]));
    expect([t.rowCount, u.rowCount, a.rowCount, k.rowCount]).toEqual([0, 0, 0, 0]);
  });

  it("org A cannot create data inside org B's tenant", async () => {
    await denied(as(w.admin, (c) => c.query("INSERT INTO tenants (org_id, name, allowed_domains) VALUES ($1,'x',ARRAY['x.test'])", [w.orgB])), /row-level security/);
    await denied(as(w.lead, (c) => c.query("SELECT create_audit($1,$2,'evil')", [w.tB1, w.templateId])));
  });

  it("org A cannot modify org B rows (update touches zero rows)", async () => {
    const r = await as(w.adminB, (c) => c.query("SELECT id FROM tenants"));
    expect(r.rowCount).toBe(1);
    const upd = await as(w.admin, (c) => c.query("UPDATE tenants SET name='hacked' WHERE id = $1", [w.tB1]));
    expect(upd.rowCount).toBe(0);
    const still = await adminPool.query("SELECT name FROM tenants WHERE id=$1", [w.tB1]);
    expect(still.rows[0].name).toBe("Tenant B1");
  });
});

describe("isolation between tenants of the same org", () => {
  it("tenant users see only their own tenant", async () => {
    const r = await as(w.contrib, (c) => c.query("SELECT id FROM tenants"));
    expect(ids(r.rows)).toEqual([w.tA1]);
    const other = await as(w.tLead2, (c) => c.query("SELECT id FROM tenants"));
    expect(ids(other.rows)).toEqual([w.tA2]);
  });

  it("a tenant lead cannot read the other tenant's audit or controls", async () => {
    const a = await as(w.tLead, (c) => c.query("SELECT id FROM audits"));
    expect(ids(a.rows)).toEqual([w.auditA1]);
    const k = await as(w.tLead, (c) => c.query("SELECT count(*)::int AS n FROM audit_controls WHERE audit_id = $1", [w.auditA2]));
    expect(k.rows[0].n).toBe(0);
  });

  it("tenant users see only colleagues in their own tenant, never auditor staff or other tenants", async () => {
    const r = await as(w.viewer, (c) => c.query("SELECT id FROM users"));
    expect(ids(r.rows)).toEqual([w.tLead, w.contrib, w.viewer, w.tDash].sort());
  });

  it("an auditor assigned to tenant A1 only cannot see tenant A2; the org admin sees both", async () => {
    const aud = await as(w.auditor, (c) => c.query("SELECT id FROM tenants"));
    expect(ids(aud.rows)).toEqual([w.tA1]);
    const k = await as(w.auditor, (c) => c.query("SELECT count(*)::int AS n FROM audit_controls WHERE audit_id = $1", [w.auditA2]));
    expect(k.rows[0].n).toBe(0);
    const lead = await as(w.lead, (c) => c.query("SELECT id FROM tenants"));
    expect(ids(lead.rows)).toEqual([w.tA1, w.tA2].sort());
    const adm = await as(w.admin, (c) => c.query("SELECT count(*)::int AS n FROM audit_controls WHERE audit_id = $1", [w.auditA2]));
    expect(adm.rows[0].n).toBe(117);
  });
});

describe("fail closed", () => {
  it("with no user context every table returns zero rows", async () => {
    for (const t of ["orgs", "tenants", "users", "audits", "audit_controls", "evidence_files", "comments", "audit_log", "control_templates"]) {
      const r = await withoutUser(appPool, (c) => c.query(`SELECT count(*)::int AS n FROM ${t}`));
      expect(r.rows[0].n, t).toBe(0);
    }
  });

  it("an unknown user id gets nothing, and so does a disabled user", async () => {
    const unknown = await as("00000000-0000-0000-0000-000000000000", (c) => c.query("SELECT count(*)::int AS n FROM tenants"));
    expect(unknown.rows[0].n).toBe(0);
    await adminPool.query("UPDATE users SET status='disabled' WHERE id=$1", [w.viewer]);
    const disabled = await as(w.viewer, (c) => c.query("SELECT count(*)::int AS n FROM tenants"));
    expect(disabled.rows[0].n).toBe(0);
    await adminPool.query("UPDATE users SET status='active' WHERE id=$1", [w.viewer]);
  });

  it("a malformed user id is rejected before it reaches the database", async () => {
    await denied(as("not-a-uuid'; DROP TABLE users;--", (c) => c.query("SELECT 1")), /invalid user id/);
  });

  it("the application role cannot switch to a more powerful role or read the migrations table", async () => {
    await denied(as(w.admin, (c) => c.query("SET ROLE postgres")));
    await denied(as(w.admin, (c) => c.query("SELECT * FROM schema_migrations")), /permission denied/);
  });
});

describe("contributors, viewers and dashboard-only roles", () => {
  it("a contributor sees no controls until assigned, then only the assigned ones", async () => {
    const before = await as(w.contrib, (c) => c.query("SELECT count(*)::int AS n FROM audit_controls"));
    expect(before.rows[0].n).toBe(0);
    const c85 = await controlId(w.auditA1, "A.8.5");
    const c87 = await controlId(w.auditA1, "A.8.7");
    for (const cid of [c85, c87]) {
      await as(w.tLead, (c) => c.query("INSERT INTO control_assignments (org_id, tenant_id, audit_control_id, user_id) VALUES ($1,$2,$3,$4)", [w.orgA, w.tA1, cid, w.contrib]));
    }
    const after = await as(w.contrib, (c) => c.query("SELECT control_ref FROM audit_controls ORDER BY control_ref"));
    expect(after.rows.map((r) => r.control_ref)).toEqual(["A.8.5", "A.8.7"]);
    const lead = await as(w.tLead, (c) => c.query("SELECT count(*)::int AS n FROM audit_controls"));
    expect(lead.rows[0].n).toBe(117);
    const viewer = await as(w.viewer, (c) => c.query("SELECT count(*)::int AS n FROM audit_controls"));
    expect(viewer.rows[0].n).toBe(117);
  });

  it("a contributor cannot be assigned controls in another tenant, and cannot assign controls themselves", async () => {
    const c85 = await controlId(w.auditA1, "A.8.5");
    await denied(as(w.contrib, (c) => c.query("INSERT INTO control_assignments (org_id, tenant_id, audit_control_id, user_id) VALUES ($1,$2,$3,$4)", [w.orgA, w.tA1, c85, w.viewer])), /row-level security/);
    const c2 = await controlId(w.auditA2, "A.8.5");
    await denied(as(w.tLead, (c) => c.query("INSERT INTO control_assignments (org_id, tenant_id, audit_control_id, user_id) VALUES ($1,$2,$3,$4)", [w.orgA, w.tA2, c2, w.contrib])));
  });

  it("dashboard-only roles cannot read control detail, only aggregate numbers", async () => {
    for (const u of [w.dash, w.tDash]) {
      const audits = await as(u, (c) => c.query("SELECT count(*)::int AS n FROM audits"));
      const controls = await as(u, (c) => c.query("SELECT count(*)::int AS n FROM audit_controls"));
      expect([audits.rows[0].n, controls.rows[0].n]).toEqual([0, 0]);
    }
    const s = await as(w.dash, (c) => c.query("SELECT dashboard_summary($1) AS s", [w.auditA1]));
    expect(s.rows[0].s.total).toBe(117);
    const t = await as(w.tDash, (c) => c.query("SELECT dashboard_summary($1) AS s", [w.auditA1]));
    expect(t.rows[0].s.applicable).toBe(117);
  });

  it("the dashboard summary refuses audits the caller cannot see", async () => {
    const cross = await as(w.dash, (c) => c.query("SELECT dashboard_summary($1) AS s", [w.auditA2]));
    expect(cross.rows[0].s).toBeNull();
    const other = await as(w.tDash, (c) => c.query("SELECT dashboard_summary($1) AS s", [w.auditB1]));
    expect(other.rows[0].s).toBeNull();
  });
});

describe("storage connections and templates", () => {
  it("only the org admin can create or read a storage connection (token reference is sensitive)", async () => {
    await as(w.admin, (c) => c.query("INSERT INTO storage_connections (org_id, provider, token_ref) VALUES ($1,'google_drive','kv://secret/abc')", [w.orgA]));
    const admin = await as(w.admin, (c) => c.query("SELECT token_ref FROM storage_connections"));
    expect(admin.rowCount).toBe(1);
    for (const u of [w.lead, w.auditor, w.tLead, w.contrib, w.adminB]) {
      const r = await as(u, (c) => c.query("SELECT token_ref FROM storage_connections"));
      expect(r.rowCount).toBe(0);
    }
    await denied(as(w.lead, (c) => c.query("INSERT INTO storage_connections (org_id, provider, token_ref) VALUES ($1,'sharepoint','kv://x')", [w.orgA])), /row-level security/);
  });

  it("the platform template is visible to auditor staff only; org-specific templates stay private to their org", async () => {
    const staff = await as(w.lead, (c) => c.query("SELECT count(*)::int AS n FROM control_templates"));
    expect(staff.rows[0].n).toBeGreaterThanOrEqual(1);
    const tenant = await as(w.tLead, (c) => c.query("SELECT count(*)::int AS n FROM control_templates"));
    expect(tenant.rows[0].n).toBe(0);
    await as(w.lead, (c) => c.query("INSERT INTO control_templates (org_id, framework, version, name) VALUES ($1,'ISO','custom','Org A custom')", [w.orgA]));
    const b = await as(w.leadB, (c) => c.query("SELECT name FROM control_templates WHERE name = 'Org A custom'"));
    expect(b.rowCount).toBe(0);
    await denied(as(w.auditor, (c) => c.query("INSERT INTO control_templates (org_id, framework, version, name) VALUES ($1,'ISO','x','x')", [w.orgA])), /row-level security/);
  });
});
