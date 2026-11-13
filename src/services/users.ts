import type { Pool, PoolClient } from "pg";
import { withUser } from "../db/pool.ts";
import { AppError, mapDbError } from "../errors.ts";
import { logAudit } from "./auditLog.ts";
import { generateInviteToken } from "../auth/inviteToken.ts";
import type { EmailSender } from "../email/types.ts";
import { deliver, EMAIL_FAILED } from "./emailDelivery.ts";

export interface InviteDelivery { email: EmailSender; appBaseUrl: string }

function inviteMessage(appBaseUrl: string, rawToken: string) {
  const link = `${appBaseUrl}/accept-invite?token=${rawToken}`;
  return {
    subject: "You've been invited to the Evidence Portal",
    text: `You've been invited to the Evidence Portal. Set your password to get started: ${link}\n\nThis link expires in 7 days.`,
  };
}

/** Best-effort send used when the invite itself has already been saved: a failure is reported to the
 *  caller as `false` (so the UI can say "invited, but the email didn't go out — use Resend") instead of
 *  failing a request whose real work succeeded. Returns undefined when no email delivery is configured. */
async function tryInviteEmail(delivery: InviteDelivery | undefined, to: string, rawToken: string): Promise<boolean | undefined> {
  if (!delivery) return undefined;
  try {
    await deliver(delivery.email, { to: [to], ...inviteMessage(delivery.appBaseUrl, rawToken) });
    return true;
  } catch (e) {
    if (e instanceof AppError && e.code === EMAIL_FAILED) return false;
    throw e;
  }
}

export const AUDITOR_ROLES = ["org_admin", "lead_auditor", "auditor", "read_only", "dashboard_only"] as const;
export const TENANT_ROLES = ["tenant_lead", "contributor", "viewer", "tenant_dashboard"] as const;
export type AuditorRole = (typeof AUDITOR_ROLES)[number];
export type TenantRole = (typeof TENANT_ROLES)[number];

export interface NewUser { email: string; fullName?: string; role: string }

/** `emailSent` is present only when an email delivery was attempted: true if it went out, false if the
 *  invite was saved but the email could not be sent (the caller should offer "Resend"). */
export interface InvitedUser { id: string; email: string; role: string; status: string; emailSent?: boolean }

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw mapDbError(e);
  }
}

/** Invites an auditor-side user (no tenant). org_id is derived from the caller's own row, so a
 *  request can never create a user in a different org than the caller belongs to. Every invite gets
 *  a token (so it can be resent later even if no EmailSender is supplied here); it's only emailed
 *  when `delivery` is given. */
export async function inviteAuditorUser(pool: Pool, userId: string, u: NewUser, delivery?: InviteDelivery): Promise<InvitedUser> {
  const invite = generateInviteToken();
  const result = await withUser(pool, userId, (c) => run(async () => {
    const r = await c.query(
      `INSERT INTO users (org_id, email, full_name, role, invite_token_hash, invite_token_expires_at)
       SELECT org_id, $2, $3, $4, $5, $6 FROM users WHERE id = $1 RETURNING id, org_id, email, role, status`,
      [userId, u.email, u.fullName ?? null, u.role, invite.tokenHash, invite.expiresAt],
    );
    if (r.rowCount === 0) throw new AppError("Could not resolve your organisation.", 403, "FORBIDDEN");
    const row = r.rows[0];
    await logAudit(c, { orgId: row.org_id, actorId: userId, action: "user.invited", entity: "user", entityId: row.id, change: { role: u.role, side: "auditor" } });
    return { id: row.id, email: row.email, role: row.role, status: row.status };
  }));
  const emailSent = await tryInviteEmail(delivery, result.email, invite.token);
  return emailSent === undefined ? result : { ...result, emailSent };
}

/** Invites a tenant-side user. org_id AND tenant_id are both derived from the tenant row itself
 *  (which the caller can only see if it's in their own org and, for non-admins, assigned to them),
 *  so the client cannot point the invite at a tenant outside the caller's reach. */
export async function inviteTenantUser(pool: Pool, userId: string, tenantId: string, u: NewUser, delivery?: InviteDelivery): Promise<InvitedUser> {
  const invite = generateInviteToken();
  const result = await withUser(pool, userId, (c) => run(async () => {
    const r = await c.query(
      `INSERT INTO users (org_id, tenant_id, email, full_name, role, invite_token_hash, invite_token_expires_at)
       SELECT t.org_id, t.id, $2, $3, $4, $5, $6 FROM tenants t WHERE t.id = $1 RETURNING id, org_id, tenant_id, email, role, status`,
      [tenantId, u.email, u.fullName ?? null, u.role, invite.tokenHash, invite.expiresAt],
    );
    if (r.rowCount === 0) throw new AppError("Tenant not found or not visible to you.", 404, "NOT_FOUND");
    const row = r.rows[0];
    await logAudit(c, { orgId: row.org_id, tenantId: row.tenant_id, actorId: userId, action: "user.invited", entity: "user", entityId: row.id, change: { role: u.role, side: "tenant" } });
    return { id: row.id, email: row.email, role: row.role, status: row.status };
  }));
  const emailSent = await tryInviteEmail(delivery, result.email, invite.token);
  return emailSent === undefined ? result : { ...result, emailSent };
}

/** Issues a fresh invite token for a user who hasn't completed signup yet (lost email, expired link)
 *  and, if `delivery` is given, re-sends it. */
export async function resendInvite(pool: Pool, userId: string, targetUserId: string, delivery?: InviteDelivery) {
  const invite = generateInviteToken();
  // The new token and the email go out together: if the email can't be sent, the transaction rolls back and
  // the user's previous invite link keeps working, instead of being silently replaced by one nobody received.
  return withUser(pool, userId, (c) => run(async () => {
    const r = await c.query(
      "UPDATE users SET invite_token_hash = $2, invite_token_expires_at = $3 WHERE id = $1 AND status = 'invited' RETURNING id, email",
      [targetUserId, invite.tokenHash, invite.expiresAt],
    );
    if (r.rowCount === 0) throw new AppError("That invite no longer exists or has already been accepted.", 404, "NOT_FOUND");
    if (delivery) await deliver(delivery.email, { to: [r.rows[0].email], ...inviteMessage(delivery.appBaseUrl, invite.token) });
    return { id: r.rows[0].id as string };
  }));
}

/** Adds `mfa_enabled` (yes/no) to each row — but only when the caller is an organisation admin, who is the only
 *  person the database tells (mfa_org_status() returns nothing for anyone else, so the key is simply absent). */
async function withMfaFlag<T extends { id: string }>(c: PoolClient, rows: T[]): Promise<Array<T & { mfa_enabled?: boolean }>> {
  const flags = new Map<string, boolean>((await c.query("SELECT user_id, enabled FROM mfa_org_status()")).rows.map((x) => [x.user_id, x.enabled]));
  return flags.size === 0 ? rows : rows.map((row) => ({ ...row, mfa_enabled: flags.get(row.id) ?? false }));
}

export async function listOrgUsers(pool: Pool, userId: string) {
  return withUser(pool, userId, async (c) =>
    withMfaFlag(c, (await c.query("SELECT id, email, full_name, role, status FROM users WHERE tenant_id IS NULL ORDER BY email")).rows));
}

export async function listTenantUsers(pool: Pool, userId: string, tenantId: string) {
  return withUser(pool, userId, async (c) =>
    withMfaFlag(c, (await c.query("SELECT id, email, full_name, role, status FROM users WHERE tenant_id = $1 ORDER BY email", [tenantId])).rows));
}

async function setUserStatus(pool: Pool, userId: string, targetUserId: string, status: "active" | "disabled") {
  return withUser(pool, userId, (c) => run(async () => {
    const r = await c.query("UPDATE users SET status = $2 WHERE id = $1 RETURNING id, status, org_id, tenant_id", [targetUserId, status]);
    if (r.rowCount === 0) throw new AppError("User not found or not visible to you.", 404, "NOT_FOUND");
    const row = r.rows[0];
    await logAudit(c, { orgId: row.org_id, tenantId: row.tenant_id, actorId: userId, action: `user.${status}`, entity: "user", entityId: row.id });
    return { id: row.id, status: row.status };
  }));
}
export const disableUser = (pool: Pool, userId: string, targetUserId: string) => setUserStatus(pool, userId, targetUserId, "disabled");
export const reactivateUser = (pool: Pool, userId: string, targetUserId: string) => setUserStatus(pool, userId, targetUserId, "active");

export async function assignAuditorToTenant(pool: Pool, userId: string, auditorUserId: string, tenantId: string) {
  return withUser(pool, userId, (c) => run(async () => {
    const r = await c.query(
      "INSERT INTO auditor_assignments (org_id, user_id, tenant_id) SELECT org_id, $2, $3 FROM users WHERE id = $1 ON CONFLICT DO NOTHING RETURNING org_id",
      [userId, auditorUserId, tenantId],
    );
    if ((r.rowCount ?? 0) > 0) {
      await logAudit(c, { orgId: r.rows[0].org_id, tenantId, actorId: userId, action: "auditor.assigned", entity: "user", entityId: auditorUserId });
    }
    return { auditorUserId, tenantId };
  }));
}

export async function unassignAuditorFromTenant(pool: Pool, userId: string, auditorUserId: string, tenantId: string) {
  return withUser(pool, userId, (c) =>
    c.query("DELETE FROM auditor_assignments WHERE user_id = $1 AND tenant_id = $2", [auditorUserId, tenantId])
      .then((r) => ({ removed: (r.rowCount ?? 0) > 0 })));
}

/** Roles of a client's people who can be given a control: the ones who do the work. */
export const ASSIGNABLE_ROLES = ["contributor", "tenant_lead"] as const;
/** The most controls one request may hand out (a whole template is about a hundred). */
export const MAX_BULK_ASSIGN = 200;

export interface ControlAssignee { userId: string; email: string; fullName: string | null; role: string }

/**
 * Checks, with plain-language errors, that `targetUserId` may be given controls of `tenantId`. The database enforces
 * the same rule (migration 013) whatever this does; this is here so the person is told WHY instead of "no access".
 * A person the caller can't see is reported as not found, the same as one that doesn't exist.
 */
async function requireAssignable(c: PoolClient, targetUserId: string, tenantId: string) {
  const t = await c.query("SELECT tenant_id, role, status FROM users WHERE id = $1", [targetUserId]);
  if (t.rowCount === 0) throw new AppError("That person was not found.", 404, "NOT_FOUND");
  const { tenant_id, role, status } = t.rows[0];
  if (tenant_id !== tenantId) throw new AppError("That person belongs to a different client.", 400, "ASSIGNEE_WRONG_TENANT");
  if (!(ASSIGNABLE_ROLES as readonly string[]).includes(role)) {
    throw new AppError("Only a client's contributors and leads can be given controls.", 400, "ASSIGNEE_ROLE");
  }
  if (status === "disabled") throw new AppError("That person's account is switched off.", 400, "ASSIGNEE_DISABLED");
}

export async function assignControlToUser(pool: Pool, userId: string, controlId: string, targetUserId: string) {
  return withUser(pool, userId, (c) => run(async () => {
    const ctl = await c.query("SELECT org_id, tenant_id FROM audit_controls WHERE id = $1", [controlId]);
    if (ctl.rowCount === 0) throw new AppError("Control not found or not visible to you.", 404, "NOT_FOUND");
    const { org_id, tenant_id } = ctl.rows[0];
    await requireAssignable(c, targetUserId, tenant_id);
    const r = await c.query(
      "INSERT INTO control_assignments (org_id, tenant_id, audit_control_id, user_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING audit_control_id",
      [org_id, tenant_id, controlId, targetUserId],
    );
    if ((r.rowCount ?? 0) > 0) {
      await logAudit(c, { orgId: org_id, tenantId: tenant_id, actorId: userId, action: "control.assigned", entity: "audit_control", entityId: controlId, change: { userId: targetUserId } });
    }
    return { controlId, targetUserId };
  }));
}

/**
 * Gives one person several controls of an audit in one go (all or nothing). Controls they already have are left as
 * they are and not counted. Each control that is newly assigned gets its own audit-log entry, so the log answers
 * "who gave whom this control, and when" for every control, whichever way it was assigned.
 */
export async function assignControlsToUser(pool: Pool, userId: string, auditId: string, targetUserId: string, controlIds: string[]) {
  const ids = [...new Set(controlIds)];
  if (ids.length === 0) throw new AppError("Choose at least one control.", 400, "VALIDATION");
  if (ids.length > MAX_BULK_ASSIGN) throw new AppError(`Assign at most ${MAX_BULK_ASSIGN} controls at a time.`, 400, "VALIDATION");
  return withUser(pool, userId, (c) => run(async () => {
    const found = await c.query("SELECT org_id, tenant_id FROM audit_controls WHERE audit_id = $1 AND id = ANY($2::uuid[])", [auditId, ids]);
    if (found.rowCount !== ids.length) throw new AppError("Some of those controls were not found in this audit.", 404, "NOT_FOUND");
    const { org_id, tenant_id } = found.rows[0]; // an audit belongs to one client, so they all share these
    await requireAssignable(c, targetUserId, tenant_id);
    const r = await c.query(
      "INSERT INTO control_assignments (org_id, tenant_id, audit_control_id, user_id) SELECT org_id, tenant_id, id, $3 FROM audit_controls WHERE audit_id = $1 AND id = ANY($2::uuid[]) ON CONFLICT DO NOTHING RETURNING audit_control_id",
      [auditId, ids, targetUserId],
    );
    for (const row of r.rows) {
      await logAudit(c, { orgId: org_id, tenantId: tenant_id, actorId: userId, action: "control.assigned", entity: "audit_control", entityId: row.audit_control_id, change: { userId: targetUserId } });
    }
    return { assigned: r.rowCount ?? 0 };
  }));
}

/** Who a control is assigned to. A contributor is only ever told about themselves (row-level security). */
export async function listControlAssignees(pool: Pool, userId: string, controlId: string): Promise<ControlAssignee[]> {
  return withUser(pool, userId, (c) => run(async () => {
    const ctl = await c.query("SELECT 1 FROM audit_controls WHERE id = $1", [controlId]);
    if (ctl.rowCount === 0) throw new AppError("Control not found or not visible to you.", 404, "NOT_FOUND");
    const r = await c.query(
      `SELECT u.id, u.email, u.full_name, u.role FROM control_assignments ca JOIN users u ON u.id = ca.user_id
       WHERE ca.audit_control_id = $1 ORDER BY lower(u.email)`, [controlId]);
    return r.rows.map((x): ControlAssignee => ({ userId: x.id, email: x.email, fullName: x.full_name, role: x.role }));
  }));
}

export async function unassignControlFromUser(pool: Pool, userId: string, controlId: string, targetUserId: string) {
  return withUser(pool, userId, (c) => run(async () => {
    const r = await c.query("DELETE FROM control_assignments WHERE audit_control_id = $1 AND user_id = $2 RETURNING org_id, tenant_id", [controlId, targetUserId]);
    if ((r.rowCount ?? 0) > 0) {
      await logAudit(c, { orgId: r.rows[0].org_id, tenantId: r.rows[0].tenant_id, actorId: userId, action: "control.unassigned", entity: "audit_control", entityId: controlId, change: { userId: targetUserId } });
    }
    return { removed: (r.rowCount ?? 0) > 0 };
  }));
}
