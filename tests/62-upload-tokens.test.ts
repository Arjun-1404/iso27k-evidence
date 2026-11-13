import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { signUploadToken, verifyUploadToken } from "../src/storage/uploadTokens.ts";
import { JwtTokenVerifier } from "../src/auth/jwt.ts";
import type { UploadTarget } from "../src/storage/types.ts";

/**
 * The upload link is the only thing standing between the open internet and "write a file into an organisation's evidence
 * folder", so every way of altering, reusing or forging one has to fail.
 */
const SECRET = "a-long-enough-server-secret-for-tests-0123456789";
const target: UploadTarget = { providerFileId: "Client/Audit [1a2b3c4d]/A.8.5/report.pdf", folderId: "Client/Audit [1a2b3c4d]/A.8.5", fileName: "report.pdf", mimeType: "application/pdf", sizeBytes: 1234 };
const NOW = 1_800_000_000_000;
const make = (over: Partial<{ userId: string; expiresAt: number; target: UploadTarget }> = {}) =>
  signUploadToken(SECRET, { userId: "user-1", target, expiresAt: NOW + 60_000, ...over });

/** Re-signs an altered body with the REAL key, to prove that shape checks (not only the signature) reject nonsense. */
function signedBody(obj: unknown, secret = SECRET): string {
  const key = createHmac("sha256", secret).update("evidence-portal/upload-link/v1").digest();
  const body = Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

describe("upload links", () => {
  it("a link comes back exactly as it was made", () => {
    expect(verifyUploadToken(SECRET, make(), NOW)).toEqual({ userId: "user-1", expiresAt: NOW + 60_000, target });
  });

  it("stops working at the moment it expires, not a second later", () => {
    const t = make();
    expect(verifyUploadToken(SECRET, t, NOW + 59_999)).not.toBeNull();
    expect(verifyUploadToken(SECRET, t, NOW + 60_000)).toBeNull();
    expect(verifyUploadToken(SECRET, t, NOW + 3_600_000)).toBeNull();
  });

  it("a different server secret rejects it", () => {
    expect(verifyUploadToken("another-secret-another-secret-another", make(), NOW)).toBeNull();
  });

  it("changing ANY part of the signed content breaks it (name, size, folder, person, expiry)", () => {
    const [body, sig] = make().split(".");
    const original = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    const edits: Array<(o: any) => void> = [
      (o) => { o.t.fileName = "other.pdf"; },
      (o) => { o.t.sizeBytes = 99; },
      (o) => { o.t.folderId = "Other client/Audit/A.8.5"; },
      (o) => { o.t.providerFileId = "Other client/x.pdf"; },
      (o) => { o.u = "user-2"; },
      (o) => { o.e = NOW + 86_400_000; },
    ];
    for (const edit of edits) {
      const copy = structuredClone(original); edit(copy);
      const forged = `${Buffer.from(JSON.stringify(copy)).toString("base64url")}.${sig}`;
      expect(verifyUploadToken(SECRET, forged, NOW)).toBeNull();
    }
  });

  it("a flipped character anywhere in the signature or the body is rejected", () => {
    const t = make();
    for (let i = 0; i < t.length; i += 7) {
      const flipped = t.slice(0, i) + (t[i] === "A" ? "B" : "A") + t.slice(i + 1);
      if (flipped !== t) expect(verifyUploadToken(SECRET, flipped, NOW), `position ${i}`).toBeNull();
    }
  });

  it("rubbish is refused without an error: empty, one part, three parts, huge, wrong types", () => {
    for (const bad of ["", ".", "abc", "a.b.c", "a.", ".b", "x".repeat(5000), "%%%.%%%", `${make()}.extra`]) {
      expect(verifyUploadToken(SECRET, bad, NOW), bad.slice(0, 20)).toBeNull();
    }
    expect(verifyUploadToken(SECRET, undefined as unknown as string, NOW)).toBeNull();
    expect(verifyUploadToken(SECRET, 42 as unknown as string, NOW)).toBeNull();
  });

  it("even a correctly signed link is refused if its content isn't the expected shape", () => {
    const good = { v: 1, u: "user-1", t: target, e: NOW + 1000 };
    expect(verifyUploadToken(SECRET, signedBody(good), NOW)).not.toBeNull();
    const bad: unknown[] = [
      { ...good, v: 2 }, { ...good, u: 5 }, { ...good, e: "soon" }, { ...good, t: null }, { ...good, t: { ...target, sizeBytes: 0 } },
      { ...good, t: { ...target, sizeBytes: -5 } }, { ...good, t: { ...target, sizeBytes: 1.5 } }, { ...good, t: { ...target, sizeBytes: "10" } },
      { ...good, t: { ...target, fileName: 7 } }, { ...good, t: { ...target, folderId: undefined } }, [], "string", null,
    ];
    for (const b of bad) expect(verifyUploadToken(SECRET, signedBody(b), NOW), JSON.stringify(b).slice(0, 60)).toBeNull();
  });

  it("a signed-in session token can't be passed off as an upload link, nor the other way round", async () => {
    const session = new JwtTokenVerifier(SECRET, async () => true);
    const sessionToken = (session as unknown as { issue?: (id: string) => string }).issue?.("user-1");
    // The session token may not be creatable by this class; the key separation is what matters, so also forge one by hand.
    const plainHmac = (body: string) => createHmac("sha256", SECRET).update(body).digest("base64url");
    const body = Buffer.from(JSON.stringify({ v: 1, u: "user-1", t: target, e: NOW + 1000 })).toString("base64url");
    expect(verifyUploadToken(SECRET, `${body}.${plainHmac(body)}`, NOW)).toBeNull();
    if (sessionToken) expect(verifyUploadToken(SECRET, sessionToken, NOW)).toBeNull();
    expect(await session.verify(make())).toBeNull();
  });
});
