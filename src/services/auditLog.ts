import type { PoolClient } from "pg";

export interface AuditLogInput {
  orgId: string;
  tenantId?: string | null;
  actorId: string;
  action: string;
  entity?: string;
  entityId?: string;
  change?: unknown;
}

/**
 * Writes one audit log entry, in the same transaction as the action it records (call this from inside
 * an existing `withUser` callback, using the same `c`). Never call this in its own transaction for an
 * action that also writes other rows — the whole point of the audit trail is that a logged action and
 * its entry are atomic: either both commit or neither does.
 */
export async function logAudit(c: PoolClient, entry: AuditLogInput): Promise<void> {
  await c.query(
    "INSERT INTO audit_log (org_id, tenant_id, actor_id, action, entity, entity_id, change) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [entry.orgId, entry.tenantId ?? null, entry.actorId, entry.action, entry.entity ?? null, entry.entityId ?? null, entry.change ? JSON.stringify(entry.change) : null],
  );
}
