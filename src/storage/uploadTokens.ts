import { createHmac, timingSafeEqual } from "node:crypto";
import type { UploadTarget } from "./types.ts";

/**
 * The link the browser sends a file to, for storages the portal writes to itself (this server's disk, S3).
 *
 * It is a signed, short-lived token that says exactly one thing: "this person may send THIS file (this name, this size)
 * into THIS folder, until this moment". Nothing in it can be changed without breaking the signature, and the signing key
 * is derived from the server's JWT secret under its own label, so a session token can never be passed off as an upload
 * link or the other way round. Possession of the link is the permission — the browser's request carries no sign-in —
 * so it is only ever handed to the person it was made for, over the same connection as their other requests, and it
 * stops working after a quarter of an hour.
 */

const LABEL = "evidence-portal/upload-link/v1";

export interface UploadTokenPayload { userId: string; target: UploadTarget; expiresAt: number }

const key = (secret: string) => createHmac("sha256", secret).update(LABEL).digest();
const sign = (secret: string, body: string) => createHmac("sha256", key(secret)).update(body).digest("base64url");

export function signUploadToken(secret: string, payload: UploadTokenPayload): string {
  const body = Buffer.from(JSON.stringify({ v: 1, u: payload.userId, t: payload.target, e: payload.expiresAt })).toString("base64url");
  return `${body}.${sign(secret, body)}`;
}

/** The payload if the token is genuine and has not expired; otherwise null (the caller must not say which). */
export function verifyUploadToken(secret: string, token: string, now: number = Date.now()): UploadTokenPayload | null {
  if (typeof token !== "string" || token.length > 4096) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1 || token.indexOf(".", dot + 1) !== -1) return null;
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), "base64url");
  const wanted = Buffer.from(sign(secret, body), "base64url");
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { v?: unknown; u?: unknown; t?: Record<string, unknown>; e?: unknown };
    const t = p.t;
    if (p.v !== 1 || typeof p.u !== "string" || typeof p.e !== "number" || !t) return null;
    if (typeof t.providerFileId !== "string" || typeof t.folderId !== "string" || typeof t.fileName !== "string"
        || typeof t.mimeType !== "string" || typeof t.sizeBytes !== "number" || !Number.isInteger(t.sizeBytes) || t.sizeBytes <= 0) return null;
    if (p.e <= now) return null;
    return { userId: p.u, expiresAt: p.e, target: { providerFileId: t.providerFileId, folderId: t.folderId, fileName: t.fileName, mimeType: t.mimeType, sizeBytes: t.sizeBytes } };
  } catch {
    return null;
  }
}
