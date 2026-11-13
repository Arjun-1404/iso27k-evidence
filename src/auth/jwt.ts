import jwt from "jsonwebtoken";
import type { Session, TokenVerifier } from "./types.ts";
import type { SessionCheck } from "./sessionCheck.ts";

const ISSUER = "evidence-portal";

/** `issuedAt` (whole seconds since 1970) is for the one case where a token must be stamped with a moment the database
 *  chose rather than this server's clock: the fresh session handed back after a password change (see
 *  services/account.ts). Left out, the token is stamped with the current time, as always. */
export function signSessionToken(userId: string, secret: string, expiresInSeconds = 60 * 60 * 12, issuedAt?: number): string {
  return jwt.sign(issuedAt === undefined ? { sub: userId } : { sub: userId, iat: issuedAt }, secret, { issuer: ISSUER, expiresIn: expiresInSeconds });
}

/** Verifies this project's own self-signed session tokens (HS256). The signature and expiry are both
 *  checked by the library; an invalid, expired, or tampered token simply yields null, same contract as
 *  every other TokenVerifier.
 *
 *  With a `sessionCheck` (production passes the database's), a token that is cryptographically fine is
 *  still refused if its account has been disabled or had its password reset since the token was issued —
 *  a stolen session does not survive a password reset. Without one, only the signature and expiry count. */
export class JwtTokenVerifier implements TokenVerifier {
  private secret: string;
  private sessionCheck?: SessionCheck;
  constructor(secret: string, sessionCheck?: SessionCheck) {
    this.secret = secret;
    this.sessionCheck = sessionCheck;
  }

  async verify(token: string): Promise<Session | null> {
    let userId: string; let iat: unknown;
    try {
      const payload = jwt.verify(token, this.secret, { issuer: ISSUER });
      if (typeof payload === "string" || typeof payload.sub !== "string") return null;
      userId = payload.sub; iat = payload.iat;
    } catch {
      return null;
    }
    if (this.sessionCheck) {
      if (typeof iat !== "number") return null;
      if (!(await this.sessionCheck(userId, new Date(iat * 1000)))) return null;
    }
    return { userId };
  }
}
