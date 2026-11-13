import type { Pool } from "pg";
import { withUser } from "../db/pool.ts";
import { AppError } from "../errors.ts";

/** The database returns by_status keyed by the status value itself (e.g. "awaiting_evidence"), which
 *  is data, not a field name — the API's camelCase middleware must not rewrite those keys. Reshaping
 *  it into an array here (rather than an object with dynamic keys) sidesteps that entirely: an array
 *  of {status, count} pairs has nothing for the middleware to mistakenly "fix". */
export async function getDashboard(pool: Pool, userId: string, auditId: string) {
  const summary = await withUser(pool, userId, (c) =>
    c.query("SELECT dashboard_summary($1) AS s", [auditId]).then((r) => r.rows[0]?.s));
  if (!summary) throw new AppError("Audit not found or not visible to you.", 404, "NOT_FOUND");
  const byStatus = Object.entries(summary.by_status as Record<string, number>).map(([status, count]) => ({ status, count }));
  return { ...summary, by_status: byStatus };
}

export interface AuditLogEntry {
  seq: string; tenantId: string | null; actorId: string | null; action: string;
  entity: string | null; entityId: string | null; change: unknown; createdAt: Date;
}

/** Org admins and lead auditors only (enforced by RLS) — everyone else gets an empty list, not an error. */
export async function listAuditLog(pool: Pool, userId: string, limit = 200): Promise<AuditLogEntry[]> {
  return withUser(pool, userId, (c) =>
    c.query(
      `SELECT seq, tenant_id, actor_id, action, entity, entity_id, change, created_at
       FROM audit_log ORDER BY seq DESC LIMIT $1`, [Math.min(limit, 500)],
    ).then((r) => r.rows.map((row) => ({
      seq: row.seq, tenantId: row.tenant_id, actorId: row.actor_id, action: row.action,
      entity: row.entity, entityId: row.entity_id, change: row.change, createdAt: row.created_at,
    }))));
}
