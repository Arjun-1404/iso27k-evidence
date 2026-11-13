import { describe, it, expect, beforeEach } from "vitest";
import { server, http, json, apiError, API_BASE } from "../test/mswServer";
import { BuiltInAuthClient } from "./builtInAuthClient";
import { ApiError } from "../api/client";

beforeEach(() => localStorage.clear());

const CHALLENGE = { mfaRequired: true, mfaToken: "challenge.token.1" };
const SESSION = { token: "jwt.session", userId: "u1", role: "lead_auditor", tenantId: null };

/** Records every request to the two sign-in endpoints. */
function wire(over: { login?: () => Response | Promise<Response>; verify?: (body: { mfaToken: string; code: string }) => Response | Promise<Response> } = {}) {
  const calls: Array<{ path: string; body: any }> = [];
  server.use(
    http.post(`${API_BASE}/auth/login`, async ({ request }) => { calls.push({ path: "login", body: await request.json() }); return over.login ? over.login() : json(CHALLENGE); }),
    http.post(`${API_BASE}/auth/mfa/verify`, async ({ request }) => {
      const body = (await request.json()) as { mfaToken: string; code: string };
      calls.push({ path: "verify", body });
      return over.verify ? over.verify(body) : json(SESSION);
    }),
  );
  return calls;
}

describe("BuiltInAuthClient: accounts with two-step sign-in", () => {
  it("the password step reports 'second step needed' and does NOT sign anyone in", async () => {
    wire();
    const client = new BuiltInAuthClient(API_BASE);
    const seen: unknown[] = [];
    client.subscribe((u) => seen.push(u));
    expect(await client.login("priya@harbor.test", "pw-123456789")).toBe("mfa-required");
    expect(client.getUser()).toBeNull();
    expect(await client.getToken()).toBeNull();
    expect(seen).toEqual([]);
    expect(localStorage.length).toBe(0); // nothing written — not the session, not the challenge
  });

  it("a normal account still signs straight in", async () => {
    wire({ login: () => json(SESSION) });
    const client = new BuiltInAuthClient(API_BASE);
    expect(await client.login("priya@harbor.test", "pw-123456789")).toBe("signed-in");
    expect(client.getUser()?.userId).toBe("u1");
  });

  it("the code completes it: sends the challenge with the code, then holds a session like any other sign-in", async () => {
    const calls = wire();
    const client = new BuiltInAuthClient(API_BASE);
    const seen: unknown[] = [];
    client.subscribe((u) => seen.push(u));
    await client.login("priya@harbor.test", "pw-123456789");
    await client.completeMfa("123456");

    expect(calls.find((c) => c.path === "verify")!.body).toEqual({ mfaToken: "challenge.token.1", code: "123456" });
    expect(client.getUser()).toEqual({ userId: "u1", email: "priya@harbor.test", name: "priya@harbor.test", role: "lead_auditor", tenantId: undefined });
    expect(await client.getToken()).toBe("jwt.session");
    expect(seen).toHaveLength(1);
    expect(new BuiltInAuthClient(API_BASE).getUser()?.userId).toBe("u1"); // survives a reload, as before
    expect(localStorage.getItem("evidence-portal-session")).not.toContain("challenge.token.1");
    // the challenge is used up: trying it again needs the password again, and sends nothing
    const verifies = calls.filter((c) => c.path === "verify").length;
    await expect(client.completeMfa("654321")).rejects.toMatchObject({ code: "INVALID_MFA_TOKEN" });
    expect(calls.filter((c) => c.path === "verify")).toHaveLength(verifies);
  });

  it("a wrong code is reported with the server's own words and can be retried with the same sign-in", async () => {
    let attempts = 0;
    wire({ verify: () => (++attempts === 1 ? apiError(401, "INVALID_CODE", "That code isn't right.") : json(SESSION)) });
    const client = new BuiltInAuthClient(API_BASE);
    await client.login("priya@harbor.test", "pw-123456789");
    await expect(client.completeMfa("000000")).rejects.toMatchObject({ message: "That code isn't right.", status: 401, code: "INVALID_CODE" });
    expect(client.getUser()).toBeNull();
    await client.completeMfa("123456"); // no need to type the password again
    expect(client.getUser()?.userId).toBe("u1");
  });

  it("a locked account is reported as such, and also stays retryable later within the same sign-in", async () => {
    wire({ verify: () => apiError(423, "MFA_LOCKED", "Too many incorrect codes.") });
    const client = new BuiltInAuthClient(API_BASE);
    await client.login("priya@harbor.test", "pw-123456789");
    const err = await client.completeMfa("123456").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("MFA_LOCKED");
  });

  it("when the server says the sign-in expired, it is forgotten: the next try needs the password again, with no request sent", async () => {
    const calls = wire({ verify: () => apiError(401, "INVALID_MFA_TOKEN", "Your sign-in has expired. Please enter your password again.") });
    const client = new BuiltInAuthClient(API_BASE);
    await client.login("priya@harbor.test", "pw-123456789");
    await expect(client.completeMfa("123456")).rejects.toMatchObject({ code: "INVALID_MFA_TOKEN" });
    const before = calls.length;
    await expect(client.completeMfa("123456")).rejects.toMatchObject({ code: "INVALID_MFA_TOKEN" });
    expect(calls.length).toBe(before);
  });

  it("with no half-finished sign-in there is nothing to complete (and no request)", async () => {
    const calls = wire();
    const client = new BuiltInAuthClient(API_BASE);
    await expect(client.completeMfa("123456")).rejects.toMatchObject({ status: 401, code: "INVALID_MFA_TOKEN" });
    expect(calls).toEqual([]);
  });

  it("going back forgets the half-finished sign-in", async () => {
    const calls = wire();
    const client = new BuiltInAuthClient(API_BASE);
    await client.login("priya@harbor.test", "pw-123456789");
    client.cancelMfa();
    await expect(client.completeMfa("123456")).rejects.toMatchObject({ code: "INVALID_MFA_TOKEN" });
    expect(calls.filter((c) => c.path === "verify")).toEqual([]);
  });

  it("signing in again replaces the old challenge, and signing out discards it", async () => {
    let n = 0;
    const calls = wire({ login: () => json({ mfaRequired: true, mfaToken: `challenge.${++n}` }) });
    const client = new BuiltInAuthClient(API_BASE);
    await client.login("a@x.test", "pw-123456789");
    await client.login("b@x.test", "pw-123456789");
    await client.completeMfa("123456");
    expect(calls.find((c) => c.path === "verify")!.body.mfaToken).toBe("challenge.2");
    expect(client.getUser()?.email).toBe("b@x.test");

    await client.login("c@x.test", "pw-123456789");
    client.logout();
    await expect(client.completeMfa("123456")).rejects.toMatchObject({ code: "INVALID_MFA_TOKEN" });
  });

  it("a failed password step discards any earlier challenge, so a stale one cannot be completed by accident", async () => {
    const calls = wire();
    const client = new BuiltInAuthClient(API_BASE);
    await client.login("a@x.test", "pw-123456789");
    server.use(http.post(`${API_BASE}/auth/login`, () => apiError(401, "INVALID_CREDENTIALS", "Incorrect email or password.")));
    await expect(client.login("a@x.test", "wrong")).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    await expect(client.completeMfa("123456")).rejects.toMatchObject({ code: "INVALID_MFA_TOKEN" });
    expect(calls.filter((c) => c.path === "verify")).toEqual([]);
  });

  it("a fresh page load never inherits a half-finished sign-in", async () => {
    wire();
    await new BuiltInAuthClient(API_BASE).login("a@x.test", "pw-123456789");
    await expect(new BuiltInAuthClient(API_BASE).completeMfa("123456")).rejects.toMatchObject({ code: "INVALID_MFA_TOKEN" });
  });
});
