import { Readable } from "node:stream";
import { StorageError, type FileMeta, type FolderRef, type OpenedFile, type StorageProvider, type UploadSession } from "./types.ts";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FIELDS = "id,name,size,mimeType,md5Checksum,headRevisionId,webViewLink,modifiedTime,parents";

export type Fetcher = typeof fetch;

/** Escapes a value for use inside a Drive `q=` query string (single quotes and backslashes). */
function qEscape(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** Reasons Google gives (in its 403 answers) for "too many requests right now": these pass by themselves, so they are retried. */
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "sharingRateLimitExceeded"]);

export interface DriveRefusal {
  /** Google's own short reasons (for example "accessNotConfigured"), as found in its answer. */
  reasons: string[];
  /** True for "slow down" answers that Google sends as 403 — worth trying again. */
  retryable: boolean;
  /** The text for the person: what Google refused, and what to do about it. */
  message: string;
}

/**
 * Turns Google's 401/403 answer into something a person can act on. A bare "permission denied (403)" hides the
 * cause, and the causes need very different fixes: the Drive API switched off in the Google Cloud project, the Drive
 * permission left unticked on Google's consent screen, a full Drive, or a connection Google has withdrawn.
 * The answer's body is parsed defensively: anything unexpected falls back to Google's own message, shortened.
 */
export function explainDriveRefusal(status: number, bodyText: string): DriveRefusal {
  let error: { message?: unknown; errors?: unknown; details?: unknown } = {};
  try {
    const parsed = JSON.parse(bodyText) as { error?: unknown };
    if (parsed && typeof parsed.error === "object" && parsed.error !== null) error = parsed.error as typeof error;
  } catch { /* not JSON: nothing to read */ }

  const reasons: string[] = [];
  for (const list of [error.errors, error.details]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const reason = (item as { reason?: unknown } | null)?.reason;
      if (typeof reason === "string" && !reasons.includes(reason)) reasons.push(reason);
    }
  }
  const googleMessage = typeof error.message === "string" ? error.message.replace(/\s+/g, " ").trim() : "";
  const has = (...names: string[]) => names.some((n) => reasons.includes(n));
  const prefix = `Drive permission denied (${status})`;
  const tag = reasons.length > 0 ? ` [Google: ${reasons.join(", ")}]` : "";

  if (reasons.some((r) => RATE_LIMIT_REASONS.has(r))) return { reasons, retryable: true, message: `${prefix}: Google asked for fewer requests.${tag}` };

  if (has("accessNotConfigured", "SERVICE_DISABLED")) {
    const link = googleMessage.match(/https:\/\/console\.(?:developers|cloud)\.google\.com\/[^\s]*[^\s.,;)]/)?.[0];
    return { reasons, retryable: false, message: `${prefix}: the Google Drive API is switched off in your Google Cloud project. In Google Cloud Console open APIs & Services → Library, search for "Google Drive API", click Enable, wait a minute and try again.${link ? ` Direct link: ${link}` : ""}${tag}` };
  }
  if (has("insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "insufficientScopes")) {
    return { reasons, retryable: false, message: `${prefix}: Google did not give the portal the Drive permission. Under Integrations disconnect Google Drive, connect it again, and leave the Drive permission ticked on Google's screen.${tag}` };
  }
  if (has("storageQuotaExceeded")) {
    return { reasons, retryable: false, message: `${prefix}: the connected Google account has no Drive storage left. Free some space in that Drive or connect a different account.${tag}` };
  }
  if (status === 401 || has("authError", "invalid_grant")) {
    return { reasons, retryable: false, message: `${prefix}: Google no longer accepts the saved connection (it expired or was withdrawn). Under Integrations disconnect Google Drive and connect it again.${tag}` };
  }
  return { reasons, retryable: false, message: googleMessage ? `${prefix}: Google said "${googleMessage.slice(0, 240)}"${tag}` : `${prefix}.${tag}` };
}

interface RetryOptions { retries: number; baseDelayMs: number; sleep: (ms: number) => Promise<void> }
const DEFAULT_RETRY: RetryOptions = { retries: 3, baseDelayMs: 200, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/**
 * Talks to the Google Drive v3 API. Every network call goes through the injected `fetcher`, so
 * production wires in the real `fetch` and tests wire in an in-memory fake that speaks the same
 * REST shapes — the logic here (folder caching, retries, pagination, error mapping) gets exercised
 * for real, without needing live Google credentials or network access.
 */
export class GoogleDriveProvider implements StorageProvider {
  readonly name = "google_drive" as const;

  constructor(
    private readonly getAccessToken: () => Promise<string>,
    private readonly fetcher: Fetcher = fetch,
    private readonly retry: RetryOptions = DEFAULT_RETRY,
  ) {}

  private async call(path: string, init: RequestInit = {}, absoluteUrl = false): Promise<Response> {
    const token = await this.getAccessToken();
    const url = absoluteUrl ? path : `${API}${path}`;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retry.retries; attempt++) {
      let res: Response;
      try {
        res = await this.fetcher(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
      } catch (e) {
        lastErr = e;
        if (attempt === this.retry.retries) throw new StorageError(`Drive request failed: ${(e as Error).message}`, "PROVIDER_UNAVAILABLE", true, { cause: e });
        await this.retry.sleep(this.retry.baseDelayMs * 2 ** attempt);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = res;
        if (attempt === this.retry.retries) break;
        const retryAfter = Number(res.headers.get("retry-after"));
        await this.retry.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.retry.baseDelayMs * 2 ** attempt);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        const refusal = explainDriveRefusal(res.status, await res.text().catch(() => ""));
        if (refusal.retryable) {
          lastErr = res;
          if (attempt === this.retry.retries) break;
          await this.retry.sleep(this.retry.baseDelayMs * 2 ** attempt);
          continue;
        }
        throw new StorageError(refusal.message, "PERMISSION_DENIED", false);
      }
      if (res.status === 404) throw new StorageError("Drive resource not found", "NOT_FOUND", false);
      if (res.status >= 400) {
        const body = await res.text().catch(() => "");
        throw new StorageError(`Drive request failed (${res.status}): ${body.slice(0, 300)}`, "INVALID_REQUEST", false);
      }
      return res;
    }
    const status = lastErr instanceof Response ? lastErr.status : "network error";
    throw new StorageError(`Drive request failed after ${this.retry.retries + 1} attempts (${status})`, "PROVIDER_UNAVAILABLE", true);
  }

  async createRootFolder(name: string): Promise<FolderRef> {
    // No `parents` => the folder is created at the top level of the connected account's My Drive.
    const created = await this.call("/files?fields=id", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder" }),
    });
    const folder = (await created.json()) as { id: string };
    return { id: folder.id };
  }

  async findOrCreateFolder(rootFolderId: string, subfolderName: string): Promise<FolderRef> {
    const q = `'${qEscape(rootFolderId)}' in parents and name = '${qEscape(subfolderName)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const found = await this.call(`/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=10&spaces=drive`);
    const data = (await found.json()) as { files: { id: string; name: string }[] };
    if (data.files.length > 0) return { id: data.files[0].id };

    const created = await this.call("/files?fields=id", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: subfolderName, mimeType: "application/vnd.google-apps.folder", parents: [rootFolderId] }),
    });
    const folder = (await created.json()) as { id: string };
    return { id: folder.id };
  }

  async createUploadSession(folderId: string, fileName: string, mimeType: string, sizeBytes: number, browserOrigin?: string): Promise<UploadSession> {
    const idsRes = await this.call("/files/generateIds?count=1&space=drive");
    const ids = (await idsRes.json()) as { ids: string[] };
    const providerFileId = ids.ids[0];

    const init = await this.call(
      `${UPLOAD_API}/files?uploadType=resumable&supportsAllDrives=true`,
      {
        method: "POST",
        // Google answers the browser's upload with the permission to read the answer only to the page named here (CORS).
        headers: { "Content-Type": "application/json", "X-Upload-Content-Type": mimeType, "X-Upload-Content-Length": String(sizeBytes), ...(browserOrigin ? { Origin: browserOrigin } : {}) },
        body: JSON.stringify({ id: providerFileId, name: fileName, parents: [folderId] }),
      },
      true,
    );
    const location = init.headers.get("location");
    if (!location) throw new StorageError("Drive did not return a resumable upload location", "PROVIDER_UNAVAILABLE", true);
    return { uploadUrl: location, method: "PUT", headers: { "Content-Type": mimeType, "Content-Length": String(sizeBytes) }, providerFileId, expiresAt: new Date(Date.now() + 60 * 60 * 1000) };
  }

  async getFileMetadata(providerFileId: string): Promise<FileMeta> {
    const res = await this.call(`/files/${encodeURIComponent(providerFileId)}?fields=${FIELDS}&supportsAllDrives=true`);
    return toFileMeta(await res.json());
  }

  async downloadFile(providerFileId: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const meta = await this.getFileMetadata(providerFileId);
    const res = await this.call(`/files/${encodeURIComponent(providerFileId)}?alt=media&supportsAllDrives=true`);
    const buf = await res.arrayBuffer();
    return { bytes: new Uint8Array(buf), mimeType: meta.mimeType };
  }

  /** Streams a recorded file to the caller (for the download button). The bytes pass through the portal and are not kept. */
  async openFile(providerFileId: string): Promise<OpenedFile> {
    const meta = await this.getFileMetadata(providerFileId);
    const res = await this.call(`/files/${encodeURIComponent(providerFileId)}?alt=media&supportsAllDrives=true`);
    if (!res.body) throw new StorageError("Drive returned no content for this file.", "PROVIDER_UNAVAILABLE", true);
    return { stream: Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>), sizeBytes: meta.sizeBytes, mimeType: meta.mimeType, fileName: meta.name };
  }

  async quarantineFile(providerFileId: string): Promise<void> {
    // Trashing is reversible (the owner can restore it), and repeating it changes nothing, so it is safe to retry.
    await this.call(`/files/${encodeURIComponent(providerFileId)}?supportsAllDrives=true&fields=id`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true }),
    });
  }

  async listFiles(folderId: string): Promise<FileMeta[]> {
    const files: FileMeta[] = [];
    let pageToken: string | undefined;
    do {
      const q = `'${qEscape(folderId)}' in parents and trashed = false`;
      const params = new URLSearchParams({ q, fields: `nextPageToken,files(${FIELDS})`, pageSize: "100", spaces: "drive" });
      if (pageToken) params.set("pageToken", pageToken);
      const res = await this.call(`/files?${params.toString()}`);
      const data = (await res.json()) as { files: unknown[]; nextPageToken?: string };
      files.push(...data.files.map(toFileMeta));
      pageToken = data.nextPageToken;
    } while (pageToken);
    return files;
  }
}

function toFileMeta(raw: unknown): FileMeta {
  const f = raw as { id: string; name: string; size?: string; mimeType: string; md5Checksum?: string; headRevisionId?: string; webViewLink?: string; modifiedTime: string; parents?: string[] };
  return {
    providerFileId: f.id,
    name: f.name,
    sizeBytes: f.size ? Number(f.size) : 0,
    mimeType: f.mimeType,
    hashAlgo: "md5",
    hash: f.md5Checksum ?? "",
    version: f.headRevisionId ?? "",
    webUrl: f.webViewLink ?? "",
    modifiedAt: new Date(f.modifiedTime),
    folderId: f.parents?.[0],
  };
}
