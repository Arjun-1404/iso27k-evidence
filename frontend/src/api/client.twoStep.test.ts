import { describe, it, expect } from "vitest";
import { server, http, json, apiError, API_BASE } from "../test/mswServer";
import { ApiClient } from "./client";

const client = new ApiClient({ baseUrl: API_BASE, getToken: async () => "jwt.session" });

function record(method: "get" | "post", path: string, reply: object = { ok: true }) {
  const seen: { body: unknown; auth: string | null }[] = [];
  server.use(http[method](`${API_BASE}${path}`, async ({ request }) => {
    seen.push({ body: method === "post" ? await request.json().catch(() => null) : null, auth: request.headers.get("authorization") });
    return json(reply);
  }));
  return seen;
}

describe("ApiClient: two-step sign-in", () => {
  it("reads the status", async () => {
    const seen = record("get", "/auth/mfa", { enabled: true, recoveryRemaining: 7, available: true, required: false });
    expect(await client.getMfaStatus()).toEqual({ enabled: true, recoveryRemaining: 7, available: true, required: false });
    expect(seen[0].auth).toBe("Bearer jwt.session");
  });

  it("starting sends just the password", async () => {
    const seen = record("post", "/auth/mfa/enroll", { secret: "S", otpauthUri: "otpauth://x" });
    expect(await client.startMfaEnrollment("pw-1")).toEqual({ secret: "S", otpauthUri: "otpauth://x" });
    expect(seen[0].body).toEqual({ password: "pw-1" });
  });

  it("confirming sends just the code and returns the recovery codes", async () => {
    const seen = record("post", "/auth/mfa/enroll/confirm", { recoveryCodes: ["A", "B"] });
    expect(await client.confirmMfaEnrollment("123456")).toEqual({ recoveryCodes: ["A", "B"] });
    expect(seen[0].body).toEqual({ code: "123456" });
  });

  it("turning off and new recovery codes send the password and the code", async () => {
    const off = record("post", "/auth/mfa/disable");
    await client.disableMfa("pw-1", "123456");
    expect(off[0].body).toEqual({ password: "pw-1", code: "123456" });
    const fresh = record("post", "/auth/mfa/recovery-codes", { recoveryCodes: ["C"] });
    expect(await client.regenerateRecoveryCodes("pw-1", "ABCD-EFGH-IJKL-MNOP")).toEqual({ recoveryCodes: ["C"] });
    expect(fresh[0].body).toEqual({ password: "pw-1", code: "ABCD-EFGH-IJKL-MNOP" });
  });

  it("an admin reset goes to the person's own address", async () => {
    const seen = record("post", "/users/u-123/reset-mfa", { reset: true });
    expect(await client.resetUserMfa("u-123")).toEqual({ reset: true });
    expect(seen).toHaveLength(1);
  });

  it("a wrong password or code (403) is an error with the server's words — and does not sign the person out", async () => {
    let signedOut = 0;
    const c = new ApiClient({ baseUrl: API_BASE, getToken: async () => "jwt.session", onUnauthorized: () => { signedOut++; } });
    server.use(http.post(`${API_BASE}/auth/mfa/disable`, () => apiError(403, "INVALID_CODE", "That code isn't right.")));
    await expect(c.disableMfa("pw", "000000")).rejects.toMatchObject({ status: 403, code: "INVALID_CODE", message: "That code isn't right." });
    expect(signedOut).toBe(0);
  });
});
