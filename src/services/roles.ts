import type { Pool } from "pg";
import { withUser } from "../db/pool.ts";
import { AppError, mapDbError } from "../errors.ts";
import { logAudit } from "./auditLog.ts";

/**
 * Custom roles (migration 016). A custom role is a built-in role with some of its abilities taken away, plus a name of
 * the firm's own. It can only ever do LESS than the built-in role it is based on, never more: the database's
 * row-level-security rules are all written in terms of the built-in roles, and a person with a custom role still has the
 * built-in one underneath. The abilities below are the only ones that can be switched off.
 */
export const PERMISSIONS = ["review", "remind", "applicability", "due_dates", "requirements", "assign_controls", "manage_people", "comment", "close_cycle", "upload"] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** The built-in roles a custom role can be based on. (The organisation admin is deliberately left out: see migration 016.) */
export const BASE_ROLES = ["lead_auditor", "auditor", "tenant_lead", "contributor"] as const;
export type BaseRole = (typeof BASE_ROLES)[number];

/** What each base role can do to start with. Must match custom_roles_denied_fit_base in migration 016 (a test checks it). */
export const BASE_ROLE_PERMISSIONS: Record<BaseRole, readonly Permission[]> = {
  lead_auditor: ["review", "remind", "applicability", "due_dates", "requirements", "assign_controls", "manage_people", "comment", "close_cycle"],
  auditor: ["review", "remind", "comment"],
  tenant_lead: ["upload", "assign_controls", "manage_people", "comment"],
  contributor: ["upload", "comment"],
};

export const PERMISSION_INFO: Record<Permission, { label: string; hint: string }> = {
  review: { label: "Review controls", hint: "Accept, reject or close a control." },
  remind: { label: "Send reminders", hint: "Email the client that evidence is still needed." },
  applicability: { label: "Set applicable / not applicable", hint: "Decide whether a control applies to the client." },
  due_dates: { label: "Set due dates", hint: "Set or clear when a control's evidence is due." },
  requirements: { label: "Change evidence requirements", hint: "Change what evidence a control asks for." },
  assign_controls: { label: "Assign controls", hint: "Hand a control to one of the client's people." },
  manage_people: { label: "Invite and manage people", hint: "Invite, switch off or switch on people, and change their access." },
  comment: { label: "Comment", hint: "Add comments to a control." },
  close_cycle: { label: "Close and reopen audit cycles", hint: "Make a whole audit cycle read-only, or open it again." },
  upload: { label: "Upload and submit evidence", hint: "Add evidence files and submit a control for review." },
};

export const isBaseRole = (r: string): r is BaseRole => (BASE_ROLES as readonly string[]).includes(r);

export interface CustomRole {
  id: string;
  name: string;
  description: string | null;
  baseRole: BaseRole;
  /** The abilities taken away from the base role. */
  denied: Permission[];
  /** How many people have this role (people the caller can see). */
  memberCount: number;
}

export interface RoleCatalog {
  permissions: Array<{ key: Permission; label: string; hint: string }>;
  /** What each base role can do before anything is taken away. */
  baseRoles: Array<{ role: BaseRole; side: "firm" | "client"; allowed: Permission[] }>;
}

export function roleCatalog(): RoleCatalog {
  return {
    permissions: PERMISSIONS.map((key) => ({ key, ...PERMISSION_INFO[key] })),
    baseRoles: BASE_ROLES.map((role) => ({ role, side: role === "lead_auditor" || role === "auditor" ? "firm" : "client", allowed: [...BASE_ROLE_PERMISSIONS[role]] })),
  };
}

export interface RoleInput { name: string; description?: string | null; baseRole: string; denied: string[] }

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AppError) throw e;
    const err = e as { code?: string; constraint?: string };
    if (err?.code === "23505" && err.constraint === "custom_roles_name_uq") {
      throw new AppError("A custom role with that name already exists.", 409, "DUPLICATE_ROLE_NAME");
    }
    throw mapDbError(e);
  }
}

/** Only the organisation admin changes roles. The database enforces it too; this gives the same answer whatever the role. */
async function requireAdmin(c: { query: (q: string) => Promise<{ rows: Array<{ r: string | null }> }> }) {
  if ((await c.query("SELECT app_role() AS r")).rows[0].r !== "org_admin") throw new AppError("You don't have access to do that.", 403, "FORBIDDEN");
}

/** Plain-language checks, so the person is told what is wrong; the database's own checks are the backstop. */
function checkDenied(baseRole: BaseRole, denied: string[]): Permission[] {
  const unique = [...new Set(denied)];
  for (const d of unique) {
    if (!(PERMISSIONS as readonly string[]).includes(d)) throw new AppError(`"${d}" is not something a role can be restricted from.`, 400, "VALIDATION");
    if (!BASE_ROLE_PERMISSIONS[baseRole].includes(d as Permission)) {
      const roleName = baseRole.replace("_", " ");
      throw new AppError(`${/^[aeiou]/.test(roleName) ? "An" : "A"} ${roleName} doesn't have "${PERMISSION_INFO[d as Permission].label}" to begin with, so it can't be taken away.`, 400, "VALIDATION");
    }
  }
  return unique as Permission[];
}

const SELECT_ROLES = `SELECT cr.id, cr.name, cr.description, cr.base_role, cr.denied,
                             (SELECT count(*)::int FROM users u WHERE u.custom_role_id = cr.id) AS member_count
                      FROM custom_roles cr`;
const toRole = (row: Record<string, unknown>): CustomRole => ({
  id: row.id as string, name: row.name as string, description: (row.description as string | null) ?? null,
  baseRole: row.base_role as BaseRole, denied: (row.denied as Permission[]).slice().sort((a, b) => PERMISSIONS.indexOf(a) - PERMISSIONS.indexOf(b)),
  memberCount: row.member_count as number,
});

/** The firm's custom roles. Anyone on the firm's side can read them (a lead auditor needs them to invite a client's
 *  people); people on the client's side are told there are none. */
export async function listRoles(pool: Pool, userId: string): Promise<{ custom: CustomRole[]; catalog: RoleCatalog }> {
  return withUser(pool, userId, (c) => run(async () => {
    const r = await c.query(`${SELECT_ROLES} ORDER BY lower(cr.name)`);
    return { custom: r.rows.map(toRole), catalog: roleCatalog() };
  }));
}

export async function createRole(pool: Pool, userId: string, input: RoleInput): Promise<CustomRole> {
  if (!isBaseRole(input.baseRole)) throw new AppError("A custom role can only be based on a lead auditor, auditor, client lead or contributor.", 400, "VALIDATION");
  const denied = checkDenied(input.baseRole, input.denied);
  return withUser(pool, userId, (c) => run(async () => {
    const r = await c.query(
      `INSERT INTO custom_roles (org_id, name, description, base_role, denied)
       SELECT org_id, btrim($2), NULLIF(btrim($3), ''), $4, $5::text[] FROM users WHERE id = $1 RETURNING id, org_id`,
      [userId, input.name, input.description ?? null, input.baseRole, denied],
    );
    if (r.rowCount === 0) throw new AppError("Could not resolve your organisation.", 403, "FORBIDDEN");
    const { id, org_id } = r.rows[0];
    await logAudit(c, { orgId: org_id, actorId: userId, action: "role.created", entity: "custom_role", entityId: id, change: { name: input.name, baseRole: input.baseRole, denied } });
    return toRole((await c.query(`${SELECT_ROLES} WHERE cr.id = $1`, [id])).rows[0]);
  }));
}

/** Renames a role or changes what is taken away from it. Takes effect at once for everyone who has it. The base role
 *  and the organisation never change. */
export async function updateRole(pool: Pool, userId: string, roleId: string, patch: { name?: string; description?: string | null; denied?: string[] }): Promise<CustomRole> {
  return withUser(pool, userId, (c) => run(async () => {
    await requireAdmin(c);
    const cur = await c.query("SELECT org_id, base_role FROM custom_roles WHERE id = $1", [roleId]);
    if (cur.rowCount === 0) throw new AppError("That role was not found.", 404, "NOT_FOUND");
    const denied = patch.denied === undefined ? undefined : checkDenied(cur.rows[0].base_role as BaseRole, patch.denied);
    const r = await c.query(
      `UPDATE custom_roles SET name = COALESCE(btrim($2), name),
                               description = CASE WHEN $3::boolean THEN NULLIF(btrim($4), '') ELSE description END,
                               denied = COALESCE($5::text[], denied)
       WHERE id = $1 RETURNING id`,
      [roleId, patch.name ?? null, patch.description !== undefined, patch.description ?? null, denied ?? null],
    );
    if (r.rowCount === 0) throw new AppError("You don't have access to do that.", 403, "FORBIDDEN"); // visible, but not the organisation admin
    await logAudit(c, { orgId: cur.rows[0].org_id, actorId: userId, action: "role.updated", entity: "custom_role", entityId: roleId,
      change: { ...(patch.name !== undefined ? { name: patch.name } : {}), ...(denied ? { denied } : {}), ...(patch.description !== undefined ? { description: patch.description } : {}) } });
    return toRole((await c.query(`${SELECT_ROLES} WHERE cr.id = $1`, [roleId])).rows[0]);
  }));
}

export async function deleteRole(pool: Pool, userId: string, roleId: string): Promise<{ deleted: true }> {
  return withUser(pool, userId, (c) => run(async () => {
    await requireAdmin(c); // before anything else about the role, so nobody else is told how many people have it
    const cur = await c.query("SELECT org_id, name, (SELECT count(*)::int FROM users u WHERE u.custom_role_id = custom_roles.id) AS n FROM custom_roles WHERE id = $1", [roleId]);
    if (cur.rowCount === 0) throw new AppError("That role was not found.", 404, "NOT_FOUND");
    if (cur.rows[0].n > 0) {
      throw new AppError(`${cur.rows[0].n} ${cur.rows[0].n === 1 ? "person has" : "people have"} this role. Give ${cur.rows[0].n === 1 ? "them" : "those people"} a different role first.`, 409, "ROLE_IN_USE");
    }
    const r = await c.query("DELETE FROM custom_roles WHERE id = $1", [roleId]);
    if (r.rowCount === 0) throw new AppError("You don't have access to do that.", 403, "FORBIDDEN");
    await logAudit(c, { orgId: cur.rows[0].org_id, actorId: userId, action: "role.deleted", entity: "custom_role", entityId: roleId, change: { name: cur.rows[0].name } });
    return { deleted: true as const };
  }));
}

export interface Access {
  role: string;
  customRole: { id: string; name: string } | null;
  /** Abilities taken away from this person by their custom role. The web app uses it to hide what they can't do;
   *  the database is what actually stops them. */
  denied: Permission[];
}

/** What the person asking is allowed to do, in addition to their built-in role. */
export async function getAccess(pool: Pool, userId: string): Promise<Access> {
  return withUser(pool, userId, async (c) => {
    const r = await c.query("SELECT out_role, out_custom_role_id, out_custom_role_name, out_denied FROM app_access()");
    if (r.rowCount === 0) throw new AppError("Your account is not active.", 403, "FORBIDDEN");
    const row = r.rows[0];
    return {
      role: row.out_role,
      customRole: row.out_custom_role_id ? { id: row.out_custom_role_id, name: row.out_custom_role_name } : null,
      denied: row.out_denied as Permission[],
    };
  });
}
