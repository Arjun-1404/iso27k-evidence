import { Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import { h, parse } from "./shared.ts";
import * as settings from "../../services/storageSettings.ts";

const chooseSchema = z.object({ provider: z.enum(["google_drive", "local", "s3"]) });

/** Where evidence is kept: what can be chosen, connecting the disk or an S3 service, and choosing. Org admins only (the services check). */
export function storageRouter(deps: AppDeps): Router {
  const r = Router();

  async function capabilities(): Promise<settings.StorageCapabilities> {
    let drive: settings.StorageCapabilities["drive"];
    if (!deps.googleOAuth || !deps.secretStore) {
      drive = { available: false, reason: "The owner of this server has to set up Google access (and SECRET_ENCRYPTION_KEY) first. See Server settings." };
    } else {
      let configured = true;
      try { configured = !!(await deps.settings?.current())?.google.settings || !deps.settings; } catch { configured = true; }
      drive = configured ? { available: true } : { available: false, reason: "The owner of this server has to enter the Google app details under Server settings first." };
    }
    return {
      drive,
      localStorageDir: deps.storageOptions?.localStorageDir,
      secretStore: deps.secretStore,
      policy: { allowPrivate: deps.storageOptions?.allowPrivateAddresses === true },
    };
  }

  r.get("/org/storage-options", h(async (req, res) => {
    res.json(await settings.getStorageOptions(deps.pool, req.userId!, await capabilities()));
  }));

  r.post("/org/storage-connections/local", h(async (req, res) => {
    res.json(await settings.connectLocalStorage(deps.pool, req.userId!, await capabilities()));
  }));

  r.post("/org/storage-connections/s3/test", h(async (req, res) => {
    res.json(await settings.testS3Storage(deps.pool, req.userId!, await capabilities(), req.body));
  }));

  r.put("/org/storage-connections/s3", h(async (req, res) => {
    res.json(await settings.connectS3Storage(deps.pool, req.userId!, await capabilities(), req.body));
  }));

  r.put("/org/storage-provider", h(async (req, res) => {
    res.json(await settings.chooseStorageProvider(deps.pool, req.userId!, parse(chooseSchema, req.body).provider));
  }));

  return r;
}
