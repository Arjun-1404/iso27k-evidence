import type { Pool, PoolClient } from "pg";
import { withUser } from "../db/pool.ts";
import { AppError, mapDbError } from "../errors.ts";
import { logAudit } from "./auditLog.ts";
import type { FileSpec } from "./fileSpec.ts";

export interface ControlSummary {
  id: string; kind: string; section: string; controlRef: string; title: string;
  effectiveEvidence: string; effectiveFileSpec: FileSpec; isOverridden: boolean;
  applicable: boolean; naJustification: string | null;
  status: string; dueDate: string | null; requirementChangedAt: Date | null;
  fileCount: number;
}

export async function listControls(pool: Pool, userId: string, auditId: string): Promise<ControlSummary[]> {
  return withUser(pool, userId, async (c) => {
    const r = await c.query(
      `SELECT ac.id, ac.kind, ac.section, ac.control_ref, ac.title,
              COALESCE(ac.evidence_override, ac.base_evidence) AS effective_evidence,
              COALESCE(ac.file_spec_override, ac.base_file_spec) AS effective_file_spec,
              (ac.evidence_override IS NOT NULL OR ac.file_spec_override IS NOT NULL) AS is_overridden,
              ac.applicable, ac.na_justification, ac.status, to_char(ac.due_date, 'YYYY-MM-DD') AS due_date, ac.requirement_changed_at,
              (SELECT count(*)::int FROM evidence_files ef WHERE ef.audit_control_id = ac.id) AS file_count
       FROM audit_controls ac WHERE ac.audit_id = $1 ORDER BY ac.sort_order`,
      [auditId],
    );
    return r.rows.map((row) => ({
      id: row.id, kind: row.kind, section: row.section, controlRef: row.control_ref, title: row.title,
      effectiveEvidence: row.effective_evidence, effectiveFileSpec: row.effective_file_spec ?? {}, isOverridden: row.is_overridden,
      applicable: row.applicable, naJustification: row.na_justification, status: row.status,
      dueDate: row.due_date, requirementChangedAt: row.requirement_changed_at, fileCount: row.file_count,
    }));
  });
}

export interface RequirementUpdate { evidenceText?: string; fileSpec?: FileSpec; resetToDefault?: boolean }

/** Sets (or clears) a tenant-specific override of a control's evidence requirement. Lead auditors only
 *  — enforced by the database, this is just a thin, typed wrapper around that rule. */
export async function updateRequirement(pool: Pool, userId: string, controlId: string, update: RequirementUpdate) {
  return runUpdate(pool, userId, controlId, "control.requirement_changed", update.resetToDefault
    ? { evidence_override: null, file_spec_override: null }
    : { evidence_override: update.evidenceText ?? null, file_spec_override: update.fileSpec ? JSON.stringify(update.fileSpec) : null });
}

export async function setApplicability(pool: Pool, userId: string, controlId: string, applicable: boolean, naJustification?: string) {
  return runUpdate(pool, userId, controlId, "control.applicability_changed", { applicable, na_justification: applicable ? null : naJustification ?? null });
}

export async function setDueDate(pool: Pool, userId: string, controlId: string, dueDate: string | null) {
  return runUpdate(pool, userId, controlId, "control.due_date_changed", { due_date: dueDate });
}

export async function sendReminder(pool: Pool, userId: string, controlId: string) {
  return withUser(pool, userId, (c) => sendReminderOn(c, userId, controlId));
}

/** The same reminder update, but inside a transaction the caller already holds — so the caller can make
 *  "record the reminder" and "email it" succeed or fail together. */
export function sendReminderOn(c: PoolClient, userId: string, controlId: string) {
  return updateControlOn(c, userId, controlId, "control.reminder_sent", { last_reminded_at: new Date().toISOString() });
}

async function runUpdate(pool: Pool, userId: string, controlId: string, action: string, fields: Record<string, unknown>) {
  return withUser(pool, userId, (c) => updateControlOn(c, userId, controlId, action, fields));
}

async function updateControlOn(c: PoolClient, userId: string, controlId: string, action: string, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  const setClause = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  try {
    const r = await c.query(`UPDATE audit_controls SET ${setClause} WHERE id = $1 RETURNING id, org_id, tenant_id`, [controlId, ...keys.map((k) => fields[k])]);
    if (r.rowCount === 0) throw new AppError("Control not found or not visible to you.", 404, "NOT_FOUND");
    const row = r.rows[0];
    await logAudit(c, { orgId: row.org_id, tenantId: row.tenant_id, actorId: userId, action, entity: "audit_control", entityId: controlId, change: fields });
    return { id: row.id };
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw mapDbError(e);
  }
}
