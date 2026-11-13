// @vitest-environment node
import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, classifyCode, generateRecoveryCodes, generateTotpSecret, matchTotp, normalizeRecoveryCode, otpauthUri, stepAt, totpAtStep } from "./totp";

// RFC 6238, appendix B (SHA-1). The RFC prints 8 digits; the 6-digit code is the same number's last six digits.
const RFC_SECRET = base32Encode(new TextEncoder().encode("12345678901234567890"));
const RFC_VECTORS: [number, string][] = [
  [59, "287082"], [1111111109, "081804"], [1111111111, "050471"], [1234567890, "005924"], [2000000000, "279037"], [20000000000, "353130"],
];

describe("one-time codes follow the standard, so a real authenticator app agrees with the demo", () => {
  it("base32 of the RFC's key", () => expect(RFC_SECRET).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"));
  it.each(RFC_VECTORS)("at %i seconds the code is %s", async (seconds, expected) => {
    expect(await totpAtStep(RFC_SECRET, stepAt(seconds * 1000))).toBe(expected);
  });
  it("accepts the code for now and one step either side, not two", async () => {
    const now = 1111111109 * 1000;
    const here = stepAt(now);
    for (const off of [-1, 0, 1]) expect(await matchTotp(RFC_SECRET, await totpAtStep(RFC_SECRET, here + off), now)).toBe(here + off);
    for (const off of [-2, 2]) expect(await matchTotp(RFC_SECRET, await totpAtStep(RFC_SECRET, here + off), now)).toBeNull();
  });
  it("refuses anything that is not six digits", async () => {
    for (const bad of ["", "12345", "1234567", "abcdef", "12 345"]) expect(await matchTotp(RFC_SECRET, bad, 0)).toBeNull();
  });
});

describe("base32", () => {
  it("round-trips arbitrary bytes", () => {
    for (const len of [0, 1, 5, 10, 20, 33]) {
      const bytes = crypto.getRandomValues(new Uint8Array(len));
      expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    }
  });
  it("makes secrets an authenticator app accepts: 32 characters of A–Z and 2–7", () => {
    const s = generateTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateTotpSecret()).not.toBe(s);
  });
});

describe("the QR address", () => {
  it("carries the secret, issuer, and account", () => {
    const uri = otpauthUri({ secret: "ABCDEFGHIJKLMNOP", account: "declan.walsh@harbourview.example", issuer: "ISO 27001 evidence portal (demo)" });
    const parsed = new URL(uri);
    expect(parsed.protocol).toBe("otpauth:");
    expect(parsed.host).toBe("totp");
    expect(decodeURIComponent(parsed.pathname)).toBe("/ISO 27001 evidence portal (demo):declan.walsh@harbourview.example");
    expect(parsed.searchParams.get("secret")).toBe("ABCDEFGHIJKLMNOP");
    expect(parsed.searchParams.get("issuer")).toBe("ISO 27001 evidence portal (demo)");
    expect(parsed.searchParams.get("digits")).toBe("6");
    expect(parsed.searchParams.get("period")).toBe("30");
  });
});

describe("recovery codes", () => {
  it("are ten distinct codes that read back correctly however they are typed", () => {
    const codes = generateRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) {
      expect(c).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
      expect(normalizeRecoveryCode(c)).toBe(c.replaceAll("-", ""));
      expect(normalizeRecoveryCode(c.toLowerCase().replaceAll("-", " "))).toBe(c.replaceAll("-", ""));
    }
  });
  it("are told apart from authenticator codes", () => {
    expect(classifyCode("123 456")).toEqual({ kind: "totp", code: "123456" });
    expect(classifyCode("ABCD-EFGH-JKLM-NPQR")).toEqual({ kind: "recovery", code: "ABCDEFGHJKLMNPQR" });
    expect(classifyCode("nonsense")).toBeNull();
    expect(classifyCode("12345")).toBeNull();
  });
});
