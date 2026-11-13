import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import { createHmac } from "node:crypto";
import {
  base32Encode, base32Decode, generateTotpSecret, totpAtStep, stepAt, matchTotp, otpauthUri,
  generateRecoveryCodes, normalizeRecoveryCode, hashRecoveryCode, classifyCode, TOTP_PERIOD_SECONDS,
} from "../src/auth/totp.ts";
import { signMfaToken, verifyMfaToken } from "../src/auth/mfaToken.ts";
import { signSessionToken, JwtTokenVerifier } from "../src/auth/jwt.ts";

// RFC 6238, appendix B: the SHA-1 test secret is the ASCII string "12345678901234567890". The RFC lists 8-digit
// codes; the 6-digit codes authenticator apps show are the last six of those.
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));
const RFC_VECTORS: Array<[number, string]> = [
  [59, "287082"], [1111111109, "081804"], [1111111111, "050471"],
  [1234567890, "005924"], [2000000000, "279037"], [20000000000, "353130"],
];

describe("base32", () => {
  it("matches the RFC 4648 test vectors", () => {
    const v: Array<[string, string]> = [["", ""], ["f", "MY"], ["fo", "MZXQ"], ["foo", "MZXW6"], ["foob", "MZXW6YQ"], ["fooba", "MZXW6YTB"], ["foobar", "MZXW6YTBOI"]];
    for (const [plain, enc] of v) { expect(base32Encode(Buffer.from(plain))).toBe(enc); expect(base32Decode(enc).toString()).toBe(plain); }
  });
  it("decodes the way people copy secrets: any case, with spaces, dashes or padding", () => {
    expect(base32Decode("mzxw 6ytb-oi==").toString()).toBe("foobar");
  });
  it("rejects characters that are not base32", () => {
    expect(() => base32Decode("MZXW1")).toThrow(); // 1 is not in the alphabet
    expect(() => base32Decode("MZXW!")).toThrow();
  });
  it("round-trips random bytes", () => {
    for (let n = 0; n < 40; n++) { const b = Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + n * 11) & 255)); expect(base32Decode(base32Encode(b)).equals(b)).toBe(true); }
  });
});

describe("TOTP (RFC 6238)", () => {
  it.each(RFC_VECTORS)("produces the RFC's code at unix time %i", (t, code) => {
    expect(totpAtStep(RFC_SECRET, Math.floor(t / TOTP_PERIOD_SECONDS))).toBe(code);
  });

  it("generates secrets that are 160 random bits (32 base32 characters) and never repeat", () => {
    const a = generateTotpSecret(), b = generateTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(a).not.toBe(b);
    expect(base32Decode(a)).toHaveLength(20);
  });

  it("the step number is the unix time divided into 30-second periods", () => {
    expect(stepAt(0)).toBe(0); expect(stepAt(29_999)).toBe(0); expect(stepAt(30_000)).toBe(1); expect(stepAt(59_000)).toBe(1); expect(stepAt(60_000)).toBe(2);
    expect(stepAt(1_700_000_015_000)).toBe(56_666_667);
  });

  it("accepts the current code and returns its step", () => {
    const now = 1_700_000_015_000; const step = stepAt(now);
    expect(matchTotp(RFC_SECRET, totpAtStep(RFC_SECRET, step), now)).toBe(step);
  });

  it("forgives a phone clock one step slow or fast — and reports which step it was", () => {
    const now = 1_700_000_015_000; const step = stepAt(now);
    expect(matchTotp(RFC_SECRET, totpAtStep(RFC_SECRET, step - 1), now)).toBe(step - 1);
    expect(matchTotp(RFC_SECRET, totpAtStep(RFC_SECRET, step + 1), now)).toBe(step + 1);
  });

  it("refuses codes two or more steps away, and wrong codes", () => {
    const now = 1_700_000_015_000; const step = stepAt(now);
    expect(matchTotp(RFC_SECRET, totpAtStep(RFC_SECRET, step - 2), now)).toBeNull();
    expect(matchTotp(RFC_SECRET, totpAtStep(RFC_SECRET, step + 2), now)).toBeNull();
    const right = totpAtStep(RFC_SECRET, step);
    const wrong = right === "000000" ? "000001" : "000000";
    expect(matchTotp(RFC_SECRET, wrong, now)).toBeNull();
  });

  it("refuses anything that isn't exactly six digits", () => {
    const now = 1_700_000_015_000; const code = totpAtStep(RFC_SECRET, stepAt(now));
    for (const bad of ["", code + "0", code.slice(1), "abcdef", ` ${code}`, `${code} `, "12 34 56"]) expect(matchTotp(RFC_SECRET, bad, now), bad).toBeNull();
  });

  it("a code for one secret doesn't work for another", () => {
    const now = 1_700_000_015_000; const other = generateTotpSecret();
    expect(matchTotp(other, totpAtStep(RFC_SECRET, stepAt(now)), now)).toBeNull();
  });

  it("leading zeros are kept (a code like 005924 must not become 5924)", () => {
    expect(totpAtStep(RFC_SECRET, Math.floor(1234567890 / 30))).toBe("005924");
  });

  it("builds the address an authenticator app reads, with everything it needs and nothing unescaped", () => {
    const uri = otpauthUri({ secret: "JBSWY3DPEHPK3PXP", account: "priya+audit@harbor.test", issuer: "Evidence Portal" });
    const u = new URL(uri);
    expect(u.protocol).toBe("otpauth:"); expect(u.host).toBe("totp");
    expect(decodeURIComponent(u.pathname)).toBe("/Evidence Portal:priya+audit@harbor.test");
    expect(u.searchParams.get("secret")).toBe("JBSWY3DPEHPK3PXP");
    expect(u.searchParams.get("issuer")).toBe("Evidence Portal");
    expect(u.searchParams.get("algorithm")).toBe("SHA1");
    expect(u.searchParams.get("digits")).toBe("6");
    expect(u.searchParams.get("period")).toBe("30");
    expect(uri).not.toContain(" "); // spaces are escaped
  });
});

describe("recovery codes", () => {
  it("come in tens, as XXXX-XXXX-XXXX-XXXX, all different, 80 bits each", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    for (const c of codes) expect(c).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
    expect(new Set(codes).size).toBe(10);
    expect(generateRecoveryCodes(3)).toHaveLength(3);
  });

  it("are recognised however they are typed back: lower case, spaces, no dashes", () => {
    const [c] = generateRecoveryCodes(1);
    const canon = normalizeRecoveryCode(c)!;
    expect(canon).toMatch(/^[A-Z2-7]{16}$/);
    expect(normalizeRecoveryCode(c.toLowerCase())).toBe(canon);
    expect(normalizeRecoveryCode(c.replace(/-/g, " "))).toBe(canon);
    expect(normalizeRecoveryCode(c.replace(/-/g, ""))).toBe(canon);
  });

  it("anything that isn't one is rejected", () => {
    for (const bad of ["", "123456", "ABCD-EFGH", "ABCD-EFGH-IJKL-MNO1", "ABCDEFGHIJKLMNOP1", "!!!!-!!!!-!!!!-!!!!"]) expect(normalizeRecoveryCode(bad), bad).toBeNull();
  });

  it("are stored only as a hash that depends on the account as well as the code", () => {
    const canon = normalizeRecoveryCode(generateRecoveryCodes(1)[0])!;
    const h1 = hashRecoveryCode("user-1", canon);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).not.toContain(canon);
    expect(hashRecoveryCode("user-1", canon)).toBe(h1);
    expect(hashRecoveryCode("user-2", canon)).not.toBe(h1);
  });

  it("classifyCode tells an authenticator code from a recovery code, and ignores spaces and dashes", () => {
    expect(classifyCode("123456")).toEqual({ kind: "totp", code: "123456" });
    expect(classifyCode("123 456")).toEqual({ kind: "totp", code: "123456" });
    expect(classifyCode("123-456")).toEqual({ kind: "totp", code: "123456" });
    const [rc] = generateRecoveryCodes(1);
    expect(classifyCode(rc.toLowerCase())).toEqual({ kind: "recovery", code: normalizeRecoveryCode(rc) });
    for (const bad of ["", "12345", "1234567", "hello", "ABCD-EFGH"]) expect(classifyCode(bad), bad).toBeNull();
  });
});

describe("the sign-in challenge token", () => {
  const SECRET = "challenge-test-secret-long-enough-xyz";

  it("carries the user id, and verifies", () => {
    expect(verifyMfaToken(signMfaToken("user-1", SECRET), SECRET)).toBe("user-1");
  });

  it("is refused after it expires, under another secret, when altered, or when it isn't a token at all", () => {
    expect(verifyMfaToken(signMfaToken("user-1", SECRET, -1), SECRET)).toBeNull();
    expect(verifyMfaToken(signMfaToken("user-1", SECRET), "some-other-secret-entirely-xyz")).toBeNull();
    const t = signMfaToken("user-1", SECRET);
    expect(verifyMfaToken(t.slice(0, -3) + (t.endsWith("AAA") ? "BBB" : "AAA"), SECRET)).toBeNull();
    expect(verifyMfaToken("garbage", SECRET)).toBeNull();
  });

  it("lives five minutes by default", () => {
    const { exp, iat } = jwt.decode(signMfaToken("u", SECRET)) as { exp: number; iat: number };
    expect(exp - iat).toBe(300);
  });

  it("a SESSION token is not accepted as a challenge token", () => {
    expect(verifyMfaToken(signSessionToken("user-1", SECRET), SECRET)).toBeNull();
  });

  it("a CHALLENGE token is not accepted as a session — it can never be used as a bearer token", async () => {
    const challenge = signMfaToken("user-1", SECRET);
    expect(await new JwtTokenVerifier(SECRET).verify(challenge)).toBeNull();
    expect(await new JwtTokenVerifier(SECRET, async () => true).verify(challenge)).toBeNull();
  });

  // The three things keeping the two kinds of token apart are each tested on their own: a token that gets two of
  // the three right and one wrong must still be refused, so no single one of them is quietly doing all the work.
  const derivedKey = (secret: string) => createHmac("sha256", secret).update("evidence-portal:mfa-challenge:v1").digest();

  it("a perfect-looking challenge signed with the plain session secret is refused (the signing key keeps them apart)", () => {
    const forged = jwt.sign({ sub: "user-1", typ: "mfa" }, SECRET, { issuer: "evidence-portal-mfa", expiresIn: 300 });
    expect(verifyMfaToken(forged, SECRET)).toBeNull();
  });

  it("the right key and claims but the session issuer is refused (the issuer keeps them apart)", () => {
    const forged = jwt.sign({ sub: "user-1", typ: "mfa" }, derivedKey(SECRET), { issuer: "evidence-portal", expiresIn: 300 });
    expect(verifyMfaToken(forged, SECRET)).toBeNull();
  });

  it("the right key and issuer but no `typ: mfa` claim is refused (the claim keeps them apart)", () => {
    for (const claims of [{ sub: "user-1" }, { sub: "user-1", typ: "session" }]) {
      const forged = jwt.sign(claims, derivedKey(SECRET), { issuer: "evidence-portal-mfa", expiresIn: 300 });
      expect(verifyMfaToken(forged, SECRET)).toBeNull();
    }
    // and the genuine article, built the same way, passes — so the refusals above are about the claim and nothing else
    const genuine = jwt.sign({ sub: "user-1", typ: "mfa" }, derivedKey(SECRET), { issuer: "evidence-portal-mfa", expiresIn: 300 });
    expect(verifyMfaToken(genuine, SECRET)).toBe("user-1");
  });

  it("a challenge never works as a session even if it were signed with the plain secret (the session check insists on its own issuer)", async () => {
    const forged = jwt.sign({ sub: "user-1", typ: "mfa" }, SECRET, { issuer: "evidence-portal-mfa", expiresIn: 300 });
    expect(await new JwtTokenVerifier(SECRET).verify(forged)).toBeNull();
  });

  it("a token without a subject is refused", () => {
    const forged = jwt.sign({ typ: "mfa" }, derivedKey(SECRET), { issuer: "evidence-portal-mfa", expiresIn: 300 });
    expect(verifyMfaToken(forged, SECRET)).toBeNull();
  });
});
