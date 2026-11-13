import { randomBytes } from "node:crypto";
import { hashInviteToken } from "./inviteToken.ts";

/** A fresh, unguessable password-reset secret (256 random bits) and the hash we store in its place. How long
 *  it lives is decided by the database, not here. */
export function generateResetToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("hex");
  return { token, tokenHash: hashInviteToken(token) };
}

export { hashInviteToken as hashResetToken };
