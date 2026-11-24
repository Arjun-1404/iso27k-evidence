import type { Pool, PoolClient } from "pg";
import { withUser } from "../db/pool.ts";
import { AppError, mapDbError } from "../errors.ts";
import type { EmailSender } from "../email/types.ts";
import { sendReminderOn } from "./controls.ts";
import { deliver } from "./emailDelivery.ts";
import { logAudit } from "./auditLog.ts";

/** "close" is the firm accepting a control with no evidence from the client (see migration 016): a written reason is required. */
export type ReviewDecision = "accept" | "reject" | "close";

/** Records the review decision and moves the control's status in the same transaction, so the two are
 *  always consistent (never a review row with no matching status change, or vice versa).
 *
 *  A "close" is the firm's own sign-off for a control the client never had to (or could not) provide evidence for. The
 *  database lets it through only because the "close" review row is written first, in this same transaction; the reason
 *  is also added to the control's comment thread, so the client's people can see why it was closed. */
export async function reviewControl(pool: Pool, userId: string, controlId: string, decision: ReviewDecision, reason?: string) {
  const newStatus = decision === "reject" ? "rejected" : "accepted";
  return withUser(pool, userId, async (c) => {
    try {
      if (decision === "close") await requireClosable(c, controlId);
      await c.query(
        "INSERT INTO reviews (org_id, tenant_id, audit_control_id, reviewer_id, decision, reason) SELECT org_id, tenant_id, $1, $2, $3, $4 FROM audit_controls WHERE id = $1",
        [controlId, userId, decision, reason ?? null],
      );
      const r = await c.query("UPDATE audit_controls SET status = $2 WHERE id = $1 RETURNING id, status, org_id, tenant_id", [controlId, newStatus]);
      if (r.rowCount === 0) throw new AppError("Control not found or not visible to you.", 404, "NOT_FOUND");
      const row = r.rows[0];
      // Only when the person's role may comment: the close must not depend on it, and the audit log has the reason either way.
      if (decision === "close" && (await c.query("SELECT app_allows('comment') AS ok")).rows[0].ok) {
        await c.query(
          "INSERT INTO comments (org_id, tenant_id, audit_control_id, author_id, type, body) VALUES ($1,$2,$3,$4,'comment',$5)",
          [row.org_id, row.tenant_id, controlId, userId, `Closed by the audit firm without client evidence. Reason: ${reason}`],
        );
      }
      await logAudit(c, { orgId: row.org_id, tenantId: row.tenant_id, actorId: userId, action: `control.${decision}`, entity: "audit_control", entityId: controlId, change: { status: newStatus, reason: reason ?? null } });
      return { id: row.id, status: row.status };
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw mapDbError(e);
    }
  });
}

/** Plain-language reasons a control can't be closed (the database refuses the same cases, with less helpful words). */
async function requireClosable(c: PoolClient, controlId: string) {
  const r = await c.query("SELECT status, applicable FROM audit_controls WHERE id = $1", [controlId]);
  if (r.rowCount === 0) throw new AppError("Control not found or not visible to you.", 404, "NOT_FOUND");
  const { status, applicable } = r.rows[0];
  if (!applicable) throw new AppError("This control is marked not applicable, so there is nothing to close.", 409, "NOT_APPLICABLE");
  if (status === "accepted") throw new AppError("This control is already accepted.", 409, "ALREADY_ACCEPTED");
  if (status === "submitted") throw new AppError("The client has submitted evidence for this control. Review it and accept or reject it instead.", 409, "NEEDS_REVIEW");
}

export type CommentType = "comment" | "major" | "minor" | "ofi" | "observation";

export async function addComment(pool: Pool, userId: string, controlId: string, type: CommentType, body: string) {
  return withUser(pool, userId, async (c) => {
    try {
      const r = await c.query(
        "INSERT INTO comments (org_id, tenant_id, audit_control_id, author_id, type, body) SELECT org_id, tenant_id, $1, $2, $3, $4 FROM audit_controls WHERE id = $1 RETURNING id, type, body, created_at, org_id, tenant_id",
        [controlId, userId, type, body],
      );
      if (r.rowCount === 0) throw new AppError("Control not found or not visible to you.", 404, "NOT_FOUND");
      const row = r.rows[0];
      await logAudit(c, { orgId: row.org_id, tenantId: row.tenant_id, actorId: userId, action: "control.comment", entity: "audit_control", entityId: controlId, change: { type } });
      return { id: row.id, type: row.type, body: row.body, created_at: row.created_at };
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw mapDbError(e);
    }
  });
}

export async function listComments(pool: Pool, userId: string, controlId: string) {
  return withUser(pool, userId, (c) =>
    c.query("SELECT id, type, body, author_id, created_at FROM comments WHERE audit_control_id = $1 ORDER BY created_at", [controlId])
      .then((r) => r.rows));
}

/** Marks the reminder as sent (rate-limited by the database) and emails everyone assigned to the
 *  control. If a contributor is assigned, only they are emailed; otherwise every tenant_lead is.
 *  The reminder is recorded and emailed in ONE transaction: if the email can't be sent, nothing is
 *  recorded, so a mail-server hiccup doesn't use up the control's once-a-day reminder allowance. */
export async function remindForControl(pool: Pool, userId: string, email: EmailSender, controlId: string) {
  return withUser(pool, userId, async (c) => {
    await sendReminderOn(c, userId, controlId); // throws the rate-limit / not-allowed errors
    const recipients = await c.query(
      `SELECT DISTINCT u.email FROM control_assignments ca JOIN users u ON u.id = ca.user_id WHERE ca.audit_control_id = $1
       UNION
       SELECT u.email FROM audit_controls ac JOIN users u ON u.tenant_id = ac.tenant_id
       WHERE ac.id = $1 AND u.role = 'tenant_lead' AND NOT EXISTS (SELECT 1 FROM control_assignments ca2 WHERE ca2.audit_control_id = $1)`,
      [controlId],
    ).then((r) => r.rows.map((row) => row.email as string));
    const control = await c.query("SELECT control_ref, title FROM audit_controls WHERE id = $1", [controlId]).then((r) => r.rows[0]);
    if (recipients.length > 0) {
      await deliver(email, {
        to: recipients,
        subject: `Evidence requested: ${control.control_ref} ${control.title}`,
        text: `Evidence is still needed for ${control.control_ref} ${control.title}. Please upload it in the portal.`,
      });
    }
    return { remindedCount: recipients.length };
  });
}
