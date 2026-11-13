import path from "node:path";
import type { Pool } from "pg";
import type { S3Client } from "@aws-sdk/client-s3";
import { withUser } from "../db/pool.ts";
import { AppError } from "../errors.ts";
import type { SecretStore } from "../auth/secretStore.ts";
import type { GoogleOAuth } from "./googleOAuth.ts";
import { GoogleDriveProvider, type Fetcher } from "./googleDrive.ts";
import { AccessTokenCache } from "./accessTokenCache.ts";
import { LazyStorageProvider } from "./lazyProvider.ts";
import { LocalDiskProvider } from "./localDisk.ts";
import { S3Provider, createS3Client, type S3Config } from "./s3.ts";
import { parseS3Config } from "./s3Config.ts";
import { isSafeSegment } from "./safeNames.ts";
import { signUploadToken } from "./uploadTokens.ts";
import { StorageAuthRevokedError, type StorageProvider, type UploadTarget } from "./types.ts";

/** Given an authenticated user, returns the storage provider for THAT USER'S organisation. */
export type StorageResolver = (userId: string) => StorageProvider;

export interface StorageResolverDeps {
  pool: Pool;
  /** Absent: Google Drive answers "not configured". */
  oauth?: GoogleOAuth;
  /** Absent: Google Drive and S3 (whose credentials are kept encrypted) answer "not configured". */
  secretStore?: SecretStore;
  /** Signs the upload links of the storages the portal writes to itself (disk, S3). */
  jwtSecret: string;
  /** The folder on this server's disk that the disk option keeps its files in. Absent: the disk option is not offered. */
  localStorageDir?: string;
  /** Whether an S3 service on a private network (an organisation's own MinIO) may be used. */
  allowPrivateAddresses?: boolean;
  /** Defaults to global fetch; tests inject a fake Drive. */
  driveFetcher?: Fetcher;
  tokenCache?: AccessTokenCache;
  driveRetry?: ConstructorParameters<typeof GoogleDriveProvider>[2];
  /** The clock the disk and S3 providers use for upload windows (tests only). */
  now?: () => number;
}

/** What is stored for the "this server's disk" connection: the organisation's own folder name below LOCAL_STORAGE_DIR. */
export const LOCAL_REF_PREFIX = "local:v1:";

const notConfigured = (what: string, how: string) => new AppError(`${what} isn't set up on this server. ${how}`, 503, "STORAGE_NOT_CONFIGURED");

/** The connection's own folder on disk, from its stored reference; null if the reference is not one this server can trust. */
export function localFolderFromRef(ref: string, baseDir: string): string | null {
  if (!ref.startsWith(LOCAL_REF_PREFIX)) return null;
  const segment = ref.slice(LOCAL_REF_PREFIX.length);
  return isSafeSegment(segment) ? path.join(baseDir, segment) : null;
}

/** Keeps the S3 clients of recent connections, so their network connections are reused instead of being opened for every request. */
class S3ClientCache {
  private readonly entries = new Map<string, S3Client>();
  constructor(private readonly max = 32) {}
  get(key: string, make: () => S3Client): S3Client {
    const hit = this.entries.get(key);
    if (hit) { this.entries.delete(key); this.entries.set(key, hit); return hit; }
    const client = make();
    this.entries.set(key, client);
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.get(oldest)?.destroy();
      this.entries.delete(oldest);
    }
    return client;
  }
}

/**
 * The real, per-organisation storage wiring. For each request it:
 *  1. asks the database (storage_credentials_for_caller) for the caller's own org's active connection to the storage the
 *     organisation has chosen — the org is derived inside the database from the authenticated user, never passed in;
 *  2. builds the provider for that kind of storage:
 *       Google Drive — decrypts the org's refresh token; access tokens are minted from it on demand and cached;
 *       this server's disk — the org's own folder below LOCAL_STORAGE_DIR;
 *       S3-compatible — decrypts the org's access key and opens (or reuses) a client for it.
 *
 * Nothing here ever reads, logs or stores evidence content or a plaintext secret beyond the lifetime of the call.
 */
export function createStorageResolver(deps: StorageResolverDeps): StorageResolver {
  const cache = deps.tokenCache ?? new AccessTokenCache();
  const s3Clients = new S3ClientCache();
  // Names promised to announced uploads, kept across requests (each request builds its own provider).
  const reservations = new Map<string, number>();

  return (userId: string) => new LazyStorageProvider(async () => {
    const cred = await withUser(deps.pool, userId, (c) =>
      c.query("SELECT out_connection_id, out_provider, out_token_ref FROM storage_credentials_for_caller()").then((r) => r.rows[0] ?? null));

    if (!cred) {
      throw new AppError(
        "Your organisation hasn't connected its storage yet (or this account can't use it). An org admin can choose where evidence is kept under Settings → Integrations.",
        409, "STORAGE_NOT_CONNECTED");
    }

    // The link the browser sends a file to, for storages that take uploads through the portal: made for this person, this file.
    const makeUploadUrl = (target: UploadTarget, expiresAt: Date) =>
      `/uploads/${signUploadToken(deps.jwtSecret, { userId, target, expiresAt: expiresAt.getTime() })}`;

    switch (cred.out_provider) {
      case "local": {
        if (!deps.localStorageDir) {
          throw notConfigured("Keeping evidence on this server's disk", "The server owner has to set LOCAL_STORAGE_DIR in the server's .env file and restart it.");
        }
        const dir = localFolderFromRef(cred.out_token_ref as string, deps.localStorageDir);
        if (!dir) throw new AppError("The stored location of this organisation's evidence folder isn't valid. An org admin needs to choose the disk option again under Settings → Integrations.", 409, "STORAGE_RECONNECT_REQUIRED");
        return new LocalDiskProvider({ baseDir: dir, makeUploadUrl, now: deps.now, reservations });
      }

      case "s3": {
        if (!deps.secretStore) throw notConfigured("Connecting S3 storage", "The server owner has to set SECRET_ENCRYPTION_KEY in the server's .env file and restart it.");
        let cfg: S3Config;
        try {
          cfg = parseS3Config(JSON.parse(deps.secretStore.decrypt(cred.out_token_ref as string)));
        } catch {
          throw new AppError(
            "The stored S3 connection details can't be read (the server's SECRET_ENCRYPTION_KEY may have changed). An org admin needs to enter them again under Settings → Integrations.",
            409, "STORAGE_RECONNECT_REQUIRED");
        }
        const client = s3Clients.get(cred.out_token_ref as string, () => createS3Client(cfg, { allowPrivate: deps.allowPrivateAddresses === true }));
        return new S3Provider({ client, bucket: cfg.bucket, prefix: cfg.prefix, makeUploadUrl, now: deps.now, reservations });
      }

      case "google_drive": {
        if (!deps.secretStore || !deps.oauth) {
          throw new AppError(
            "Google Drive isn't configured on this server. Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI and SECRET_ENCRYPTION_KEY.",
            503, "OAUTH_NOT_CONFIGURED");
        }
        return driveProvider(deps, deps.secretStore, deps.oauth, cache, userId, cred.out_connection_id, cred.out_token_ref as string);
      }

      default:
        throw new AppError(`Storage provider "${cred.out_provider}" isn't supported by this server yet.`, 501, "STORAGE_PROVIDER_UNSUPPORTED");
    }
  });
}

function driveProvider(
  deps: StorageResolverDeps, secretStore: SecretStore, oauth: GoogleOAuth, cache: AccessTokenCache,
  userId: string, connectionId: string, tokenRef: string,
): StorageProvider {
  let refreshToken: string;
  try {
    refreshToken = secretStore.decrypt(tokenRef);
  } catch {
    // Wrong/rotated SECRET_ENCRYPTION_KEY, or a corrupted row. Either way only a fresh connection fixes it.
    throw new AppError(
      "The stored storage credentials can't be read (the server's SECRET_ENCRYPTION_KEY may have changed). An org admin needs to reconnect Google Drive.",
      409, "STORAGE_RECONNECT_REQUIRED");
  }

  const getAccessToken = async (): Promise<string> => {
    try {
      return await cache.get(tokenRef, () => oauth.refreshAccessToken(refreshToken));
    } catch (e) {
      if (e instanceof StorageAuthRevokedError) {
        cache.invalidate(tokenRef);
        // Best effort and deliberately on its own connection: the surrounding request is about to fail
        // and roll back, but the "needs reconnecting" fact must survive that rollback.
        await flagRevoked(deps.pool, userId, connectionId).catch(() => undefined);
        throw new AppError(
          "Google Drive access was revoked or has expired. An org admin needs to reconnect it under Settings → Integrations.",
          409, "STORAGE_RECONNECT_REQUIRED");
      }
      throw e;
    }
  };

  return new GoogleDriveProvider(getAccessToken, deps.driveFetcher, deps.driveRetry);
}

async function flagRevoked(pool: Pool, userId: string, connectionId: string): Promise<boolean> {
  return withUser(pool, userId, (c) =>
    c.query("SELECT storage_connection_flag_revoked($1) AS flagged", [connectionId]).then((r) => r.rows[0].flagged as boolean));
}

/** A resolver for when storage can't work at all (e.g. Google Drive isn't configured on this server):
 *  every storage action fails with the given, actionable error instead of a crash or a confusing failure
 *  from deep inside a provider. Failing lazily means requests that never touch storage are unaffected. */
export function unavailableStorageResolver(error: AppError): StorageResolver {
  return () => new LazyStorageProvider(async () => { throw error; });
}
