import type { Readable } from "node:stream";

/**
 * The contract every evidence storage backend implements (Google Drive, this server's own disk and S3-compatible
 * storage today; SharePoint later).
 * Nothing above this layer — the evidence service, the HTTP routes — knows which provider is in use.
 * That is what lets a new provider be added, or swapped in per-org, without touching business logic.
 */

export interface FolderRef {
  /** The provider's own id for the folder (e.g. a Google Drive folder id). Opaque to callers. */
  id: string;
}

export interface UploadSession {
  /** Where the browser should PUT/POST the file bytes directly. The app server never sees them. */
  uploadUrl: string;
  method: "PUT" | "POST";
  headers: Record<string, string>;
  /** The id the file will have once the upload completes, if the provider can allocate it up front. */
  providerFileId: string;
  expiresAt: Date;
}

export interface FileMeta {
  providerFileId: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  hashAlgo: string;
  hash: string;
  /** A provider-specific revision marker (Drive's `version`/`headRevisionId`, SharePoint's `eTag`). */
  version: string;
  webUrl: string;
  modifiedAt: Date;
  /** The folder the file sits in, when the provider can say. Used to check that a file really belongs where it is claimed to. */
  folderId?: string;
}

/** What an upload that goes through the portal's own server (see StorageProvider.receiveUpload) is about. */
export interface UploadTarget {
  providerFileId: string;
  folderId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

/** A recorded file opened for download. */
export interface OpenedFile {
  stream: Readable;
  sizeBytes: number;
  mimeType: string;
  fileName: string;
}

export class StorageError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_FOUND" | "PERMISSION_DENIED" | "RATE_LIMITED" | "PROVIDER_UNAVAILABLE" | "INVALID_REQUEST" | "ALREADY_EXISTS",
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StorageError";
  }
}

/** The provider rejected the stored credential itself (e.g. the admin revoked this app's access in
 *  their Google account). Distinct from an ordinary permission error because retrying can never help:
 *  an org admin has to reconnect. */
export class StorageAuthRevokedError extends StorageError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "PERMISSION_DENIED", false, options);
    this.name = "StorageAuthRevokedError";
  }
}

export interface StorageProvider {
  /** Informational only. Optional because a provider that is resolved lazily per request (see
   *  LazyStorageProvider) can't know which backend it will turn out to be until it is first used. */
  readonly name?: "google_drive" | "sharepoint" | "local" | "s3";

  /**
   * Creates a brand-new top-level folder that the app itself owns, for use as a tenant's evidence root.
   * Needed because the narrow `drive.file` scope only lets the app see files and folders it created
   * (or that the user explicitly opened with it): a folder an admin made by hand in Google Drive is
   * invisible to the app. Not idempotent — calling twice creates two folders; callers must guard.
   */
  createRootFolder(name: string): Promise<FolderRef>;

  /**
   * Returns the subfolder for one control under the tenant's root folder, creating it if it doesn't
   * exist yet. Must be idempotent: calling it twice with the same arguments returns the same folder.
   */
  findOrCreateFolder(rootFolderId: string, subfolderName: string): Promise<FolderRef>;

  /**
   * Creates a short-lived session the browser uploads directly to. `browserOrigin` is the address of the web page the
   * person is using, for storages that must be told it so their answer to the browser's upload is allowed through
   * (Google Drive); the others ignore it.
   */
  createUploadSession(folderId: string, fileName: string, mimeType: string, sizeBytes: number, browserOrigin?: string): Promise<UploadSession>;

  /** Reads back metadata (including hash) for a file that has finished uploading. */
  getFileMetadata(providerFileId: string): Promise<FileMeta>;

  /** Lists the files currently in a folder, for the "files in the storage folder" view. */
  listFiles(folderId: string): Promise<FileMeta[]>;

  /**
   * Downloads a file's bytes. Used only by the malware-scanning step right after upload — nothing else
   * in the system pulls evidence content back out of storage; this is the one deliberate exception,
   * and the bytes are never persisted, only streamed through memory into the scanner.
   */
  downloadFile(providerFileId: string): Promise<{ bytes: Uint8Array; mimeType: string }>;

  /**
   * Moves a file out of the evidence folders into the provider's recycle bin (Google Drive: the trash). It is NOT
   * deleted for good: an administrator can still restore it from the bin if the scanner was wrong. Used for files
   * that malware scanning flagged, so a dangerous file doesn't sit among the evidence an auditor browses.
   */
  quarantineFile(providerFileId: string): Promise<void>;

  /**
   * Only for storages the portal's server writes to itself (this server's disk, S3): there is no address the browser can
   * send the file to directly, so createUploadSession points the browser at the portal, and the portal hands the bytes
   * to this method. `body` must deliver exactly `target.sizeBytes` bytes; anything else is refused and nothing is kept.
   * Providers that take uploads straight from the browser (Google Drive) leave this out.
   */
  receiveUpload?(target: UploadTarget, body: Readable): Promise<void>;

  /** Opens a recorded file so the portal can hand it to an authorised person. Not every provider offers it. */
  openFile?(providerFileId: string): Promise<OpenedFile>;
}
