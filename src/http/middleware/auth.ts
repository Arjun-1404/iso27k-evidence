import type { Request, Response, NextFunction } from "express";
import type { TokenVerifier } from "../../auth/types.ts";

declare module "express-serve-static-core" {
  interface Request {
    userId?: string;
  }
}

export function authMiddleware(verifier: TokenVerifier) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("authorization") ?? "";
    const match = header.match(/^Bearer (.+)$/);
    if (!match) return res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Missing or malformed Authorization header." } });
    const session = await verifier.verify(match[1]);
    if (!session) return res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Invalid or expired session." } });
    req.userId = session.userId;
    next();
  };
}
