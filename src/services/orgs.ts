import type { Pool } from "pg";
import { withUser } from "../db/pool.ts";
import { AppError, mapDbError } from "../errors.ts";
import { logAudit } from "./auditLog.ts";

export interface NewTenant { name: string; allowedDomains: string[]; exceptionEmails?: string[] }

/** Creates a tenant under the caller's own org. org_id is derived from the caller's own user row
 *  (never accepted from the client), so there is no way to create a tenant in someone else's org. */
export async function createTenant(pool: Pool, userId: string, t: NewTenant) {
  return withUser(pool, userId, async (c) => {
    try {
      const r = await c.query(
        `INSERT INTO tenants (org_id, name, allowed_domains, exception_emails)
         SELECT org_id, $2, $3, $4 FROM users WHERE id = $1 RETURNING id, org_id, name, status`,
        [userId, t.name, t.allowedDomains, t.exceptionEmails ?? []],
      );
      if (r.rowCount === 0) throw new AppError("Could not resolve your organisation.", 403, "FORBIDDEN");
      const row = r.rows[0];
      await logAudit(c, { orgId: row.org_id, tenantId: row.id, actorId: userId, action: "tenant.created", entity: "tenant", entityId: row.id, change: { name: t.name } });
      return { id: row.id, name: row.name, status: row.status };
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw mapDbError(e);
    }
  });
}

export async function listTenants(pool: Pool, userId: string) {
  return withUser(pool, userId, (c) => c.query("SELECT id, name, status, storage_root_id FROM tenants ORDER BY name").then((r) => r.rows));
}

async function setTenantStatus(pool: Pool, userId: string, tenantId: string, status: "active" | "archived") {
  return withUser(pool, userId, async (c) => {
    try {
      const r = await c.query("UPDATE tenants SET status = $2 WHERE id = $1 RETURNING id, status, org_id", [tenantId, status]);
      if (r.rowCount === 0) throw new AppError("Tenant not found or not visible to you.", 404, "NOT_FOUND");
      const row = r.rows[0];
      await logAudit(c, { orgId: row.org_id, tenantId: row.id, actorId: userId, action: `tenant.${status}`, entity: "tenant", entityId: row.id });
      return { id: row.id, status: row.status };
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw mapDbError(e);
    }
  });
}
export const archiveTenant = (pool: Pool, userId: string, tenantId: string) => setTenantStatus(pool, userId, tenantId, "archived");
export const reactivateTenant = (pool: Pool, userId: string, tenantId: string) => setTenantStatus(pool, userId, tenantId, "active");

export async function setTenantStorageRoot(pool: Pool, userId: string, tenantId: string, storageRootId: string) {
  return withUser(pool, userId, async (c) => {
    try {
      const r = await c.query("UPDATE tenants SET storage_root_id = $2 WHERE id = $1 RETURNING id, storage_root_id, org_id", [tenantId, storageRootId]);
      if (r.rowCount === 0) throw new AppError("Tenant not found or not visible to you.", 404, "NOT_FOUND");
      const row = r.rows[0];
      await logAudit(c, { orgId: row.org_id, tenantId: row.id, actorId: userId, action: "tenant.storage_root_set", entity: "tenant", entityId: row.id });
      return { id: row.id, storage_root_id: row.storage_root_id };
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw mapDbError(e);
    }
  });
}

export interface OrgSettingsUpdate { name?: string; storageProvider?: "google_drive" | "sharepoint"; allowedDomains?: string[]; exceptionEmails?: string[] }

export async function updateOrgSettings(pool: Pool, userId: string, update: OrgSettingsUpdate) {
  const fields: Record<string, unknown> = {};
  if (update.name !== undefined) fields.name = update.name;
  if (update.storageProvider !== undefined) fields.storage_provider = update.storageProvider;
  if (update.allowedDomains !== undefined) fields.allowed_domains = update.allowedDomains;
  if (update.exceptionEmails !== undefined) fields.exception_emails = update.exceptionEmails;
  const keys = Object.keys(fields);
  if (keys.length === 0) throw new AppError("No fields to update.", 400, "VALIDATION");
  const setClause = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  return withUser(pool, userId, async (c) => {
    try {
      const r = await c.query(
        `UPDATE orgs SET ${setClause} WHERE id = (SELECT org_id FROM users WHERE id = $1) RETURNING id, name, storage_provider`,
        [userId, ...keys.map((k) => fields[k])],
      );
      if (r.rowCount === 0) throw new AppError("You don't have access to do that.", 403, "FORBIDDEN");
      const row = r.rows[0];
      await logAudit(c, { orgId: row.id, actorId: userId, action: "org.settings_changed", entity: "org", entityId: row.id, change: fields });
      return row;
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw mapDbError(e);
    }
  });
}

export interface StorageConnectionInput { provider: "google_drive" | "sharepoint"; accountLabel?: string; tokenRef: string; scopes?: string[] }

/** Connects (or reconnects) the org's storage account. Only the token *reference* (a key-vault
 *  pointer) is stored — never a raw token. */
export async function connectStorage(pool: Pool, userId: string, input: StorageConnectionInput) {
  return withUser(pool, userId, async (c) => {
    try {
      const r = await c.query(
        `INSERT INTO storage_connections (org_id, provider, account_label, token_ref, scopes)
         SELECT org_id, $2, $3, $4, $5 FROM users WHERE id = $1
         ON CONFLICT (org_id, provider) DO UPDATE SET account_label = EXCLUDED.account_label, token_ref = EXCLUDED.token_ref, scopes = EXCLUDED.scopes, status = 'active'
         RETURNING id, org_id, provider, account_label, status`,
        [userId, input.provider, input.accountLabel ?? null, input.tokenRef, input.scopes ?? []],
      );
      if (r.rowCount === 0) throw new AppError("Could not resolve your organisation.", 403, "FORBIDDEN");
      const row = r.rows[0];
      // Never log the token reference itself — only that the connection changed.
      await logAudit(c, { orgId: row.org_id, actorId: userId, action: "org.storage_connected", entity: "storage_connection", entityId: row.id, change: { provider: input.provider } });
      return { id: row.id, provider: row.provider, account_label: row.account_label, status: row.status };
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw mapDbError(e);
    }
  });
}

export async function listStorageConnections(pool: Pool, userId: string) {
  return withUser(pool, userId, (c) =>
    c.query("SELECT id, provider, account_label, status FROM storage_connections ORDER BY provider").then((r) => r.rows));
}
