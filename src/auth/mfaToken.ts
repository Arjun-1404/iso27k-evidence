import { createHmac } from "node:crypto";
import jwt from "jsonwebtoken";

/**
 * The short-lived "password accepted, now prove the second step" token handed back by sign-in for an account with
 * two-step sign-in on. It is NOT a session: it can't be used as a bearer token for anything, and a session token
 * can't be used as one of these. Three independent things keep them apart — a different signing key (derived from
 * the session secret, so nothing new to configure), a different issuer, and a `typ` claim.
 */
const ISSUER = "evidence-portal-mfa";
export const MFA_TOKEN_TTL_SECONDS = 5 * 60;

const key = (secret: string) => createHmac("sha256", secret).update("evidence-portal:mfa-challenge:v1").digest();

export function signMfaToken(userId: string, secret: string, ttlSeconds: number = MFA_TOKEN_TTL_SECONDS): string {
  return jwt.sign({ sub: userId, typ: "mfa" }, key(secret), { issuer: ISSUER, expiresIn: ttlSeconds });
}

/** The user id the token was issued for, or null if it is invalid, expired, tampered with or the wrong kind. */
export function verifyMfaToken(token: string, secret: string): string | null {
  try {
    const p = jwt.verify(token, key(secret), { issuer: ISSUER });
    if (typeof p === "string" || p.typ !== "mfa" || typeof p.sub !== "string") return null;
    return p.sub;
  } catch {
    return null;
  }
}
