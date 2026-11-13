import type { Pool } from "pg";
import { withUser } from "../db/pool.ts";
import { AppError, mapDbError } from "../errors.ts";
import { logAudit } from "./auditLog.ts";
import type { StorageProvider } from "../storage/types.ts";
import { withStorageErrors } from "./storageErrors.ts";

/**
 * Creates the top-level evidence folder for a tenant in the org's connected storage, and records it as
 * the tenant's storage root. This replaces "paste a folder id": with the narrow `drive.file` scope the
 * app can only see folders IT created, so a folder an admin made by hand would simply be invisible.
 *
 * Org admins only, and checked BEFORE anything is created in the provider — a refused request must not
 * leave a stray folder behind. A per-tenant advisory lock makes two simultaneous clicks create one
 * folder, not two.
 */
export async function createTenantStorageRoot(pool: Pool, userId: string, storage: StorageProvider, tenantId: string) {
  return withUser(pool, userId, async (c) => {
    try {
      const role = (await c.query("SELECT app_role() AS role")).rows[0]?.role as string | null | undefined;
      if (role !== "org_admin") throw new AppError("Only an org admin can set up a tenant's storage folder.", 403, "FORBIDDEN");

      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 4))", [tenantId]);
      const t = await c.query("SELECT id, org_id, name, storage_root_id FROM tenants WHERE id = $1", [tenantId]);
      if (t.rowCount === 0) throw new AppError("Tenant not found or not visible to you.", 404, "NOT_FOUND");
      const tenant = t.rows[0];
      if (tenant.storage_root_id) throw new AppError("This tenant already has a storage folder.", 409, "STORAGE_ROOT_EXISTS");

      const folder = await withStorageErrors(() => storage.createRootFolder(`Evidence Portal – ${tenant.name}`));

      await c.query("UPDATE tenants SET storage_root_id = $2 WHERE id = $1", [tenantId, folder.id]);
      await logAudit(c, { orgId: tenant.org_id, tenantId, actorId: userId, action: "tenant.storage_root_created", entity: "tenant", entityId: tenantId });
      return { id: tenantId, storageRootId: folder.id as string };
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw mapDbError(e);
    }
  });
}
