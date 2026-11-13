import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { mimeTypeForFileName } from "../services/fileSpec.ts";
import { isSafeSegment, safeFileName, safeSegment, splitStoredPath } from "./safeNames.ts";
import {
  StorageError, type FileMeta, type FolderRef, type OpenedFile, type StorageProvider, type UploadSession, type UploadTarget,
} from "./types.ts";

/** How long an announced upload may take before its file name can be handed out again. */
const UPLOAD_WINDOW_MS = 60 * 60 * 1000;
const QUARANTINE_DIR = "_quarantine";

export interface LocalDiskOptions {
  /** This organisation's own folder on the server's disk (it is created if it doesn't exist). Everything below stays inside it. */
  baseDir: string;
  /** Builds the address the browser sends the file to (a link into the portal itself, valid for a short while). */
  makeUploadUrl: (target: UploadTarget, expiresAt: Date) => string;
  now?: () => number;
  /** Names promised to announced uploads. Share one map between the providers made for successive requests, so a name
   *  promised in one request is still taken in the next. */
  reservations?: Map<string, number>;
}

/**
 * Keeps evidence as ordinary folders and files on the disk of the machine the portal runs on:
 *
 *   <base folder> / Evidence Portal – <client> / <audit cycle> [code] / <control> / <file>
 *
 * which is the whole point — an organisation that runs the portal on its own server can keep the evidence in its own
 * place, back it up with its own tools, and open it without the portal.
 *
 * A file's id is its location inside the base folder ("Client/Audit [1a2b3c4d]/A.8.5/report.pdf"). Ids come back from the
 * database and from links, so every one is re-checked before it is used: each name in it must be acceptable (no "..", no
 * Windows device names, nothing hidden), and the real location on disk — after following any links — must still be inside
 * the base folder. A file that someone has placed a link to elsewhere is not followed out.
 *
 * The integrity check compares a SHA-256 of the content, so a file edited, replaced or restored with different content
 * is noticed; touching it or copying it back unchanged is not a change.
 */
export class LocalDiskProvider implements StorageProvider {
  readonly name = "local" as const;
  private realBase: Promise<string> | undefined;
  /** Names already promised to an announced upload that hasn't arrived yet, so two announcements never get the same name. */
  private readonly reserved: Map<string, number>;
  private readonly now: () => number;

  constructor(private readonly opts: LocalDiskOptions) {
    this.now = opts.now ?? Date.now;
    this.reserved = opts.reservations ?? new Map();
  }

  // ---- places on disk -------------------------------------------------------------------------------------------

  /** The base folder, created on first use, as its real location (links followed) — what every other path is checked against. */
  private base(): Promise<string> {
    if (!this.realBase) {
      this.realBase = fsp.mkdir(this.opts.baseDir, { recursive: true })
        .then(() => fsp.realpath(this.opts.baseDir))
        .catch((e) => { this.realBase = undefined; throw mapFsError(e); });
    }
    return this.realBase;
  }

  /**
   * A stored id → the real path on disk, or an error. With `mustExist`, the whole path is looked at after following links
   * and must lie inside the base folder; without it (for something about to be created) its deepest existing parent must.
   */
  private async locate(id: string, mustExist = true): Promise<{ abs: string; parts: string[] }> {
    const parts = splitStoredPath(id);
    if (!parts) throw new StorageError("That is not a valid location in this storage.", "INVALID_REQUEST", false);
    const base = await this.base();
    const abs = path.join(base, ...parts);
    await this.assertInside(base, abs, mustExist);
    return { abs, parts };
  }

  /** Follows links from the deepest part of `abs` that exists and refuses anything that ends up outside the base folder. */
  private async assertInside(base: string, abs: string, mustExist: boolean): Promise<void> {
    let probe = abs;
    for (;;) {
      try {
        const real = await fsp.realpath(probe);
        if (real !== base && !real.startsWith(base + path.sep)) throw new StorageError("That location is outside this storage.", "PERMISSION_DENIED", false);
        return;
      } catch (e) {
        if (e instanceof StorageError) throw e;
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw mapFsError(e);
        if (mustExist) throw new StorageError("Not found in storage.", "NOT_FOUND", false);
        const parent = path.dirname(probe);
        if (parent === probe) throw new StorageError("Not found in storage.", "NOT_FOUND", false);
        probe = parent;                                     // not there yet (about to be created): judge its nearest parent
      }
    }
  }

  // ---- folders --------------------------------------------------------------------------------------------------

  async createRootFolder(name: string): Promise<FolderRef> {
    const base = await this.base();
    const stem = safeSegment(name);
    for (let n = 1; n < 1000; n++) {
      const candidate = n === 1 ? stem : `${stem} (${n})`;
      try {
        await fsp.mkdir(path.join(base, candidate));
        return { id: candidate };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw mapFsError(e);
      }
    }
    throw new StorageError("Could not find a free folder name.", "INVALID_REQUEST", false);
  }

  async findOrCreateFolder(rootFolderId: string, subfolderName: string): Promise<FolderRef> {
    const root = await this.locate(rootFolderId);
    if (!(await fsp.stat(root.abs).catch((e) => { throw mapFsError(e); })).isDirectory()) throw new StorageError("Not found in storage.", "NOT_FOUND", false);
    const id = `${rootFolderId}/${safeSegment(subfolderName)}`;
    const { abs } = await this.locate(id, false);
    try {
      await fsp.mkdir(abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw mapFsError(e);
    }
    if (!(await fsp.stat(abs)).isDirectory()) throw new StorageError("A file is in the way of this folder.", "INVALID_REQUEST", false);
    return { id };
  }

  // ---- uploads --------------------------------------------------------------------------------------------------

  async createUploadSession(folderId: string, fileName: string, mimeType: string, sizeBytes: number): Promise<UploadSession> {
    const { abs: folderAbs } = await this.locate(folderId);
    if (!(await fsp.stat(folderAbs)).isDirectory()) throw new StorageError("Not found in storage.", "NOT_FOUND", false);

    const wanted = safeFileName(fileName);
    const dot = wanted.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [wanted.slice(0, dot), wanted.slice(dot)] : [wanted, ""];
    this.forgetOldReservations();
    let chosen = wanted;
    for (let n = 2; n < 1000 && (this.reserved.has(path.join(folderAbs, chosen).toLowerCase()) || await exists(path.join(folderAbs, chosen))); n++) {
      chosen = `${stem} (${n})${ext}`;
    }
    this.reserved.set(path.join(folderAbs, chosen).toLowerCase(), this.now() + UPLOAD_WINDOW_MS);

    const providerFileId = `${folderId}/${chosen}`;
    const expiresAt = new Date(this.now() + 15 * 60 * 1000);
    const target: UploadTarget = { providerFileId, folderId, fileName: chosen, mimeType, sizeBytes };
    return { uploadUrl: this.opts.makeUploadUrl(target, expiresAt), method: "PUT", headers: {}, providerFileId, expiresAt };
  }

  private forgetOldReservations(): void {
    const t = this.now();
    for (const [k, until] of this.reserved) if (until < t) this.reserved.delete(k);
  }

  async receiveUpload(target: UploadTarget, body: Readable): Promise<void> {
    const parts = splitStoredPath(target.providerFileId);
    if (!parts || parts.slice(0, -1).join("/") !== target.folderId) {
      throw new StorageError("That is not a valid location in this storage.", "INVALID_REQUEST", false);
    }
    const { abs } = await this.locate(target.providerFileId, false);
    const folder = await this.locate(target.folderId);
    if (!(await fsp.stat(folder.abs)).isDirectory()) throw new StorageError("Not found in storage.", "NOT_FOUND", false);

    let received = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        if (received > target.sizeBytes) cb(new StorageError("The file is larger than it was announced to be.", "INVALID_REQUEST", false));
        else cb(null, chunk);
      },
    });
    // "wx": never overwrite a file that is already there. "flush": the bytes are on the disk, not just in the system's cache.
    const out = fs.createWriteStream(abs, { flags: "wx", mode: 0o640, flush: true });
    try {
      await pipeline(body, counter, out);
      if (received !== target.sizeBytes) throw new StorageError("The file is smaller than it was announced to be.", "INVALID_REQUEST", false);
    } catch (e) {
      const clash = (e as NodeJS.ErrnoException).code === "EEXIST";
      if (!clash) await fsp.unlink(abs).catch(() => undefined);   // never leave half a file behind (but never touch one that was already there)
      if (e instanceof StorageError) throw e;
      if (clash) throw new StorageError("A file with that name is already there, so this upload was not accepted. Choose the file again.", "ALREADY_EXISTS", false);
      throw mapFsError(e);
    } finally {
      this.reserved.delete(abs.toLowerCase());
    }
  }

  // ---- reading --------------------------------------------------------------------------------------------------

  async getFileMetadata(providerFileId: string): Promise<FileMeta> {
    const { abs, parts } = await this.locate(providerFileId);
    const st = await statFile(abs);
    const hash = await sha256Of(abs);
    const name = parts[parts.length - 1];
    return {
      providerFileId, name, sizeBytes: st.size, mimeType: mimeTypeForFileName(name), hashAlgo: "sha256", hash,
      // The content's fingerprint is also the revision marker: only a change in the content counts as a change.
      version: hash, webUrl: "", modifiedAt: st.mtime, folderId: parts.slice(0, -1).join("/"),
    };
  }

  async listFiles(folderId: string): Promise<FileMeta[]> {
    const { abs } = await this.locate(folderId);
    const entries = await fsp.readdir(abs, { withFileTypes: true }).catch((e) => { throw mapFsError(e); });
    const out: FileMeta[] = [];
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isFile() || !isSafeSegment(e.name)) continue;
      out.push(await this.getFileMetadata(`${folderId}/${e.name}`));
    }
    return out;
  }

  async downloadFile(providerFileId: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const { abs, parts } = await this.locate(providerFileId);
    await statFile(abs);
    const bytes = await fsp.readFile(abs).catch((e) => { throw mapFsError(e); });
    return { bytes: new Uint8Array(bytes), mimeType: mimeTypeForFileName(parts[parts.length - 1]) };
  }

  async openFile(providerFileId: string): Promise<OpenedFile> {
    const { abs, parts } = await this.locate(providerFileId);
    const st = await statFile(abs);
    const fileName = parts[parts.length - 1];
    return { stream: fs.createReadStream(abs), sizeBytes: st.size, mimeType: mimeTypeForFileName(fileName), fileName };
  }

  /**
   * Moves a flagged file out of the evidence folders into a quarantine folder next to them (still on this disk, so an
   * administrator can inspect or restore it, but no longer among the evidence an auditor browses).
   */
  async quarantineFile(providerFileId: string): Promise<void> {
    const { abs, parts } = await this.locate(providerFileId);
    await statFile(abs);
    const base = await this.base();
    const dir = path.join(base, QUARANTINE_DIR);
    try {
      await fsp.mkdir(dir, { recursive: true });
      const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, "-");
      await fsp.rename(abs, path.join(dir, `${stamp}-${parts[parts.length - 1]}`));
    } catch (e) {
      throw mapFsError(e);
    }
  }
}

async function exists(p: string): Promise<boolean> {
  try { await fsp.lstat(p); return true; } catch { return false; }
}

async function statFile(abs: string): Promise<fs.Stats> {
  let st: fs.Stats;
  try { st = await fsp.stat(abs); } catch (e) { throw mapFsError(e); }
  if (!st.isFile()) throw new StorageError("Not found in storage.", "NOT_FOUND", false);
  return st;
}

function sha256Of(abs: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    fs.createReadStream(abs).on("error", (e) => reject(mapFsError(e))).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex")));
  });
}

/** A file-system failure → a StorageError that says, in plain words, what is wrong with the folder or disk. */
export function mapFsError(e: unknown): StorageError {
  if (e instanceof StorageError) return e;
  const code = (e as NodeJS.ErrnoException)?.code;
  switch (code) {
    case "ENOENT": case "ENOTDIR": return new StorageError("Not found in storage.", "NOT_FOUND", false, { cause: e });
    case "EACCES": case "EPERM": case "EROFS":
      return new StorageError("The portal is not allowed to write to its evidence folder on this server. Check the permissions of LOCAL_STORAGE_DIR.", "PERMISSION_DENIED", false, { cause: e });
    case "ENOSPC": return new StorageError("The disk that holds the evidence folder is full.", "PROVIDER_UNAVAILABLE", false, { cause: e });
    case "ENAMETOOLONG": return new StorageError("The folder path is too long for this system. Use a shorter LOCAL_STORAGE_DIR.", "INVALID_REQUEST", false, { cause: e });
    default: return new StorageError(`The evidence folder could not be used (${code ?? "unknown error"}).`, "PROVIDER_UNAVAILABLE", true, { cause: e });
  }
}

/**
 * Proves a folder on this server's disk can be used before an organisation starts relying on it: it can be created, and a
 * file can be written, read back and removed in it. Leaves nothing behind. Throws a StorageError that says what to fix.
 */
export async function testLocalDirectory(dir: string): Promise<void> {
  const probe = path.join(dir, `.evidence-portal-write-test-${process.pid}-${Date.now()}`);
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(probe, "ok", { flag: "wx" });
    const back = await fsp.readFile(probe, "utf8");
    if (back !== "ok") throw new StorageError("The evidence folder returned different content than was written to it.", "PROVIDER_UNAVAILABLE", false);
  } catch (e) {
    throw mapFsError(e);
  } finally {
    await fsp.rm(probe, { force: true }).catch(() => undefined);
  }
}
