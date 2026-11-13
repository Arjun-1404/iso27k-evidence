import type { Pool } from "pg";
import { withUser } from "../db/pool.ts";
import { AppError, mapDbError } from "../errors.ts";
import { logAudit } from "./auditLog.ts";
import type { StorageProvider } from "../storage/types.ts";
import { StorageError } from "../storage/types.ts";
import { auditFolderName } from "./folderNames.ts";
import { withStorageErrors } from "./storageErrors.ts";
import { ScannerUnavailableError, type Scanner, type ScanResult } from "../scan/types.ts";
import { validateFile, type FileSpec } from "./fileSpec.ts";
import type { Readable } from "node:stream";

interface ControlContext {
  id: string; orgId: string; tenantId: string; controlRef: string; applicable: boolean;
  effectiveEvidence: string; effectiveFileSpec: FileSpec; folderId: string | null; storageRootId: string | null;
  auditId: string; auditName: string; auditClosed: boolean;
}

const closedForEvidence = (extra = "") => new AppError(
  `This audit cycle is closed, so no more evidence can be added to it.${extra} A lead auditor or an organisation admin can reopen it.`, 409, "AUDIT_CLOSED");

async function loadContext(pool: Pool, userId: string, controlId: string): Promise<ControlContext> {
  return withUser(pool, userId, async (c) => {
    const r = await c.query(
      `SELECT ac.id, ac.org_id, ac.tenant_id, ac.control_ref, ac.applicable, ac.folder_id, ac.audit_id,
              COALESCE(ac.evidence_override, ac.base_evidence) AS effective_evidence,
              COALESCE(ac.file_spec_override, ac.base_file_spec) AS effective_file_spec,
              t.storage_root_id, a.name AS audit_name, (a.status = 'closed') AS audit_closed
       FROM audit_controls ac JOIN tenants t ON t.id = ac.tenant_id JOIN audits a ON a.id = ac.audit_id
       WHERE ac.id = $1`,
      [controlId],
    );
    if (r.rowCount === 0) throw new AppError("Control not found.", 404, "NOT_FOUND");
    const row = r.rows[0];
    return {
      id: row.id, orgId: row.org_id, tenantId: row.tenant_id, controlRef: row.control_ref, applicable: row.applicable,
      effectiveEvidence: row.effective_evidence, effectiveFileSpec: row.effective_file_spec ?? {},
      folderId: row.folder_id, storageRootId: row.storage_root_id, auditId: row.audit_id, auditName: row.audit_name, auditClosed: row.audit_closed,
    };
  });
}

export interface UploadRequest { fileName: string; mimeType: string; sizeBytes: number }

export interface UploadSessionResult {
  uploadUrl: string; method: "PUT" | "POST"; headers: Record<string, string>; providerFileId: string; expiresAt: Date;
}

/** Step 1 of an upload: validates the file against the control's requirement, ensures the control's
 *  storage folder exists (creating it on first use), and returns a session the browser uploads to directly. */
export async function requestUploadSession(pool: Pool, userId: string, storage: StorageProvider, controlId: string, file: UploadRequest, browserOrigin?: string): Promise<UploadSessionResult> {
  const ctx = await loadContext(pool, userId, controlId);
  if (ctx.auditClosed) throw closedForEvidence(); // before any folder is created or upload session opened in the storage
  if (!ctx.applicable) throw new AppError("This control is not applicable.", 409, "NOT_APPLICABLE");
  if (!ctx.storageRootId) throw new AppError("Storage is not connected for this tenant yet.", 409, "STORAGE_NOT_CONNECTED");

  const existingCount = await withUser(pool, userId, (c) =>
    c.query("SELECT count(*)::int AS n FROM evidence_files WHERE audit_control_id = $1", [controlId]).then((r) => r.rows[0].n as number));
  const check = validateFile(file, ctx.effectiveFileSpec, existingCount);
  if (!check.ok) throw new AppError(check.reason, 422, "INVALID_FILE");

  let folderId = ctx.folderId;
  if (!folderId) {
    folderId = await withUser(pool, userId, async (c) => {
      // Serialise per control so two near-simultaneous first uploads can't create two provider folders.
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 3))", [controlId]);
      const again = await c.query("SELECT folder_id FROM audit_controls WHERE id = $1", [controlId]);
      if (again.rows[0].folder_id) return again.rows[0].folder_id as string;
      // <client folder> / <this audit cycle> / <control>: a later cycle's evidence never lands among an earlier one's.
      const folder = await withStorageErrors(async () => {
        const cycle = await storage.findOrCreateFolder(ctx.storageRootId!, auditFolderName(ctx.auditName, ctx.auditId));
        return storage.findOrCreateFolder(cycle.id, ctx.controlRef);
      });
      await c.query("UPDATE audit_controls SET folder_id = $1 WHERE id = $2", [folder.id, controlId]);
      return folder.id;
    });
  }

  const session = await withStorageErrors(() => storage.createUploadSession(folderId!, file.fileName, file.mimeType, file.sizeBytes, browserOrigin));
  return session;
}

/**
 * Runs the malware scan. If the scanner cannot give an answer, the upload is NOT recorded: "couldn't check"
 * must never be treated as "clean". The file is already in the organisation's own storage, so once the
 * scanner is back the user simply confirms again. Only the scanner's own summary is logged (by contract it
 * holds no file names or contents).
 */
async function runScan(scanner: Scanner, fileName: string, bytes: ArrayLike<number>): Promise<ScanResult> {
  try {
    return await scanner.scan(fileName, bytes);
  } catch (e) {
    console.error(e instanceof ScannerUnavailableError ? `[scan] ${e.message}` : "[scan] scanning failed unexpectedly");
    throw new AppError("Malware scanning is unavailable right now, so this file was not recorded. Please try again in a few minutes.", 503, "SCANNER_UNAVAILABLE");
  }
}

/**
 * Takes a flagged file out of the evidence folders (into the storage service's trash, from where it can be restored).
 * Best effort: if the storage service can't be reached the upload is refused all the same, and the caller is told the
 * file is still there. Only generic text is logged — never the file's name.
 */
async function quarantine(storage: StorageProvider, providerFileId: string): Promise<boolean> {
  try {
    await storage.quarantineFile(providerFileId);
    return true;
  } catch (e) {
    console.error(e instanceof StorageError ? `[quarantine] could not move a flagged file to the trash (${e.code})` : "[quarantine] could not move a flagged file to the trash");
    return false;
  }
}

/** The audit log is where an auditor looks for "was anything malicious uploaded, and what happened to it". */
async function recordInfected(pool: Pool, userId: string, controlId: string, fileName: string, quarantined: boolean) {
  await withUser(pool, userId, async (c) => {
    const r = await c.query("SELECT org_id, tenant_id FROM audit_controls WHERE id = $1", [controlId]);
    const row = r.rows[0];
    await logAudit(c, { orgId: row.org_id, tenantId: row.tenant_id, actorId: userId, action: "evidence.infected", entity: "audit_control", entityId: controlId, change: { fileName, quarantined } });
  });
}

/** Step 2: called once the browser's direct upload has finished. Downloads the file just long enough
 *  to scan it (nothing is persisted beyond that), then records its metadata. Infected files are refused
 *  outright and never recorded as evidence. */
export async function confirmUpload(pool: Pool, userId: string, storage: StorageProvider, scanner: Scanner, controlId: string, providerFileId: string) {
  const ctx = await loadContext(pool, userId, controlId); // re-checks access and that the control still exists
  // The cycle may have been closed while the file was being sent. Nothing is scanned, moved or recorded then.
  if (ctx.auditClosed) throw closedForEvidence(" The file you sent has not been recorded; it is still in your storage folder.");
  if (!ctx.folderId) throw new AppError("No upload has been started for this control yet. Choose the file again.", 409, "UPLOAD_NOT_STARTED");
  const meta = await withStorageErrors(() => storage.getFileMetadata(providerFileId));
  // The file id comes from the browser, so it is only believed if the storage says the file sits in THIS control's own
  // folder. Otherwise a person could name a file that belongs to another control, client or organisation and have it
  // recorded (and later offered for download) as their own evidence.
  if (meta.folderId !== ctx.folderId) {
    throw new AppError("That file isn't in this control's evidence folder, so it was not recorded.", 422, "FILE_NOT_IN_FOLDER");
  }
  const { bytes } = await withStorageErrors(() => storage.downloadFile(providerFileId));
  const scanStatus = await runScan(scanner, meta.name, bytes);
  if (scanStatus === "infected") {
    const quarantined = await quarantine(storage, providerFileId);
    await recordInfected(pool, userId, controlId, meta.name, quarantined);
    throw new AppError(
      quarantined
        ? "This file was flagged by malware scanning. It has not been recorded, and it has been moved to the trash of your storage so it can't be opened by mistake. Please check the file and try again."
        : "This file was flagged by malware scanning and has not been recorded. It could NOT be moved out of your storage folder automatically, so please delete it there. Then check the file and try again.",
      422, "INFECTED_FILE");
  }
  return withUser(pool, userId, async (c) => {
    try {
      const r = await c.query(
        `INSERT INTO evidence_files (org_id, tenant_id, audit_control_id, provider_file_id, file_name, size_bytes, mime_type,
                                      hash_algo, provider_hash, provider_version, scan_status, uploaded_by)
         SELECT org_id, tenant_id, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10 FROM audit_controls WHERE id = $1
         RETURNING id, file_name, scan_status, org_id, tenant_id`,
        [controlId, providerFileId, meta.name, meta.sizeBytes, meta.mimeType, meta.hashAlgo, meta.hash, meta.version, scanStatus, userId],
      );
      const row = r.rows[0];
      await logAudit(c, { orgId: row.org_id, tenantId: row.tenant_id, actorId: userId, action: "evidence.uploaded", entity: "audit_control", entityId: controlId, change: { fileName: row.file_name, scanStatus: row.scan_status } });
      return { id: row.id, file_name: row.file_name, scan_status: row.scan_status };
    } catch (e) {
      throw mapDbError(e);
    }
  });
}

/** Moves a control from awaiting-evidence/rejected to submitted. The database enforces that at least
 *  one evidence file exists and that the caller is allowed to submit. */
export async function submitControl(pool: Pool, userId: string, controlId: string) {
  return withUser(pool, userId, async (c) => {
    try {
      const r = await c.query("UPDATE audit_controls SET status = 'submitted' WHERE id = $1 RETURNING id, status, org_id, tenant_id", [controlId]);
      if (r.rowCount === 0) throw new AppError("Control not found or not visible to you.", 404, "NOT_FOUND");
      const row = r.rows[0];
      await logAudit(c, { orgId: row.org_id, tenantId: row.tenant_id, actorId: userId, action: "control.submitted", entity: "audit_control", entityId: controlId });
      return { id: row.id, status: row.status };
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw mapDbError(e);
    }
  });
}

export interface FileListEntry {
  id: string; fileName: string; sizeBytes: number; scanStatus: string; integrityStatus: string; uploadedAt: Date; providerFileId: string;
}

/** The evidence files recorded for a control, as stored in our database (fast, no provider round trip). */
export async function listEvidenceFiles(pool: Pool, userId: string, controlId: string): Promise<FileListEntry[]> {
  return withUser(pool, userId, async (c) => {
    const r = await c.query(
      `SELECT id, file_name, size_bytes, scan_status, integrity_status, uploaded_at, provider_file_id
       FROM evidence_files WHERE audit_control_id = $1 ORDER BY uploaded_at`, [controlId]);
    return r.rows.map((row) => ({
      id: row.id, fileName: row.file_name, sizeBytes: row.size_bytes, scanStatus: row.scan_status,
      integrityStatus: row.integrity_status, uploadedAt: row.uploaded_at, providerFileId: row.provider_file_id,
    }));
  });
}

export interface IntegrityCheckResult { evidenceFileId: string; changed: boolean }

/**
 * Compares each accepted control's recorded evidence hash against the provider's current one. Run
 * periodically (e.g. hourly) by a scheduled job authenticated as an org_admin or lead_auditor — those
 * are the only roles the database allows to move a control from accepted back to under_review.
 */
export async function checkIntegrity(pool: Pool, userId: string, storage: StorageProvider, auditId: string): Promise<IntegrityCheckResult[]> {
  // A closed cycle is still checked (a changed or missing file is exactly what an auditor wants to hear about), but the
  // controls themselves are frozen: the file is flagged and the finding logged, the control's status is left as it was.
  const auditClosed = await withUser(pool, userId, (c) =>
    c.query("SELECT status = 'closed' AS closed FROM audits WHERE id = $1", [auditId]).then((r) => r.rows[0]?.closed === true));
  const rows = await withUser(pool, userId, (c) =>
    c.query(
      `SELECT ef.id, ef.audit_control_id, ef.provider_file_id, ef.provider_hash, ef.provider_version
       FROM evidence_files ef JOIN audit_controls ac ON ac.id = ef.audit_control_id
       WHERE ac.audit_id = $1 AND ac.status = 'accepted'`, [auditId],
    ).then((r) => r.rows as { id: string; audit_control_id: string; provider_file_id: string; provider_hash: string; provider_version: string }[]));

  const results: IntegrityCheckResult[] = [];
  for (const row of rows) {
    let current;
    try {
      current = await storage.getFileMetadata(row.provider_file_id);
    } catch (e) {
      if (e instanceof StorageError && e.code === "NOT_FOUND") {
        await flagChanged(pool, userId, row.id, row.audit_control_id, "missing", auditClosed);
        results.push({ evidenceFileId: row.id, changed: true });
        continue;
      }
      throw e;
    }
    const changed = current.hash !== row.provider_hash || current.version !== row.provider_version;
    if (changed) await flagChanged(pool, userId, row.id, row.audit_control_id, "modified", auditClosed);
    results.push({ evidenceFileId: row.id, changed });
  }
  return results;
}

async function flagChanged(pool: Pool, userId: string, evidenceFileId: string, controlId: string, status: "modified" | "missing", auditClosed: boolean) {
  await withUser(pool, userId, async (c) => {
    await c.query("UPDATE evidence_files SET integrity_status = $1 WHERE id = $2", [status, evidenceFileId]);
    // In a closed cycle the control stays as it was signed off; reopening it is the way to put it back under review.
    const r = auditClosed ? { rows: [] as { org_id: string; tenant_id: string }[] }
      : await c.query("UPDATE audit_controls SET status = 'under_review' WHERE id = $1 AND status = 'accepted' RETURNING org_id, tenant_id", [controlId]);
    const ctx = r.rows[0] ?? await c.query("SELECT org_id, tenant_id FROM audit_controls WHERE id = $1", [controlId]).then((r2) => r2.rows[0]);
    if (ctx) {
      await logAudit(c, {
        orgId: ctx.org_id, tenantId: ctx.tenant_id, actorId: userId, action: "evidence.integrity_flagged", entity: "evidence_file", entityId: evidenceFileId,
        change: auditClosed ? { status, auditClosed: true } : { status },
      });
    }
  });
}

export interface DownloadableFile { stream: Readable; fileName: string; sizeBytes: number }

/**
 * Opens a recorded evidence file for the person asking. Whether they may see it is decided by the database, exactly as for
 * the file list: a file they can't see is "not found". The download is written to the audit log, so "who took a copy of this
 * evidence" can be answered.
 */
export async function openEvidenceDownload(pool: Pool, userId: string, storage: StorageProvider, evidenceFileId: string): Promise<DownloadableFile> {
  const row = await withUser(pool, userId, async (c) => {
    try {
      const r = await c.query("SELECT id, org_id, tenant_id, provider_file_id, file_name FROM evidence_files WHERE id = $1", [evidenceFileId]);
      return r.rows[0] as { id: string; org_id: string; tenant_id: string; provider_file_id: string; file_name: string } | undefined;
    } catch (e) {
      throw mapDbError(e);
    }
  });
  if (!row) throw new AppError("File not found.", 404, "NOT_FOUND");
  const open = storage.openFile?.bind(storage);
  if (!open) throw new AppError("This storage doesn't offer downloads through the portal.", 501, "DOWNLOAD_UNSUPPORTED");
  const opened = await withStorageErrors(() => open(row.provider_file_id));
  try {
    await withUser(pool, userId, (c) => logAudit(c, { orgId: row.org_id, tenantId: row.tenant_id, actorId: userId, action: "evidence.downloaded", entity: "evidence_file", entityId: row.id, change: { fileName: row.file_name } }));
  } catch (e) {
    opened.stream.destroy();
    throw e;
  }
  return { stream: opened.stream, fileName: row.file_name, sizeBytes: opened.sizeBytes };
}
