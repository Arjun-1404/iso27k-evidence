// Custom roles: a built-in role with some abilities taken away, and a name of the firm's own (the real server's
// routes/roles.ts and services/roles.ts, migration 016). Only the organisation admin makes or changes them; the firm's
// staff can read them (a lead auditor needs them to invite a client's people); a client's people are shown none.

import type { BaseRole, CustomRole, Permission } from "../api/types";
import type { DemoBackend, Route } from "./backend";
import { asObject, fail, FORBIDDEN, textField } from "./http";
import { BASE_ROLES, BASE_ROLE_PERMISSIONS, PERMISSIONS, PERMISSION_INFO, isAuditorSide, isBaseRole, roleCatalog } from "./rules";
import { canSeeUser } from "./routesPeople";
import type { DemoCustomRole, DemoUser } from "./state";

const DUPLICATE_NAME = "A custom role with that name already exists.";

/** How many people have this role, among the people the caller can see. */
function toRole(api: DemoBackend, viewer: DemoUser, r: DemoCustomRole): CustomRole {
  return {
    id: r.id, name: r.name, description: r.description, baseRole: r.baseRole,
    denied: [...r.denied].sort((a, b) => PERMISSIONS.indexOf(a) - PERMISSIONS.indexOf(b)),
    memberCount: api.state.users.filter((u) => u.customRoleId === r.id && canSeeUser(api, viewer, u)).length,
  };
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The abilities asked to be taken away: every one must be known, and one the base role has to begin with. */
function permissionList(body: Record<string, unknown>, key: string): Permission[] {
  const v = body[key];
  if (!Array.isArray(v)) fail(400, "VALIDATION", `${key}: Invalid input: expected array, received ${v === undefined ? "undefined" : v === null ? "null" : typeof v}`);
  const list = v as unknown[];
  if (list.length > 20) fail(400, "VALIDATION", `${key}: Too big: expected array to have <=20 items`);
  list.forEach((x, i) => {
    if (typeof x !== "string" || !(PERMISSIONS as readonly string[]).includes(x)) {
      fail(400, "VALIDATION", `${key}.${i}: Invalid option: expected one of ${PERMISSIONS.map((p) => `"${p}"`).join("|")}`);
    }
  });
  return list as Permission[];
}

function checkDenied(baseRole: BaseRole, denied: Permission[]): Permission[] {
  const unique = [...new Set(denied)];
  for (const d of unique) {
    if (!BASE_ROLE_PERMISSIONS[baseRole].includes(d)) {
      const roleName = baseRole.replace("_", " ");
      fail(400, "VALIDATION", `${/^[aeiou]/.test(roleName) ? "An" : "A"} ${roleName} doesn't have "${PERMISSION_INFO[d].label}" to begin with, so it can't be taken away.`);
    }
  }
  return unique.sort((a, b) => PERMISSIONS.indexOf(a) - PERMISSIONS.indexOf(b));
}

/** A name is trimmed, then must be 1 to 60 characters. */
function nameField(b: Record<string, unknown>, optional: boolean): string | undefined {
  if (b.name === undefined && optional) return undefined;
  if (typeof b.name !== "string") return textField(b, "name", { max: 60 }); // the same refusal as for any other missing text
  const name = b.name.trim();
  if (name.length < 1) fail(400, "VALIDATION", "name: Too small: expected string to have >=1 characters");
  if (name.length > 60) fail(400, "VALIDATION", "name: Too big: expected string to have <=60 characters");
  return name;
}

/** The description: absent, null, or up to 500 characters. */
function descriptionField(b: Record<string, unknown>): string | null | undefined {
  if (b.description === undefined || b.description === null) return b.description as undefined | null;
  const d = textField(b, "description", { min: 0, max: 500 });
  return d.trim() === "" ? null : d.trim();
}

function requireAdmin(user: DemoUser): void {
  if (user.role !== "org_admin") FORBIDDEN();
}

export function roleRoutes(): Route[] {
  return [
    {
      // What the signed-in person's custom role (if any) takes away from them. The web app hides what they can't do.
      method: "GET", path: "/me/access",
      handle: ({ api, user }) => {
        const role = user.customRoleId ? api.customRole(user.customRoleId) : undefined;
        return { json: { role: user.role, customRole: role ? { id: role.id, name: role.name } : null, denied: role ? [...role.denied] : [] } };
      },
    },
    {
      method: "GET", path: "/roles",
      handle: ({ api, user }) => ({
        json: {
          custom: (isAuditorSide(user.role) ? [...api.state.customRoles] : []).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())).map((r) => toRole(api, user, r)),
          catalog: roleCatalog(),
        },
      }),
    },
    {
      method: "POST", path: "/roles",
      handle: ({ api, user, req }) => {
        const b = asObject(req.body);
        const name = nameField(b, false)!;
        const description = descriptionField(b);
        const baseRole = typeof b.baseRole === "string" && isBaseRole(b.baseRole) ? b.baseRole
          : fail(400, "VALIDATION", `baseRole: Invalid option: expected one of ${BASE_ROLES.map((r) => `"${r}"`).join("|")}`);
        const denied = checkDenied(baseRole, permissionList(b, "denied"));
        requireAdmin(user);
        if (api.state.customRoles.some((r) => sameName(r.name, name))) fail(409, "DUPLICATE_ROLE_NAME", DUPLICATE_NAME);
        const role: DemoCustomRole = { id: api.newId(), name, description: description ?? null, baseRole, denied };
        api.state.customRoles.push(role);
        api.log(user, "role.created", null, "custom_role", role.id, { name, baseRole, denied });
        return { status: 201, json: toRole(api, user, role) };
      },
    },
    {
      // Renames a role or changes what is taken away from it; the base role never changes. Takes effect at once for everyone who has it.
      method: "PATCH", path: "/roles/:id",
      handle: ({ api, user, params, req }) => {
        const b = asObject(req.body);
        const name = nameField(b, true);
        const description = descriptionField(b);
        const denied = b.denied === undefined ? undefined : permissionList(b, "denied");
        requireAdmin(user); // before anything else about the role, so nobody else is told whether it exists
        const role = api.customRole(params.id) ?? fail(404, "NOT_FOUND", "That role was not found.");
        const checked = denied === undefined ? undefined : checkDenied(role.baseRole, denied);
        if (name !== undefined && api.state.customRoles.some((r) => r.id !== role.id && sameName(r.name, name))) fail(409, "DUPLICATE_ROLE_NAME", DUPLICATE_NAME);
        if (name !== undefined) role.name = name;
        if (description !== undefined) role.description = description;
        if (checked !== undefined) role.denied = checked;
        api.log(user, "role.updated", null, "custom_role", role.id, {
          ...(name !== undefined ? { name } : {}), ...(checked ? { denied: checked } : {}), ...(description !== undefined ? { description } : {}),
        });
        return { json: toRole(api, user, role) };
      },
    },
    {
      method: "DELETE", path: "/roles/:id",
      handle: ({ api, user, params }) => {
        requireAdmin(user);
        const role = api.customRole(params.id) ?? fail(404, "NOT_FOUND", "That role was not found.");
        const n = api.state.users.filter((u) => u.customRoleId === role.id).length;
        if (n > 0) fail(409, "ROLE_IN_USE", `${n} ${n === 1 ? "person has" : "people have"} this role. Give ${n === 1 ? "them" : "those people"} a different role first.`);
        api.state.customRoles.splice(api.state.customRoles.indexOf(role), 1);
        api.log(user, "role.deleted", null, "custom_role", role.id, { name: role.name });
        return { json: { deleted: true } };
      },
    },
  ];
}
