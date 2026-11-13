import type { Readable } from "node:stream";
import { StorageError, type FileMeta, type FolderRef, type OpenedFile, type StorageProvider, type UploadSession, type UploadTarget } from "./types.ts";

/**
 * A StorageProvider that only works out WHICH real provider to use (and fetches that org's credentials)
 * the first time a method is actually called, then reuses it.
 *
 * Why this exists: the services check who the caller is and whether the request is even valid (right
 * role, control exists, control applicable...) BEFORE they touch storage. Resolving credentials up
 * front, in the route, would run first and change what an unauthorised caller sees — a dashboard-only
 * user would get "storage not connected" instead of "not allowed". Resolving lazily keeps every
 * existing check, and its error, exactly where it was.
 */
export class LazyStorageProvider implements StorageProvider {
  private resolved: Promise<StorageProvider> | undefined;

  constructor(private readonly resolve: () => Promise<StorageProvider>) {}

  private provider(): Promise<StorageProvider> {
    // Memoise the promise itself so concurrent first calls share one resolution. A failed resolution is
    // dropped so the next call can try again (e.g. after an admin reconnects).
    if (!this.resolved) {
      this.resolved = this.resolve().catch((e) => { this.resolved = undefined; throw e; });
    }
    return this.resolved;
  }

  async createRootFolder(name: string): Promise<FolderRef> { return (await this.provider()).createRootFolder(name); }
  async findOrCreateFolder(rootFolderId: string, subfolderName: string): Promise<FolderRef> { return (await this.provider()).findOrCreateFolder(rootFolderId, subfolderName); }
  async createUploadSession(folderId: string, fileName: string, mimeType: string, sizeBytes: number, browserOrigin?: string): Promise<UploadSession> { return (await this.provider()).createUploadSession(folderId, fileName, mimeType, sizeBytes, browserOrigin); }
  async getFileMetadata(providerFileId: string): Promise<FileMeta> { return (await this.provider()).getFileMetadata(providerFileId); }
  async listFiles(folderId: string): Promise<FileMeta[]> { return (await this.provider()).listFiles(folderId); }
  async downloadFile(providerFileId: string): Promise<{ bytes: Uint8Array; mimeType: string }> { return (await this.provider()).downloadFile(providerFileId); }
  async quarantineFile(providerFileId: string): Promise<void> { return (await this.provider()).quarantineFile(providerFileId); }

  // These two exist on only some providers. Which one this is isn't known until it is resolved, so they are always here
  // and say so plainly if the provider turns out not to offer them.
  async receiveUpload(target: UploadTarget, body: Readable): Promise<void> {
    const p = await this.provider();
    if (!p.receiveUpload) throw new StorageError("This storage takes uploads directly from the browser, not through the portal.", "INVALID_REQUEST", false);
    return p.receiveUpload(target, body);
  }
  async openFile(providerFileId: string): Promise<OpenedFile> {
    const p = await this.provider();
    if (!p.openFile) throw new StorageError("This storage doesn't offer downloads through the portal.", "INVALID_REQUEST", false);
    return p.openFile(providerFileId);
  }
}
