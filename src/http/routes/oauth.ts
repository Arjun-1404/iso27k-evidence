import { Router } from "express";
import { z } from "zod";
import type { AppDeps } from "../app.ts";
import { h } from "./shared.ts";
import { AppError } from "../../errors.ts";
import { startGoogleDriveConnect, completeGoogleDriveConnect } from "../../services/driveConnect.ts";

const callbackSchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().optional(),
});

function notConfigured(): AppError {
  return new AppError("Google Drive connection is not configured on this server. The owner of this installation can enter the Google app details under Server settings (or set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and GOOGLE_OAUTH_REDIRECT_URI in the server's .env file). SECRET_ENCRYPTION_KEY must be set as well.", 503, "OAUTH_NOT_CONFIGURED");
}

/**
 * googleStartRouter is authenticated (mounted with the rest of the app's authenticated routes).
 * googleCallbackRouter is NOT — it must be mounted in app.ts alongside authRouter, before
 * authMiddleware, since Google redirects the browser here directly with no bearer token at all.
 */
export function googleStartRouter(deps: AppDeps): Router {
  const r = Router();
  r.post("/org/storage-connections/google/start", h(async (req, res) => {
    if (!deps.googleOAuth) throw notConfigured();
    const url = await startGoogleDriveConnect(deps.pool, req.userId!, deps.googleOAuth);
    res.json({ url });
  }));
  return r;
}

export function googleCallbackRouter(deps: AppDeps): Router {
  const r = Router();
  // Deliberately never lets an error reach the generic JSON error middleware: the visitor here is a
  // browser being redirected by Google, not an API client, so every failure — including a malformed
  // query string — ends in a redirect back to the frontend with an ?error= code, never a raw JSON body.
  r.get("/oauth/google/callback", async (req, res) => {
    const settingsUrl = `${deps.appBaseUrl}/settings/integrations`;
    try {
      if (!deps.googleOAuth || !deps.secretStore) return res.redirect(302, `${settingsUrl}?error=not_configured`);

      const q = callbackSchema.safeParse(req.query);
      if (!q.success) return res.redirect(302, `${settingsUrl}?error=invalid_request`);
      if (q.data.error) return res.redirect(302, `${settingsUrl}?error=${encodeURIComponent(q.data.error)}`);
      if (!q.data.code || !q.data.state) return res.redirect(302, `${settingsUrl}?error=missing_code_or_state`);

      const result = await completeGoogleDriveConnect(deps.pool, deps.googleOAuth, deps.secretStore, q.data.state, q.data.code);
      if (!result) return res.redirect(302, `${settingsUrl}?error=invalid_or_expired_state`);
      return res.redirect(302, `${settingsUrl}?connected=google_drive`);
    } catch (e) {
      console.error("Google OAuth callback failed:", e);
      const code = e instanceof AppError ? e.code : "UNKNOWN";
      return res.redirect(302, `${settingsUrl}?error=${encodeURIComponent(code)}`);
    }
  });
  return r;
}
