import type { Pool, PoolClient } from "pg";
import { withUser } from "../db/pool.ts";
import { AppError, mapDbError } from "../errors.ts";
import { logAudit } from "./auditLog.ts";

export interface AuditSummary {
  id: string; name: string; status: string; templateVersion: string; createdAt: Date;
  /** When the cycle was closed (read-only), or null while it is open. */
  closedAt: Date | null;
  /** Who closed it, by name; null while open, or if the viewer isn't allowed to see that person (client-side users). */
  closedBy: string | null;
}

const SUMMARY_SQL = `SELECT a.id, a.name, a.status, a.template_version, a.created_at, a.closed_at,
                            COALESCE(NULLIF(btrim(u.full_name), ''), u.email) AS closed_by
                     FROM audits a LEFT JOIN users u ON u.id = a.closed_by`;

const toSummary = (row: Record<string, unknown>): AuditSummary => ({
  id: row.id as string, name: row.name as string, status: row.status as string, templateVersion: row.template_version as string,
  createdAt: row.created_at as Date, closedAt: (row.closed_at as Date | null) ?? null, closedBy: (row.closed_by as string | null) ?? null,
});

export async function listAudits(pool: Pool, userId: string, tenantId: string): Promise<AuditSummary[]> {
  return withUser(pool, userId, (c) =>
    c.query(`${SUMMARY_SQL} WHERE a.tenant_id = $1 ORDER BY a.created_at DESC`, [tenantId]).then((r) => r.rows.map(toSummary)));
}

export async function getAudit(pool: Pool, userId: string, auditId: string): Promise<AuditSummary> {
  return withUser(pool, userId, (c) => getAuditOn(c, auditId));
}

async function getAuditOn(c: PoolClient, auditId: string): Promise<AuditSummary> {
  const r = await c.query(`${SUMMARY_SQL} WHERE a.id = $1`, [auditId]);
  if (r.rowCount === 0) throw new AppError("Audit not found or not visible to you.", 404, "NOT_FOUND");
  return toSummary(r.rows[0]);
}

export interface TemplateSummary { id: string; framework: string; version: string; name: string; isPlatformDefault: boolean }

/** The platform's default template plus (if the caller's org has customised one) their own. Visible
 *  only to auditor-side staff — RLS on control_templates already enforces that; this just shapes it. */
export async function listTemplates(pool: Pool, userId: string): Promise<TemplateSummary[]> {
  return withUser(pool, userId, (c) =>
    c.query("SELECT id, framework, version, name, org_id FROM control_templates ORDER BY org_id NULLS FIRST")
      .then((r) => r.rows.map((row) => ({ id: row.id, framework: row.framework, version: row.version, name: row.name, isPlatformDefault: row.org_id === null }))));
}

/** Creates a new audit for a tenant from a template (copying its controls in), and logs it. */
export async function createAudit(pool: Pool, userId: string, tenantId: string, templateId: string, name: string): Promise<AuditSummary> {
  return withUser(pool, userId, async (c) => {
    try {
      const r = await c.query("SELECT create_audit($1,$2,$3) AS id", [tenantId, templateId, name]);
      const id = r.rows[0].id as string;
      const audit = await c.query("SELECT org_id, tenant_id FROM audits WHERE id = $1", [id]);
      const row = audit.rows[0];
      await logAudit(c, { orgId: row.org_id, tenantId: row.tenant_id, actorId: userId, action: "audit.created", entity: "audit", entityId: id, change: { name } });
      return await getAuditOn(c, id);
    } catch (e) {
      throw e instanceof AppError ? e : mapDbError(e);
    }
  });
}

/**
 * Closes an audit cycle: from now on nothing in it can change (see migration 014). Lead auditors and organisation
 * admins only. The database writes the audit-log entry itself, in the same step, so a close is never unlogged.
 */
export async function closeAudit(pool: Pool, userId: string, auditId: string): Promise<AuditSummary> {
  return withUser(pool, userId, async (c) => {
    try {
      await c.query("SELECT audit_close($1)", [auditId]);
      return await getAuditOn(c, auditId);
    } catch (e) {
      throw e instanceof AppError ? e : mapDbError(e);
    }
  });
}

/** Opens a closed cycle again. The reason (3 to 1000 characters) is written to the audit log. */
export async function reopenAudit(pool: Pool, userId: string, auditId: string, reason: string): Promise<AuditSummary> {
  return withUser(pool, userId, async (c) => {
    try {
      await c.query("SELECT audit_reopen($1, $2)", [auditId, reason]);
      return await getAuditOn(c, auditId);
    } catch (e) {
      throw e instanceof AppError ? e : mapDbError(e);
    }
  });
}
