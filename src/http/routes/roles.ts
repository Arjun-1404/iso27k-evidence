import { Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import { h, parse, pid } from "./shared.ts";
import * as roles from "../../services/roles.ts";

const name = z.string().trim().min(1).max(60);
const description = z.string().max(500).nullable();
const newRoleSchema = z.object({ name, description: description.optional(), baseRole: z.enum(roles.BASE_ROLES), denied: z.array(z.enum(roles.PERMISSIONS)).max(20) });
// The base role never changes after a role is made; only its name, description and what is taken away.
const roleChangeSchema = z.object({ name: name.optional(), description: description.optional(), denied: z.array(z.enum(roles.PERMISSIONS)).max(20).optional() });

export function rolesRouter(deps: AppDeps): Router {
  const r = Router();

  /** What the signed-in person's custom role (if any) takes away from them. The web app hides what they can't do. */
  r.get("/me/access", h(async (req, res) => {
    res.json(await roles.getAccess(deps.pool, req.userId!));
  }));

  r.get("/roles", h(async (req, res) => {
    res.json(await roles.listRoles(deps.pool, req.userId!));
  }));

  r.post("/roles", h(async (req, res) => {
    res.status(201).json(await roles.createRole(deps.pool, req.userId!, parse(newRoleSchema, req.body)));
  }));

  r.patch("/roles/:id", h(async (req, res) => {
    res.json(await roles.updateRole(deps.pool, req.userId!, pid(req, "id"), parse(roleChangeSchema, req.body)));
  }));

  r.delete("/roles/:id", h(async (req, res) => {
    res.json(await roles.deleteRole(deps.pool, req.userId!, pid(req, "id")));
  }));

  return r;
}
