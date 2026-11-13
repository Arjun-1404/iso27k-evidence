import { Router } from "express";
import type { AppDeps } from "../app.ts";
import { AppError } from "../../errors.ts";
import { pid, storageFor } from "./shared.ts";
import { verifyUploadToken } from "../../storage/uploadTokens.ts";
import { withStorageErrors } from "../../services/storageErrors.ts";

/**
 * Where the browser sends a file when the evidence is kept on this server's disk or in S3 (Google Drive takes uploads
 * straight from the browser and never comes here).
 *
 * There is no sign-in on this request: the link itself, signed by the server when the upload was announced, is the
 * permission. It names one file (name, size, folder), belongs to one person, and stops working after a few minutes. The
 * file is then written for that person's organisation exactly as announced: a body of any other size is refused and
 * nothing is kept. Mounted BEFORE the JSON body reader, so the file's bytes are never read as JSON.
 */
export function uploadsRouter(deps: AppDeps): Router {
  const r = Router();

  r.put("/uploads/:token", async (req, res, next) => {
    try {
      const payload = verifyUploadToken(deps.jwtSecret, pid(req, "token"));
      if (!payload) throw new AppError("This upload link has expired or isn't valid. Choose the file again.", 403, "UPLOAD_LINK_INVALID");

      const declared = req.headers["content-length"];
      if (declared === undefined || !/^\d{1,12}$/.test(declared)) throw new AppError("The upload must say how large the file is.", 411, "LENGTH_REQUIRED");
      if (Number(declared) !== payload.target.sizeBytes) throw new AppError("The file is not the size that was announced for this upload.", 400, "UPLOAD_SIZE_MISMATCH");

      const storage = storageFor(deps, payload.userId);
      await withStorageErrors(() => storage.receiveUpload
        ? storage.receiveUpload(payload.target, req)
        : Promise.reject(new AppError("This storage takes uploads directly from the browser, not through the portal.", 400, "UPLOAD_NOT_THROUGH_PORTAL")));
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  return r;
}
