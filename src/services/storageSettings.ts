import path from "node:path";
import type { Pool, PoolClient } from "pg";
import { withUser } from "../db/pool.ts";
import { AppError, mapDbError } from "../errors.ts";
import { logAudit } from "./auditLog.ts";
import type { SecretStore } from "../auth/secretStore.ts";
import { AddressNotAllowedError, checkEndpoint, type AddressPolicy } from "../storage/addressGuard.ts";
import { testLocalDirectory } from "../storage/localDisk.ts";
import { createS3Client, testS3Connection, type S3Config } from "../storage/s3.ts";
import { parseS3Config } from "../storage/s3Config.ts";
import { LOCAL_REF_PREFIX } from "../storage/resolver.ts";
import { safeSegment } from "../storage/safeNames.ts";
import { StorageError } from "../storage/types.ts";
import { ZodError } from "zod";

/**
 * Where an organisation keeps its evidence: which storages it can choose from, connecting each, and choosing one.
 *
 * Only an org admin may do any of this. The choice is locked in the database once the first evidence file is recorded
 * (migration 015), because a recorded file only means something in the storage it was put in.
 */

export type ChoosableProvider = "google_drive" | "local" | "s3";
export const CHOOSABLE: readonly ChoosableProvider[] = ["google_drive", "local", "s3"];

/** What this installation offers, as far as the owner has set it up. */
export interface StorageCapabilities {
  /** Google Drive: the Google app details and the encryption key are in place. */
  drive: { available: boolean; reason?: string };
  /** LOCAL_STORAGE_DIR, when the owner set it. */
  localStorageDir?: string;
  /** Encrypted credentials need SECRET_ENCRYPTION_KEY. */
  secretStore?: SecretStore;
  policy: AddressPolicy;
}

export interface StorageOption {
  provider: ChoosableProvider | "sharepoint";
  /** Can this installation use it at all? */
  available: boolean;
  /** Why not, in words for the administrator. */
  unavailableReason?: string;
  /** Has the organisation connected it? */
  connected: boolean;
  status?: string;
  /** Where the evidence goes or which account it is: the disk folder, the bucket, the Google account. */
  label?: string;
}

export interface StorageOptions { current: string; locked: boolean; options: StorageOption[] }

async function requireAdmin(c: PoolClient, what: string): Promise<{ orgId: string; orgName: string }> {
  const role = (await c.query("SELECT app_role() AS role")).rows[0]?.role as string | null | undefined;
  if (role !== "org_admin") throw new AppError(`Only an org admin can ${what}.`, 403, "FORBIDDEN");
  const org = await c.query("SELECT o.id, o.name FROM orgs o JOIN users u ON u.org_id = o.id WHERE u.id = ctx_user_id()");
  if (org.rowCount === 0) throw new AppError("Could not resolve your organisation.", 403, "FORBIDDEN");
  return { orgId: org.rows[0].id, orgName: org.rows[0].name };
}

const hasEvidence = async (c: PoolClient) => (await c.query("SELECT EXISTS (SELECT 1 FROM evidence_files) AS yes")).rows[0].yes as boolean;

const wrap = <T>(fn: () => Promise<T>): Promise<T> => fn().catch((e) => { throw e instanceof AppError ? e : mapDbError(e); });

export function getStorageOptions(pool: Pool, userId: string, caps: StorageCapabilities): Promise<StorageOptions> {
  return withUser(pool, userId, (c) => wrap(async () => {
    await requireAdmin(c, "see the storage settings");
    const org = (await c.query("SELECT storage_provider FROM orgs WHERE id = (SELECT org_id FROM users WHERE id = ctx_user_id())")).rows[0];
    const conns = (await c.query("SELECT provider, status, account_label FROM storage_connections")).rows as { provider: string; status: string; account_label: string | null }[];
    const by = new Map(conns.map((r) => [r.provider, r]));
    const entry = (provider: StorageOption["provider"], available: boolean, reason?: string): StorageOption => {
      const conn = by.get(provider);
      return { provider, available, ...(available || !reason ? {} : { unavailableReason: reason }), connected: !!conn, ...(conn ? { status: conn.status, ...(conn.account_label ? { label: conn.account_label } : {}) } : {}) };
    };
    const options: StorageOption[] = [
      entry("google_drive", caps.drive.available, caps.drive.reason),
      entry("local", !!caps.localStorageDir, "The owner of this server has not allowed keeping evidence on its disk. They can do that by setting LOCAL_STORAGE_DIR in the server's .env file and restarting."),
      entry("s3", !!caps.secretStore, "The owner of this server has to set SECRET_ENCRYPTION_KEY in the server's .env file (and restart) before S3 access keys can be stored."),
      entry("sharepoint", false, "SharePoint is coming in a later release."),
    ];
    return { current: org.storage_provider as string, locked: await hasEvidence(c), options };
  }));
}

/** Gives the connection and (when free to) the organisation's choice. Called inside the caller's transaction. */
async function saveConnection(c: PoolClient, orgId: string, actorId: string, provider: ChoosableProvider, tokenRef: string, label: string, keepExistingRef: boolean) {
  const r = await c.query(
    `INSERT INTO storage_connections (org_id, provider, account_label, token_ref, scopes, status)
     VALUES ($1, $2, $3, $4, '{}', 'active')
     ON CONFLICT (org_id, provider) DO UPDATE SET account_label = EXCLUDED.account_label, status = 'active',
       token_ref = CASE WHEN $5 THEN storage_connections.token_ref ELSE EXCLUDED.token_ref END
     RETURNING id`,
    [orgId, provider, label, tokenRef, keepExistingRef],
  );
  // The database refuses this (STORAGE_PROVIDER_LOCKED) once evidence exists in a different storage, which also undoes the line above.
  await c.query("UPDATE orgs SET storage_provider = $2 WHERE id = $1 AND storage_provider <> $2", [orgId, provider]);
  await logAudit(c, { orgId, actorId, action: "org.storage_connected", entity: "storage_connection", entityId: r.rows[0].id, change: { provider } });
  return r.rows[0].id as string;
}

// ---- this server's disk -----------------------------------------------------------------------------------------

export function connectLocalStorage(pool: Pool, userId: string, caps: Pick<StorageCapabilities, "localStorageDir">) {
  return withUser(pool, userId, (c) => wrap(async () => {
    const { orgId, orgName } = await requireAdmin(c, "choose where evidence is kept");
    if (!caps.localStorageDir) {
      throw new AppError("Keeping evidence on this server's disk is not switched on. The owner of the server has to set LOCAL_STORAGE_DIR in the server's .env file and restart it.", 409, "LOCAL_STORAGE_NOT_CONFIGURED");
    }
    // The organisation's own folder name is fixed the first time and never changes with a rename, or its files would seem to vanish.
    const existing = (await c.query("SELECT token_ref FROM storage_connections WHERE provider = 'local'")).rows[0]?.token_ref as string | undefined;
    const segment = existing?.startsWith(LOCAL_REF_PREFIX) ? existing.slice(LOCAL_REF_PREFIX.length) : safeSegment(`${orgName} [${orgId.slice(0, 8)}]`);
    const folder = path.join(caps.localStorageDir, segment);
    try { await testLocalDirectory(folder); }
    catch (e) { if (e instanceof StorageError) throw new AppError(e.message, 422, "LOCAL_STORAGE_UNUSABLE"); throw e; }
    const id = await saveConnection(c, orgId, userId, "local", `${LOCAL_REF_PREFIX}${segment}`, "This server's disk", true);
    return { id, provider: "local" as const, folder };
  }));
}

// ---- S3-compatible ----------------------------------------------------------------------------------------------

function readS3Input(input: unknown): S3Config {
  try { return parseS3Config(input); }
  catch (e) {
    if (e instanceof ZodError) throw new AppError(e.issues.map((i) => i.message).join(" "), 400, "VALIDATION");
    throw new AppError((e as Error).message, 400, "VALIDATION");
  }
}

/** Checks the entered details and proves they work against the real service. Returns the config with the address cleaned. */
async function verifyS3(cfg: S3Config, policy: AddressPolicy): Promise<S3Config> {
  const checked = { ...cfg };
  if (cfg.endpoint) {
    try { checked.endpoint = await checkEndpoint(cfg.endpoint, policy); }
    catch (e) { if (e instanceof AddressNotAllowedError) throw new AppError(e.message, 422, "STORAGE_ADDRESS_NOT_ALLOWED"); throw e; }
  }
  let client;
  try {
    client = createS3Client(checked, policy);
    await testS3Connection(client, checked.bucket, checked.prefix);
  } catch (e) {
    if (e instanceof StorageError) throw new AppError(e.message, e.retryable ? 503 : 422, "S3_CONNECTION_FAILED");
    throw e;
  } finally {
    client?.destroy();
  }
  return checked;
}

/** "Test" button: nothing is saved. */
export async function testS3Storage(pool: Pool, userId: string, caps: Pick<StorageCapabilities, "policy">, input: unknown): Promise<{ ok: true }> {
  await withUser(pool, userId, (c) => wrap(() => requireAdmin(c, "test a storage connection")));
  await verifyS3(readS3Input(input), caps.policy);
  return { ok: true };
}

const sameLocation = (a: S3Config, b: S3Config) => a.bucket === b.bucket && a.prefix === b.prefix && (a.endpoint ?? "") === (b.endpoint ?? "") && (a.endpoint ? true : a.region === b.region);

export async function connectS3Storage(pool: Pool, userId: string, caps: Pick<StorageCapabilities, "policy" | "secretStore">, input: unknown) {
  await withUser(pool, userId, (c) => wrap(() => requireAdmin(c, "choose where evidence is kept")));
  if (!caps.secretStore) {
    throw new AppError("S3 access keys are stored encrypted, and this server has no SECRET_ENCRYPTION_KEY. The owner of the server has to set one in the .env file and restart it.", 503, "STORAGE_NOT_CONFIGURED");
  }
  const secretStore = caps.secretStore;
  const verified = await verifyS3(readS3Input(input), caps.policy);

  return withUser(pool, userId, (c) => wrap(async () => {
    const { orgId } = await requireAdmin(c, "choose where evidence is kept");
    if (await hasEvidence(c)) {
      // Keys may be replaced at any time; the place the evidence is in may not.
      const old = (await c.query("SELECT token_ref FROM storage_connections WHERE provider = 's3'")).rows[0]?.token_ref as string | undefined;
      let previous: S3Config | undefined;
      try { previous = old ? parseS3Config(JSON.parse(secretStore.decrypt(old))) : undefined; } catch { previous = undefined; }
      if (previous && !sameLocation(previous, verified)) {
        throw new AppError("Evidence is already stored in the current bucket, so only the access keys can be changed here, not the bucket, folder or address.", 409, "STORAGE_LOCATION_LOCKED");
      }
    }
    const label = verified.endpoint ? `${verified.bucket} @ ${new URL(verified.endpoint).host}` : `${verified.bucket} (Amazon S3, ${verified.region})`;
    const id = await saveConnection(c, orgId, userId, "s3", secretStore.encrypt(JSON.stringify(verified)), label, false);
    return { id, provider: "s3" as const, label };
  }));
}

// ---- choosing among connected storages ----------------------------------------------------------------------------

export function chooseStorageProvider(pool: Pool, userId: string, provider: ChoosableProvider) {
  return withUser(pool, userId, (c) => wrap(async () => {
    const { orgId } = await requireAdmin(c, "choose where evidence is kept");
    const conn = (await c.query("SELECT status FROM storage_connections WHERE provider = $1", [provider])).rows[0];
    if (!conn || conn.status !== "active") {
      throw new AppError("Connect that storage first, then choose it.", 409, "STORAGE_NOT_CONNECTED");
    }
    await c.query("UPDATE orgs SET storage_provider = $2 WHERE id = $1 AND storage_provider <> $2", [orgId, provider]);
    return { provider };
  }));
}
