import { createHash } from "node:crypto";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { Readable } from "node:stream";
import {
  CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command,
  PutObjectCommand, S3Client, type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { mimeTypeForFileName } from "../services/fileSpec.ts";
import { AddressNotAllowedError, assertLiteralAllowed, guardedLookup, type AddressPolicy } from "./addressGuard.ts";
import { isSafeSegment, safeFileName, safeSegment, splitStoredPath } from "./safeNames.ts";
import {
  StorageError, type FileMeta, type FolderRef, type OpenedFile, type StorageProvider, type UploadSession, type UploadTarget,
} from "./types.ts";

/** What an organisation's administrator enters to connect an S3-compatible service. Stored encrypted. */
export interface S3Config {
  /** The service's address (https://s3.example.com). Left out for Amazon S3 itself. */
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Address buckets as host/bucket instead of bucket.host — what MinIO and most self-run services need. */
  forcePathStyle: boolean;
  /** A folder inside the bucket to keep everything under ("evidence/"), or "" for the top. */
  prefix: string;
}

const UPLOAD_WINDOW_MS = 60 * 60 * 1000;
const QUARANTINE = "_quarantine";
const SHA256_KEY = "sha256";

/** "Evidence/2026" → "Evidence/2026/"; "" → ""; refuses anything that isn't a plain path of safe names. */
export function normalisePrefix(raw: string): string | null {
  const trimmed = raw.trim().replace(/^\/+|\/+$/g, "");
  if (trimmed === "") return "";
  const parts = trimmed.split("/");
  return parts.every((p) => isSafeSegment(p)) ? `${parts.join("/")}/` : null;
}

export interface S3Options {
  client: S3Client;
  bucket: string;
  prefix: string;
  makeUploadUrl: (target: UploadTarget, expiresAt: Date) => string;
  now?: () => number;
  /** Names promised to announced uploads; share one map between the providers made for successive requests. */
  reservations?: Map<string, number>;
}

/** A client for one organisation's connection. The address check also runs on every connection it opens. */
export function createS3Client(cfg: S3Config, policy: AddressPolicy): S3Client {
  if (cfg.endpoint) {
    try { assertLiteralAllowed(cfg.endpoint, policy); }
    catch (e) { if (e instanceof AddressNotAllowedError) throw new StorageError(e.message, "INVALID_REQUEST", false, { cause: e }); throw e; }
  }
  const lookup = guardedLookup(policy);
  const settings: S3ClientConfig = {
    region: cfg.region,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    forcePathStyle: cfg.forcePathStyle,
    // Many S3-compatible services don't understand the extra checksum headers newer SDKs add by default.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    maxAttempts: 3,
    requestHandler: {
      connectionTimeout: 10_000,
      requestTimeout: 60_000,
      httpAgent: new HttpAgent({ lookup, keepAlive: true, maxSockets: 20 }),
      httpsAgent: new HttpsAgent({ lookup, keepAlive: true, maxSockets: 20 }),
    },
  };
  if (cfg.endpoint) settings.endpoint = cfg.endpoint;
  return new S3Client(settings);
}

/**
 * Keeps evidence in an S3-compatible bucket (Amazon S3, MinIO, Wasabi, Backblaze B2, Cloudflare R2, Ceph…):
 *
 *   <prefix>Evidence Portal – <client> / <audit cycle> [code] / <control> / <file>
 *
 * S3 has no real folders, so "creating a folder" is choosing a name and "the folder's files" are the keys that start
 * with it. A file's id is its key without the prefix, checked with the same rules as on a disk. Uploads come through
 * the portal (so the bucket needs no CORS setup and the browser needs no S3 keys) and are held in memory briefly —
 * evidence files are limited to 25 MB. The integrity check compares the SHA-256 the portal recorded as object metadata
 * and the object's ETag/version: replacing the file, even with identical metadata, changes the ETag.
 */
export class S3Provider implements StorageProvider {
  readonly name = "s3" as const;
  private readonly reserved: Map<string, number>;
  private readonly now: () => number;

  constructor(private readonly o: S3Options) {
    this.now = o.now ?? Date.now;
    this.reserved = o.reservations ?? new Map();
  }

  /** The reservation key: unique per bucket and folder, since one map may serve several organisations. */
  private reservationKey(providerFileId: string): string {
    return `${this.o.bucket}/${this.o.prefix}${providerFileId}`;
  }

  private key(id: string): { key: string; parts: string[] } {
    const parts = splitStoredPath(id);
    if (!parts) throw new StorageError("That is not a valid location in this storage.", "INVALID_REQUEST", false);
    return { key: this.o.prefix + parts.join("/"), parts };
  }

  private async send<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (e) { throw mapS3Error(e); }
  }

  // ---- folders (names only: S3 has none) -----------------------------------------------------------------------

  async createRootFolder(name: string): Promise<FolderRef> {
    const stem = safeSegment(name);
    for (let n = 1; n < 1000; n++) {
      const candidate = n === 1 ? stem : `${stem} (${n})`;
      const found = await this.send(() => this.o.client.send(new ListObjectsV2Command({ Bucket: this.o.bucket, Prefix: `${this.o.prefix}${candidate}/`, MaxKeys: 1 })));
      if ((found.KeyCount ?? 0) === 0) return { id: candidate };
    }
    throw new StorageError("Could not find a free folder name.", "INVALID_REQUEST", false);
  }

  async findOrCreateFolder(rootFolderId: string, subfolderName: string): Promise<FolderRef> {
    this.key(rootFolderId);
    const id = `${rootFolderId}/${safeSegment(subfolderName)}`;
    this.key(id);
    return { id };
  }

  // ---- uploads --------------------------------------------------------------------------------------------------

  async createUploadSession(folderId: string, fileName: string, mimeType: string, sizeBytes: number): Promise<UploadSession> {
    this.key(folderId);
    const wanted = safeFileName(fileName);
    const dot = wanted.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [wanted.slice(0, dot), wanted.slice(dot)] : [wanted, ""];
    const t = this.now();
    for (const [k, until] of this.reserved) if (until < t) this.reserved.delete(k);
    let chosen = wanted;
    for (let n = 2; n < 1000; n++) {
      const id = `${folderId}/${chosen}`;
      if (!this.reserved.has(this.reservationKey(id)) && !(await this.objectExists(this.key(id).key))) break;
      chosen = `${stem} (${n})${ext}`;
    }
    const providerFileId = `${folderId}/${chosen}`;
    this.reserved.set(this.reservationKey(providerFileId), t + UPLOAD_WINDOW_MS);
    const expiresAt = new Date(t + 15 * 60 * 1000);
    const target: UploadTarget = { providerFileId, folderId, fileName: chosen, mimeType, sizeBytes };
    return { uploadUrl: this.o.makeUploadUrl(target, expiresAt), method: "PUT", headers: {}, providerFileId, expiresAt };
  }

  private async objectExists(key: string): Promise<boolean> {
    try {
      await this.o.client.send(new HeadObjectCommand({ Bucket: this.o.bucket, Key: key }));
      return true;
    } catch (e) {
      if (mapS3Error(e).code === "NOT_FOUND") return false;
      throw mapS3Error(e);
    }
  }

  async receiveUpload(target: UploadTarget, body: Readable): Promise<void> {
    const parts = splitStoredPath(target.providerFileId);
    if (!parts || parts.slice(0, -1).join("/") !== target.folderId) {
      throw new StorageError("That is not a valid location in this storage.", "INVALID_REQUEST", false);
    }
    // Collected whole (at most the announced size + 1 byte) rather than streamed: the length is checked before anything is
    // stored, a failed attempt can simply be repeated, and the fingerprint can be recorded together with the object.
    const chunks: Buffer[] = []; let received = 0;
    for await (const chunk of body) {
      received += (chunk as Buffer).length;
      if (received > target.sizeBytes) { body.destroy(); throw new StorageError("The file is larger than it was announced to be.", "INVALID_REQUEST", false); }
      chunks.push(chunk as Buffer);
    }
    if (received !== target.sizeBytes) throw new StorageError("The file is smaller than it was announced to be.", "INVALID_REQUEST", false);
    const data = Buffer.concat(chunks);
    const sha256 = createHash("sha256").update(data).digest("hex");
    const key = this.o.prefix + parts.join("/");
    const taken = () => new StorageError("A file with that name is already stored, so this upload was not accepted. Choose the file again.", "ALREADY_EXISTS", false);
    try {
      // A recorded file must never be replaced through a link. Checked first (works on every service), and again by the
      // service itself in the same step as the write ("only if nothing is there"), which closes the gap between the two
      // wherever the service supports it.
      if (await this.objectExists(key)) throw taken();
      const put = (conditional: boolean) => this.o.client.send(new PutObjectCommand({
        Bucket: this.o.bucket, Key: key, Body: data, ContentLength: data.length,
        ContentType: mimeTypeForFileName(target.fileName), Metadata: { [SHA256_KEY]: sha256 },
        ...(conditional ? { IfNoneMatch: "*" } : {}),
      }));
      try {
        await put(true);
      } catch (e) {
        const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status === 412 || status === 409) throw taken();
        if (status === 501 || status === 400 && /IfNoneMatch|If-None-Match|NotImplemented|not supported/i.test(String((e as Error).message) + String((e as Error).name))) {
          await this.send(() => put(false));   // a service that doesn't know the condition: the check above is the protection
        } else {
          throw mapS3Error(e);
        }
      }
    } finally {
      this.reserved.delete(this.reservationKey(target.providerFileId));
    }
  }

  // ---- reading --------------------------------------------------------------------------------------------------

  async getFileMetadata(providerFileId: string): Promise<FileMeta> {
    const { key, parts } = this.key(providerFileId);
    const head = await this.send(() => this.o.client.send(new HeadObjectCommand({ Bucket: this.o.bucket, Key: key })));
    return metaFrom(providerFileId, parts, { size: head.ContentLength ?? 0, etag: head.ETag, versionId: head.VersionId, modified: head.LastModified, sha256: head.Metadata?.[SHA256_KEY] });
  }

  async listFiles(folderId: string): Promise<FileMeta[]> {
    this.key(folderId);
    const out: FileMeta[] = [];
    let token: string | undefined;
    do {
      const page = await this.send(() => this.o.client.send(new ListObjectsV2Command({
        Bucket: this.o.bucket, Prefix: `${this.o.prefix}${folderId}/`, Delimiter: "/", ContinuationToken: token })));
      for (const c of page.Contents ?? []) {
        const name = (c.Key ?? "").slice(this.o.prefix.length + folderId.length + 1);
        if (!isSafeSegment(name)) continue;
        const id = `${folderId}/${name}`;
        out.push(metaFrom(id, id.split("/"), { size: c.Size ?? 0, etag: c.ETag, modified: c.LastModified }));
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async downloadFile(providerFileId: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const { key, parts } = this.key(providerFileId);
    const got = await this.send(() => this.o.client.send(new GetObjectCommand({ Bucket: this.o.bucket, Key: key })));
    const bytes = await this.send(() => got.Body!.transformToByteArray());
    return { bytes, mimeType: mimeTypeForFileName(parts[parts.length - 1]) };
  }

  async openFile(providerFileId: string): Promise<OpenedFile> {
    const { key, parts } = this.key(providerFileId);
    const got = await this.send(() => this.o.client.send(new GetObjectCommand({ Bucket: this.o.bucket, Key: key })));
    const fileName = parts[parts.length - 1];
    return { stream: got.Body as Readable, sizeBytes: got.ContentLength ?? 0, mimeType: mimeTypeForFileName(fileName), fileName };
  }

  /** Moves a flagged object to a quarantine folder in the same bucket (copy, then delete the original). */
  async quarantineFile(providerFileId: string): Promise<void> {
    const { key, parts } = this.key(providerFileId);
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, "-");
    const target = `${this.o.prefix}${QUARANTINE}/${stamp}-${parts[parts.length - 1]}`;
    const source = `${this.o.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
    await this.send(() => this.o.client.send(new CopyObjectCommand({ Bucket: this.o.bucket, Key: target, CopySource: source })));
    await this.send(() => this.o.client.send(new DeleteObjectCommand({ Bucket: this.o.bucket, Key: key })));
  }
}

function metaFrom(id: string, parts: string[], o: { size: number; etag?: string; versionId?: string; modified?: Date; sha256?: string }): FileMeta {
  const etag = (o.etag ?? "").replace(/"/g, "");
  const name = parts[parts.length - 1];
  return {
    providerFileId: id, name, sizeBytes: o.size, mimeType: mimeTypeForFileName(name),
    // The fingerprint the portal recorded when the file arrived; an object put there by anyone else has none, so it reads as changed.
    hashAlgo: o.sha256 ? "sha256" : "s3-etag", hash: o.sha256 ?? `etag:${etag}`,
    version: o.versionId ?? etag, webUrl: "", modifiedAt: o.modified ?? new Date(0), folderId: parts.slice(0, -1).join("/"),
  };
}

/** An S3 failure → a StorageError that says what is wrong in the words an administrator can act on. */
export function mapS3Error(e: unknown): StorageError {
  if (e instanceof StorageError) return e;
  const err = e as { name?: string; Code?: string; code?: string; message?: string; $metadata?: { httpStatusCode?: number }; $response?: { headers?: Record<string, string> }; cause?: unknown };
  const status = err.$metadata?.httpStatusCode;
  const name = err.name ?? err.Code ?? "";
  const cause = (err.cause ?? err) as { name?: string; code?: string; message?: string };
  if (cause.name === "AddressNotAllowedError") return new StorageError(cause.message ?? "That address is not allowed.", "INVALID_REQUEST", false, { cause: e });
  if (status === 404 || ["NoSuchKey", "NotFound"].includes(name)) {
    if (name === "NoSuchBucket") return new StorageError("The bucket doesn't exist (check the bucket name and region).", "INVALID_REQUEST", false, { cause: e });
    return new StorageError("Not found in storage.", "NOT_FOUND", false, { cause: e });
  }
  if (name === "InvalidAccessKeyId") return new StorageError("The storage service doesn't recognise the access key ID.", "PERMISSION_DENIED", false, { cause: e });
  if (name === "SignatureDoesNotMatch") return new StorageError("The storage service rejected the secret access key (it doesn't match the access key ID).", "PERMISSION_DENIED", false, { cause: e });
  if (name === "AccessDenied" || status === 403) return new StorageError("The storage service refused the request: the access key isn't allowed to do this in the bucket. It needs permission to list, read, write and delete objects.", "PERMISSION_DENIED", false, { cause: e });
  if (name === "PermanentRedirect" || name === "AuthorizationHeaderMalformed" || status === 301 || status === 307) {
    const region = err.$response?.headers?.["x-amz-bucket-region"];
    return new StorageError(`The bucket is in a different region${region ? ` (${region})` : ""}. Change the region setting.`, "INVALID_REQUEST", false, { cause: e });
  }
  if (name === "SlowDown" || status === 503 || status === 429) return new StorageError("The storage service asked for fewer requests. Please try again.", "RATE_LIMITED", true, { cause: e });
  if (status && status >= 500) return new StorageError(`The storage service had an error (${status}). Please try again.`, "PROVIDER_UNAVAILABLE", true, { cause: e });
  if (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ECONNRESET", "EHOSTUNREACH"].includes(cause.code ?? "") || name === "TimeoutError" || name === "NetworkingError") {
    return new StorageError(`Can't reach the storage service (${cause.code ?? name}). Check the address and that this server can connect to it.`, "PROVIDER_UNAVAILABLE", true, { cause: e });
  }
  return new StorageError(`The storage service returned an error (${name || status || "unknown"}).`, "PROVIDER_UNAVAILABLE", false, { cause: e });
}

/**
 * Proves a connection works before it is saved: the bucket is reachable and the key may write, read and delete.
 * Leaves nothing behind. Throws a StorageError whose message tells the administrator what to fix.
 */
export async function testS3Connection(client: S3Client, bucket: string, prefix: string): Promise<void> {
  const send = async <T>(fn: () => Promise<T>): Promise<T> => { try { return await fn(); } catch (e) { throw mapS3Error(e); } };
  try {
    await send(() => client.send(new HeadBucketCommand({ Bucket: bucket })));
  } catch (e) {
    // A HEAD answer has no body, so "no such bucket" arrives as a plain "not found".
    if (e instanceof StorageError && e.code === "NOT_FOUND") throw new StorageError("The bucket doesn't exist (check the bucket name, and the region).", "INVALID_REQUEST", false, { cause: e });
    throw e;
  }
  const key = `${prefix}.evidence-portal-connection-test-${Date.now()}`;
  await send(() => client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: Buffer.from("ok"), ContentLength: 2 })));
  try {
    const got = await send(() => client.send(new GetObjectCommand({ Bucket: bucket, Key: key })));
    await send(() => got.Body!.transformToByteArray());
  } finally {
    await send(() => client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })));
  }
}
