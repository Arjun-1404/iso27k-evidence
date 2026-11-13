import { Readable } from "node:stream";
import type { FileMeta, FolderRef, OpenedFile, StorageProvider, UploadSession } from "./types.ts";
import { StorageError } from "./types.ts";

interface Rec { folderId: string; name: string; sizeBytes: number; mimeType: string; hash: string; version: string }

/**
 * A minimal in-memory StorageProvider, for testing service-layer logic (evidence upload, review,
 * integrity checks) without depending on any one provider's REST shape. Contrast with FakeDriveApi,
 * which tests the Drive adapter itself against realistic request/response shapes.
 */
export class InMemoryStorageProvider implements StorageProvider {
  readonly name = "google_drive" as const;
  private folders = new Map<string, { root: string; name: string }>();
  private files = new Map<string, Rec>();
  private nextId = 1;
  uploadedBytes = new Map<string, Buffer>();
  private trashed = new Set<string>();
  /** Test-only: makes quarantineFile() fail, as if the storage service were down. */
  failQuarantine = false;

  async createRootFolder(name: string): Promise<FolderRef> {
    const id = `root-${this.nextId++}`;
    this.folders.set(id, { root: "", name });
    return { id };
  }

  async findOrCreateFolder(rootFolderId: string, subfolderName: string): Promise<FolderRef> {
    for (const [id, f] of this.folders) if (f.root === rootFolderId && f.name === subfolderName) return { id };
    const id = `folder-${this.nextId++}`;
    this.folders.set(id, { root: rootFolderId, name: subfolderName });
    return { id };
  }

  async createUploadSession(folderId: string, fileName: string, mimeType: string, sizeBytes: number): Promise<UploadSession> {
    const id = `file-${this.nextId++}`;
    this.files.set(id, { folderId, name: fileName, sizeBytes, mimeType, hash: `hash-${id}`, version: "1" });
    return { uploadUrl: `memory://${id}`, method: "PUT", headers: {}, providerFileId: id, expiresAt: new Date(Date.now() + 3_600_000) };
  }

  async getFileMetadata(providerFileId: string): Promise<FileMeta> {
    const f = this.files.get(providerFileId);
    if (!f) throw new StorageError("not found", "NOT_FOUND", false);
    return { providerFileId, name: f.name, sizeBytes: f.sizeBytes, mimeType: f.mimeType, hashAlgo: "sha256", hash: f.hash, version: f.version, webUrl: `memory://${providerFileId}`, modifiedAt: new Date(), folderId: f.folderId };
  }

  async listFiles(folderId: string): Promise<FileMeta[]> {
    const out: FileMeta[] = [];
    for (const [id, f] of this.files) if (f.folderId === folderId && !this.trashed.has(id)) out.push(await this.getFileMetadata(id));
    return out;
  }

  async downloadFile(providerFileId: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const f = this.files.get(providerFileId);
    if (!f) throw new StorageError("not found", "NOT_FOUND", false);
    const bytes = this.uploadedBytes.get(providerFileId) ?? Buffer.from(`fake content for ${f.name}`);
    return { bytes: new Uint8Array(bytes), mimeType: f.mimeType };
  }

  async openFile(providerFileId: string): Promise<OpenedFile> {
    const { bytes, mimeType } = await this.downloadFile(providerFileId);
    const f = this.files.get(providerFileId)!;
    return { stream: Readable.from([Buffer.from(bytes)]), sizeBytes: bytes.length, mimeType, fileName: f.name };
  }

  async quarantineFile(providerFileId: string): Promise<void> {
    if (this.failQuarantine) throw new StorageError("storage unavailable", "PROVIDER_UNAVAILABLE", true);
    if (!this.files.has(providerFileId)) throw new StorageError("not found", "NOT_FOUND", false);
    this.trashed.add(providerFileId);
  }

  /** Test-only: whether a file has been moved to the bin. */
  isQuarantined(providerFileId: string): boolean {
    return this.trashed.has(providerFileId);
  }

  /** Test-only: sets what downloadFile() returns, so a scan-detection test can control the "content". */
  setBytes(providerFileId: string, bytes: Buffer): void {
    this.uploadedBytes.set(providerFileId, bytes);
  }

  /** Test-only: simulates the file changing in storage after acceptance (integrity-check scenario). */
  mutate(providerFileId: string, patch: Partial<Pick<Rec, "hash" | "version">>): void {
    const f = this.files.get(providerFileId);
    if (f) Object.assign(f, patch);
  }
}
