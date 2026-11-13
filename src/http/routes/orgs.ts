import { Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import { h, parse, pid, storageFor } from "./shared.ts";
import * as orgs from "../../services/orgs.ts";
import { createTenantStorageRoot } from "../../services/tenantStorage.ts";

const domainList = z.array(z.string().min(1).max(253)).min(1);
const newTenantSchema = z.object({ name: z.string().min(1).max(200), allowedDomains: domainList, exceptionEmails: z.array(z.string().email()).optional() });
const storageRootSchema = z.object({ storageRootId: z.string().min(1) });
const orgSettingsSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  storageProvider: z.enum(["google_drive", "sharepoint"]).optional(),
  allowedDomains: domainList.optional(),
  exceptionEmails: z.array(z.string().email()).optional(),
});
const storageConnectionSchema = z.object({
  provider: z.enum(["google_drive", "sharepoint"]),
  accountLabel: z.string().min(1).max(200).optional(),
  tokenRef: z.string().min(1),
  scopes: z.array(z.string()).optional(),
});

export function orgsRouter(deps: AppDeps): Router {
  const r = Router();

  r.get("/tenants", h(async (req, res) => {
    res.json(await orgs.listTenants(deps.pool, req.userId!));
  }));

  r.post("/tenants", h(async (req, res) => {
    res.status(201).json(await orgs.createTenant(deps.pool, req.userId!, parse(newTenantSchema, req.body)));
  }));

  r.post("/tenants/:id/archive", h(async (req, res) => {
    res.json(await orgs.archiveTenant(deps.pool, req.userId!, pid(req, "id")));
  }));

  r.post("/tenants/:id/reactivate", h(async (req, res) => {
    res.json(await orgs.reactivateTenant(deps.pool, req.userId!, pid(req, "id")));
  }));

  r.patch("/tenants/:id/storage-root", h(async (req, res) => {
    const b = parse(storageRootSchema, req.body);
    res.json(await orgs.setTenantStorageRoot(deps.pool, req.userId!, pid(req, "id"), b.storageRootId));
  }));

  r.post("/tenants/:id/storage-root/create", h(async (req, res) => {
    res.status(201).json(await createTenantStorageRoot(deps.pool, req.userId!, storageFor(deps, req.userId!), pid(req, "id")));
  }));

  r.patch("/org", h(async (req, res) => {
    res.json(await orgs.updateOrgSettings(deps.pool, req.userId!, parse(orgSettingsSchema, req.body)));
  }));

  r.get("/org/storage-connections", h(async (req, res) => {
    res.json(await orgs.listStorageConnections(deps.pool, req.userId!));
  }));

  r.put("/org/storage-connections", h(async (req, res) => {
    res.json(await orgs.connectStorage(deps.pool, req.userId!, parse(storageConnectionSchema, req.body)));
  }));

  return r;
}
