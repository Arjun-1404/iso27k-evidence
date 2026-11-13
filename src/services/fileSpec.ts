/**
 * The file-type allowlist and size limit are enforced here, once, and used by every upload path.
 * An auditor's per-control file spec (see audit_controls.evidence_override / file_spec_override) can
 * only ever NARROW this list — it is intersected with the platform allowlist, never replace it — so no
 * auditor configuration can widen what a tenant is allowed to upload.
 */

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB
export const DEFAULT_MAX_FILES_PER_CONTROL = 10;

export type FileCategory = "document" | "image" | "spreadsheet" | "any";

interface TypeEntry { mime: string; ext: string; category: Exclude<FileCategory, "any"> }

// The platform-wide allowlist. No executables, scripts, HTML, SVG, or macro-enabled Office formats.
const ALLOWLIST: TypeEntry[] = [
  { mime: "application/pdf", ext: ".pdf", category: "document" },
  { mime: "application/msword", ext: ".doc", category: "document" },
  { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: ".docx", category: "document" },
  { mime: "application/vnd.oasis.opendocument.text", ext: ".odt", category: "document" },
  { mime: "text/plain", ext: ".txt", category: "document" },
  { mime: "image/png", ext: ".png", category: "image" },
  { mime: "image/jpeg", ext: ".jpg", category: "image" },
  { mime: "image/gif", ext: ".gif", category: "image" },
  { mime: "image/webp", ext: ".webp", category: "image" },
  { mime: "application/vnd.ms-excel", ext: ".xls", category: "spreadsheet" },
  { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: ".xlsx", category: "spreadsheet" },
  { mime: "application/vnd.oasis.opendocument.spreadsheet", ext: ".ods", category: "spreadsheet" },
  { mime: "text/csv", ext: ".csv", category: "spreadsheet" },
];
const BY_MIME = new Map(ALLOWLIST.map((e) => [e.mime, e]));

/** The content type that goes with a file name's ending, among the allowed types; anything else is a plain download. */
export function mimeTypeForFileName(fileName: string): string {
  const lower = fileName.toLowerCase();
  return ALLOWLIST.find((e) => lower.endsWith(e.ext))?.mime ?? "application/octet-stream";
}

export interface FileSpec {
  types?: FileCategory[];
  maxFiles?: number;
}

export interface FileToValidate {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export type ValidationResult = { ok: true } | { ok: false; reason: string };

/** True if fileName's extension and mimeType agree with each other AND both appear in the platform allowlist. */
function isAllowedType(f: FileToValidate): boolean {
  const entry = BY_MIME.get(f.mimeType);
  if (!entry) return false;
  return f.fileName.toLowerCase().endsWith(entry.ext);
}

export function validateFile(f: FileToValidate, spec: FileSpec | undefined, existingCount: number): ValidationResult {
  if (/[\\/\x00-\x1f]/.test(f.fileName) || f.fileName.length > 255 || f.fileName.trim().length === 0 || f.fileName !== f.fileName.trim()) {
    return { ok: false, reason: "The file name is not valid." };
  }
  if (f.sizeBytes <= 0 || f.sizeBytes > MAX_UPLOAD_BYTES) {
    return { ok: false, reason: `Files must be between 1 byte and ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.` };
  }
  if (!isAllowedType(f)) {
    return { ok: false, reason: "That file type isn't allowed. Allowed: PDF, Word, text, images, or spreadsheets." };
  }
  const categories = (spec?.types ?? ["any"]).filter((c) => c !== "any");
  if (categories.length > 0) {
    const entry = BY_MIME.get(f.mimeType)!;
    if (!categories.includes(entry.category)) {
      return { ok: false, reason: `This control expects: ${categories.join(", ")}.` };
    }
  }
  const maxFiles = spec?.maxFiles ?? DEFAULT_MAX_FILES_PER_CONTROL;
  if (existingCount >= maxFiles) {
    return { ok: false, reason: `This control already has the maximum of ${maxFiles} file(s).` };
  }
  return { ok: true };
}
