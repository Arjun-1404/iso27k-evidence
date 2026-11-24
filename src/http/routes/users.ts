import { Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import { h, parse, pid } from "./shared.ts";
import * as users from "../../services/users.ts";

// A person is given a built-in role, or a custom role (whose base role then becomes their role): one of the two.
const roleOrCustom = (b: { role?: string; customRoleId?: string }) => !!b.role || !!b.customRoleId;
const ROLE_OR_CUSTOM = { message: "Choose a role.", path: ["role"] };
const newAuditorUserSchema = z.object({ email: z.string().email(), fullName: z.string().min(1).max(200).optional(), role: z.enum(users.AUDITOR_ROLES).optional(), customRoleId: z.string().uuid().optional() }).refine(roleOrCustom, ROLE_OR_CUSTOM);
const newTenantUserSchema = z.object({ email: z.string().email(), fullName: z.string().min(1).max(200).optional(), role: z.enum(users.TENANT_ROLES).optional(), customRoleId: z.string().uuid().optional() }).refine(roleOrCustom, ROLE_OR_CUSTOM);
const accessSchema = z.object({ role: z.enum([...users.AUDITOR_ROLES, ...users.TENANT_ROLES]).optional(), customRoleId: z.string().uuid().nullable().optional() })
  .refine((b) => b.role !== undefined || b.customRoleId !== undefined, { message: "Say what to change.", path: ["role"] });

export function usersRouter(deps: AppDeps): Router {
  const r = Router();

  r.get("/users", h(async (req, res) => {
    res.json(await users.listOrgUsers(deps.pool, req.userId!));
  }));

  r.post("/users", h(async (req, res) => {
    const delivery = { email: deps.email, appBaseUrl: deps.appBaseUrl };
    res.status(201).json(await users.inviteAuditorUser(deps.pool, req.userId!, parse(newAuditorUserSchema, req.body), delivery));
  }));

  r.post("/users/:id/disable", h(async (req, res) => {
    res.json(await users.disableUser(deps.pool, req.userId!, pid(req, "id")));
  }));

  r.post("/users/:id/reactivate", h(async (req, res) => {
    res.json(await users.reactivateUser(deps.pool, req.userId!, pid(req, "id")));
  }));

  r.post("/users/:id/resend-invite", h(async (req, res) => {
    const delivery = { email: deps.email, appBaseUrl: deps.appBaseUrl };
    res.json(await users.resendInvite(deps.pool, req.userId!, pid(req, "id"), delivery));
  }));

  r.patch("/users/:id/access", h(async (req, res) => {
    res.json(await users.setUserAccess(deps.pool, req.userId!, pid(req, "id"), parse(accessSchema, req.body)));
  }));

  r.get("/tenants/:id/users", h(async (req, res) => {
    res.json(await users.listTenantUsers(deps.pool, req.userId!, pid(req, "id")));
  }));

  r.post("/tenants/:id/users", h(async (req, res) => {
    const delivery = { email: deps.email, appBaseUrl: deps.appBaseUrl };
    res.status(201).json(await users.inviteTenantUser(deps.pool, req.userId!, pid(req, "id"), parse(newTenantUserSchema, req.body), delivery));
  }));

  r.get("/tenants/:id/auditors", h(async (req, res) => {
    res.json(await users.listTenantAuditors(deps.pool, req.userId!, pid(req, "id")));
  }));

  r.put("/tenants/:id/auditors/:userId", h(async (req, res) => {
    res.json(await users.assignAuditorToTenant(deps.pool, req.userId!, pid(req, "userId"), pid(req, "id")));
  }));

  r.delete("/tenants/:id/auditors/:userId", h(async (req, res) => {
    res.json(await users.unassignAuditorFromTenant(deps.pool, req.userId!, pid(req, "userId"), pid(req, "id")));
  }));

  return r;
}
