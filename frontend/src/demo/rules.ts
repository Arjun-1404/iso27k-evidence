// The rules the real server's database enforces, written out as plain functions so the in-browser demo behaves the
// same way. Each one mirrors a named piece of db/migrations (the comment says which). They are pure: no state, no clock.
//
// NOT shared with the real server's code on purpose: the web app must never depend on the backend's folder layout
// (see api/types.ts). Instead, demo/rules.test.ts spells out every rule as a test, and the real server's own tests
// spell out the same rules against a real database, so a drift on either side shows up as a failing test.

import type { ControlStatus, Dashboard, FileSpec, Role } from "../api/types";

export const AUDITOR_SIDE_ROLES: readonly Role[] = ["org_admin", "lead_auditor", "auditor", "read_only", "dashboard_only"];
export const TENANT_SIDE_ROLES: readonly Role[] = ["tenant_lead", "contributor", "viewer", "tenant_dashboard"];

export const isAuditorSide = (role: Role): boolean => AUDITOR_SIDE_ROLES.includes(role);

/** Roles that never read control detail: they only get the dashboard numbers (001_core: can_read_control). */
export const DASHBOARD_ONLY_ROLES: readonly Role[] = ["dashboard_only", "tenant_dashboard"];

/** 001_core: status_transition_ok(old, new, role). */
export function statusTransitionOk(oldStatus: ControlStatus, newStatus: ControlStatus, role: Role): boolean {
  if (oldStatus === newStatus) return true;
  if (role === "tenant_lead" || role === "contributor") {
    return newStatus === "submitted" && (oldStatus === "not_started" || oldStatus === "awaiting_evidence" || oldStatus === "rejected");
  }
  if (role === "auditor" || role === "lead_auditor" || role === "org_admin") {
    return (oldStatus === "not_started" && newStatus === "awaiting_evidence")
      || ((oldStatus === "submitted" || oldStatus === "under_review") && (newStatus === "under_review" || newStatus === "accepted" || newStatus === "rejected"))
      || (oldStatus === "accepted" && newStatus === "under_review");
  }
  return false;
}

/** Statuses in which a reminder makes sense: evidence is still outstanding (001_core: REMINDER_NOT_ALLOWED). */
export const OUTSTANDING: readonly ControlStatus[] = ["not_started", "awaiting_evidence", "rejected"];
export const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// ---- file rules (services/fileSpec.ts) -------------------------------------------------------------------------------

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const DEFAULT_MAX_FILES_PER_CONTROL = 10;

interface TypeEntry { mime: string; ext: string; category: "document" | "image" | "spreadsheet" }
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

export type FileCheck = { ok: true } | { ok: false; reason: string };

export function validateFile(f: { fileName: string; mimeType: string; sizeBytes: number }, spec: FileSpec | undefined, existingCount: number): FileCheck {
  // eslint-disable-next-line no-control-regex -- file names must not contain control characters
  if (/[\\/\x00-\x1f]/.test(f.fileName) || f.fileName.length > 255 || f.fileName.trim().length === 0 || f.fileName !== f.fileName.trim()) {
    return { ok: false, reason: "The file name is not valid." };
  }
  if (f.sizeBytes <= 0 || f.sizeBytes > MAX_UPLOAD_BYTES) {
    return { ok: false, reason: `Files must be between 1 byte and ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.` };
  }
  const entry = BY_MIME.get(f.mimeType);
  if (!entry || !f.fileName.toLowerCase().endsWith(entry.ext)) {
    return { ok: false, reason: "That file type isn't allowed. Allowed: PDF, Word, text, images, or spreadsheets." };
  }
  const categories = (spec?.types ?? ["any"]).filter((c) => c !== "any");
  if (categories.length > 0 && !categories.includes(entry.category)) {
    return { ok: false, reason: `This control expects: ${categories.join(", ")}.` };
  }
  const maxFiles = spec?.maxFiles ?? DEFAULT_MAX_FILES_PER_CONTROL;
  if (existingCount >= maxFiles) return { ok: false, reason: `This control already has the maximum of ${maxFiles} file(s).` };
  return { ok: true };
}

// ---- passwords (auth/password.ts) --------------------------------------------------------------------------------------

export function checkPasswordStrength(plain: string): { ok: true } | { ok: false; reason: string } {
  if (plain.length < 12) return { ok: false, reason: "Password must be at least 12 characters." };
  if (plain.length > 256) return { ok: false, reason: "Password is too long." };
  if (["password123", "123456789012", "qwertyuiop12", "letmein12345"].includes(plain.toLowerCase())) {
    return { ok: false, reason: "That password is too common. Please choose another." };
  }
  return { ok: true };
}

// ---- the dashboard (001_core: dashboard_summary) ----------------------------------------------------------------------

export interface DashboardRow { applicable: boolean; status: ControlStatus; dueDate: string | null; section: string; sortOrder: number }

/** Postgres orders a jsonb object's keys by length, then alphabetically; the real API lists the statuses in that order. */
const byJsonbKeyOrder = (a: string, b: string) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0);

/** `today` is a YYYY-MM-DD date: a control is overdue when it is applicable, not accepted, and its due date is before today. */
export function dashboardSummary(rows: DashboardRow[], today: string): Dashboard {
  const applicable = rows.filter((r) => r.applicable);
  const accepted = applicable.filter((r) => r.status === "accepted").length;
  const counts = new Map<ControlStatus, number>();
  for (const r of applicable) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);

  const sections = new Map<string, { order: number; applicable: number; accepted: number }>();
  for (const r of rows) {
    const s = sections.get(r.section) ?? { order: r.sortOrder, applicable: 0, accepted: 0 };
    s.order = Math.min(s.order, r.sortOrder);
    if (r.applicable) { s.applicable += 1; if (r.status === "accepted") s.accepted += 1; }
    sections.set(r.section, s);
  }

  return {
    total: rows.length,
    applicable: applicable.length,
    notApplicable: rows.length - applicable.length,
    accepted,
    overdue: applicable.filter((r) => r.status !== "accepted" && r.dueDate !== null && r.dueDate < today).length,
    // round(100.0 * accepted / applicable, 1), or 0 when nothing is applicable. Integer maths first, so no float drift.
    completionPct: applicable.length === 0 ? 0 : Math.round((1000 * accepted) / applicable.length) / 10,
    byStatus: [...counts.entries()].sort(([a], [b]) => byJsonbKeyOrder(a, b)).map(([status, count]) => ({ status, count })),
    bySection: [...sections.entries()].sort(([, a], [, b]) => a.order - b.order).map(([section, s]) => ({ section, applicable: s.applicable, accepted: s.accepted })),
  };
}
