import { Pool, type PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { withUser } from "../src/db/pool";

export const PORT = 54329;
/** Superuser pool: fixtures only. Bypasses row-level security, exactly like an admin script would. */
export const adminPool = new Pool({ host: "127.0.0.1", port: PORT, user: "postgres", database: "portal_test", max: 5 });
/** Application pool: the same restricted role the real app uses. */
export const appPool = new Pool({ host: "127.0.0.1", port: PORT, user: "portal_app", database: "portal_test", max: 10 });

export const as = <T>(userId: string, fn: (c: PoolClient) => Promise<T>) => withUser(appPool, userId, fn);

export interface World {
  tag: string;
  orgA: string; orgB: string;
  tA1: string; tA2: string; tB1: string;
  // org A auditor side
  admin: string; lead: string; auditor: string; readOnly: string; dash: string;
  // tenant A1 users
  tLead: string; contrib: string; viewer: string; tDash: string;
  // tenant A2 and org B
  tLead2: string; adminB: string; leadB: string; tLeadB: string;
  auditA1: string; auditA2: string; auditB1: string;
  templateId: string;
}

async function insertUser(c: Pool, org: string, tenant: string | null, email: string, role: string, name: string): Promise<string> {
  const r = await c.query(
    "INSERT INTO users (org_id, tenant_id, email, full_name, role, status) VALUES ($1,$2,$3,$4,$5,'active') RETURNING id",
    [org, tenant, email, name, role]);
  return r.rows[0].id as string;
}

/**
 * Builds two audit companies with tenants, users and audits (created through the real create_audit function).
 * Org A: 2 tenants. auditor/readOnly/dash/lead are assigned to tenant A1 only; lead is also assigned to A2.
 */
export async function makeWorld(): Promise<World> {
  const tag = randomUUID().slice(0, 8);
  const mkOrg = async (n: string, dom: string) =>
    (await adminPool.query("INSERT INTO orgs (name, allowed_domains) VALUES ($1,$2) RETURNING id", [n, [dom]])).rows[0].id as string;
  const orgA = await mkOrg(`Org A ${tag}`, `audit-a-${tag}.test`);
  const orgB = await mkOrg(`Org B ${tag}`, `audit-b-${tag}.test`);
  const mkTenant = async (org: string, n: string, dom: string) =>
    (await adminPool.query("INSERT INTO tenants (org_id, name, allowed_domains) VALUES ($1,$2,$3) RETURNING id", [org, n, [dom]])).rows[0].id as string;
  const tA1 = await mkTenant(orgA, "Tenant A1", `a1-${tag}.test`);
  const tA2 = await mkTenant(orgA, "Tenant A2", `a2-${tag}.test`);
  const tB1 = await mkTenant(orgB, "Tenant B1", `b1-${tag}.test`);

  const dA = `audit-a-${tag}.test`, dB = `audit-b-${tag}.test`;
  const admin = await insertUser(adminPool, orgA, null, `admin@${dA}`, "org_admin", "Admin A");
  const lead = await insertUser(adminPool, orgA, null, `lead@${dA}`, "lead_auditor", "Lead A");
  const auditor = await insertUser(adminPool, orgA, null, `auditor@${dA}`, "auditor", "Auditor A");
  const readOnly = await insertUser(adminPool, orgA, null, `ro@${dA}`, "read_only", "ReadOnly A");
  const dash = await insertUser(adminPool, orgA, null, `dash@${dA}`, "dashboard_only", "Dash A");
  const tLead = await insertUser(adminPool, orgA, tA1, `lead@a1-${tag}.test`, "tenant_lead", "TLead A1");
  const contrib = await insertUser(adminPool, orgA, tA1, `contrib@a1-${tag}.test`, "contributor", "Contrib A1");
  const viewer = await insertUser(adminPool, orgA, tA1, `viewer@a1-${tag}.test`, "viewer", "Viewer A1");
  const tDash = await insertUser(adminPool, orgA, tA1, `dash@a1-${tag}.test`, "tenant_dashboard", "TDash A1");
  const tLead2 = await insertUser(adminPool, orgA, tA2, `lead@a2-${tag}.test`, "tenant_lead", "TLead A2");
  const adminB = await insertUser(adminPool, orgB, null, `admin@${dB}`, "org_admin", "Admin B");
  const leadB = await insertUser(adminPool, orgB, null, `lead@${dB}`, "lead_auditor", "Lead B");
  const tLeadB = await insertUser(adminPool, orgB, tB1, `lead@b1-${tag}.test`, "tenant_lead", "TLead B1");

  for (const [u, t] of [[lead, tA1], [lead, tA2], [auditor, tA1], [readOnly, tA1], [dash, tA1]] as const) {
    await adminPool.query("INSERT INTO auditor_assignments (org_id, user_id, tenant_id) VALUES ($1,$2,$3)", [orgA, u, t]);
  }
  await adminPool.query("INSERT INTO auditor_assignments (org_id, user_id, tenant_id) VALUES ($1,$2,$3)", [orgB, leadB, tB1]);

  const templateId = (await adminPool.query("SELECT id FROM control_templates WHERE org_id IS NULL LIMIT 1")).rows[0].id as string;
  const auditA1 = (await as(lead, (c) => c.query("SELECT create_audit($1,$2,$3) AS id", [tA1, templateId, "A1 audit"]))).rows[0].id as string;
  const auditA2 = (await as(lead, (c) => c.query("SELECT create_audit($1,$2,$3) AS id", [tA2, templateId, "A2 audit"]))).rows[0].id as string;
  const auditB1 = (await as(leadB, (c) => c.query("SELECT create_audit($1,$2,$3) AS id", [tB1, templateId, "B1 audit"]))).rows[0].id as string;

  return { tag, orgA, orgB, tA1, tA2, tB1, admin, lead, auditor, readOnly, dash, tLead, contrib, viewer, tDash, tLead2,
    adminB, leadB, tLeadB, auditA1, auditA2, auditB1, templateId };
}

/** Returns the id of a control (by reference, e.g. "A.8.5") inside an audit, read through the admin pool. */
export async function controlId(auditId: string, ref: string): Promise<string> {
  const r = await adminPool.query("SELECT id FROM audit_controls WHERE audit_id=$1 AND control_ref=$2", [auditId, ref]);
  return r.rows[0].id as string;
}

/** Assigns a contributor to a control, the way a tenant lead would. Contributors can only see and
 *  act on controls they're explicitly assigned to (see the RLS tests) — most service-layer tests
 *  need this fixture before they can exercise a contributor's upload path. */
export async function assignContributor(w: World, controlId: string, userId = w.contrib, tenantLeadId = w.tLead) {
  await as(tenantLeadId, (c) =>
    c.query("INSERT INTO control_assignments (org_id, tenant_id, audit_control_id, user_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [w.orgA, w.tA1, controlId, userId]));
}

/** Adds a fake evidence file to a control (fixture, via admin pool). */
export async function addEvidence(org: string, tenant: string, control: string, by: string | null, name = "evidence.pdf") {
  await adminPool.query(
    `INSERT INTO evidence_files (org_id, tenant_id, audit_control_id, provider_file_id, file_name, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6)`, [org, tenant, control, `f-${Math.random().toString(36).slice(2)}`, name, by]);
}

/** Asserts that a database call is rejected, optionally matching the error text. */
export async function denied(p: Promise<unknown>, match?: RegExp) {
  let err: Error | undefined;
  try { await p; } catch (e) { err = e as Error; }
  if (!err) throw new Error("Expected the database to reject this operation, but it succeeded");
  if (match && !match.test(err.message)) throw new Error(`Rejected, but with an unexpected message: ${err.message}`);
}
