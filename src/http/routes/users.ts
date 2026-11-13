import { Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import { h, parse, pid } from "./shared.ts";
import * as users from "../../services/users.ts";

const newAuditorUserSchema = z.object({ email: z.string().email(), fullName: z.string().min(1).max(200).optional(), role: z.enum(users.AUDITOR_ROLES) });
const newTenantUserSchema = z.object({ email: z.string().email(), fullName: z.string().min(1).max(200).optional(), role: z.enum(users.TENANT_ROLES) });

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

  r.get("/tenants/:id/users", h(async (req, res) => {
    res.json(await users.listTenantUsers(deps.pool, req.userId!, pid(req, "id")));
  }));

  r.post("/tenants/:id/users", h(async (req, res) => {
    const delivery = { email: deps.email, appBaseUrl: deps.appBaseUrl };
    res.status(201).json(await users.inviteTenantUser(deps.pool, req.userId!, pid(req, "id"), parse(newTenantUserSchema, req.body), delivery));
  }));

  r.put("/tenants/:id/auditors/:userId", h(async (req, res) => {
    res.json(await users.assignAuditorToTenant(deps.pool, req.userId!, pid(req, "userId"), pid(req, "id")));
  }));

  r.delete("/tenants/:id/auditors/:userId", h(async (req, res) => {
    res.json(await users.unassignAuditorFromTenant(deps.pool, req.userId!, pid(req, "userId"), pid(req, "id")));
  }));

  return r;
}
