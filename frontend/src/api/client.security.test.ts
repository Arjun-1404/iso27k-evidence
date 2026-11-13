import { describe, it, expect } from "vitest";
import { server, http, json, apiError, API_BASE } from "../test/mswServer";
import { ApiClient } from "./client";

const mk = (over: Partial<ConstructorParameters<typeof ApiClient>[0]> = {}) => new ApiClient({ baseUrl: API_BASE, getToken: async () => "jwt.session", ...over });

function record(method: "get" | "post" | "put", path: string, reply: object = { ok: true }) {
  const seen: { body: unknown; auth: string | null }[] = [];
  server.use(http[method](`${API_BASE}${path}`, async ({ request }) => {
    seen.push({ body: method === "get" ? null : await request.json().catch(() => null), auth: request.headers.get("authorization") });
    return json(reply);
  }));
  return seen;
}

const SESSION = { token: "jwt.fresh", userId: "u1", role: "auditor", tenantId: null };
const POLICY = { policy: "staff", available: true, staff: { total: 3, enrolled: 1 }, everyone: { total: 7, enrolled: 2 } };

describe("ApiClient: changing your password", () => {
  it("sends both passwords, and a code only when there is one", async () => {
    const seen = record("post", "/auth/change-password", SESSION);
    expect(await mk().changePassword("old-pw", "new-pw-1234567")).toEqual(SESSION);
    expect(seen[0].body).toEqual({ currentPassword: "old-pw", newPassword: "new-pw-1234567" });
    expect("code" in (seen[0].body as object)).toBe(false);
    await mk().changePassword("old-pw", "new-pw-1234567", "123456");
    expect(seen[1].body).toEqual({ currentPassword: "old-pw", newPassword: "new-pw-1234567", code: "123456" });
    expect(seen[0].auth).toBe("Bearer jwt.session");
  });

  it("a wrong current password or code (403) comes back in the server's words and does not sign the person out", async () => {
    let signedOut = 0;
    const c = mk({ onUnauthorized: () => { signedOut++; } });
    server.use(http.post(`${API_BASE}/auth/change-password`, () => apiError(403, "INVALID_PASSWORD", "Incorrect password.")));
    await expect(c.changePassword("x", "new-pw-1234567")).rejects.toMatchObject({ status: 403, code: "INVALID_PASSWORD", message: "Incorrect password." });
    expect(signedOut).toBe(0);
  });
});

describe("ApiClient: the organisation's two-step policy", () => {
  it("reads it", async () => {
    const seen = record("get", "/org/mfa-policy", POLICY);
    expect(await mk().getMfaPolicy()).toEqual(POLICY);
    expect(seen[0].auth).toBe("Bearer jwt.session");
  });

  it("sets it, sending only the choice, and returns the new state", async () => {
    const seen = record("put", "/org/mfa-policy", { ...POLICY, policy: "everyone" });
    expect((await mk().setMfaPolicy("everyone")).policy).toBe("everyone");
    expect(seen[0].body).toEqual({ policy: "everyone" });
  });

  it("an admin who hasn't turned it on themselves is told why (409)", async () => {
    server.use(http.put(`${API_BASE}/org/mfa-policy`, () => apiError(409, "MFA_ADMIN_NEEDS_MFA", "Turn on two-step sign-in for your own account first.")));
    await expect(mk().setMfaPolicy("staff")).rejects.toMatchObject({ status: 409, code: "MFA_ADMIN_NEEDS_MFA" });
  });
});

describe("ApiClient: 'set up two-step sign-in first' (the organisation requires it)", () => {
  const blocked = () => server.use(http.get(`${API_BASE}/tenants`, () => apiError(403, "MFA_SETUP_REQUIRED", "Your organisation requires two-step sign-in.")));

  it("tells the app, once per refused request, and still reports the error", async () => {
    let told = 0;
    blocked();
    const c = mk({ onMfaSetupRequired: () => { told++; } });
    await expect(c.listTenants()).rejects.toMatchObject({ status: 403, code: "MFA_SETUP_REQUIRED" });
    await expect(c.listTenants()).rejects.toMatchObject({ code: "MFA_SETUP_REQUIRED" });
    expect(told).toBe(2);
  });

  it("does not sign the person out", async () => {
    let signedOut = 0;
    blocked();
    await expect(mk({ onUnauthorized: () => { signedOut++; } }).listTenants()).rejects.toBeTruthy();
    expect(signedOut).toBe(0);
  });

  it("is not triggered by any other refusal", async () => {
    let told = 0;
    const c = mk({ onMfaSetupRequired: () => { told++; } });
    server.use(http.get(`${API_BASE}/tenants`, () => apiError(403, "FORBIDDEN_ROLE", "Not allowed.")));
    await expect(c.listTenants()).rejects.toMatchObject({ code: "FORBIDDEN_ROLE" });
    server.use(http.get(`${API_BASE}/tenants`, () => apiError(401, "UNAUTHENTICATED", "Sign in.")));
    await expect(c.listTenants()).rejects.toMatchObject({ status: 401 });
    server.use(http.get(`${API_BASE}/tenants`, () => apiError(409, "MFA_SETUP_REQUIRED", "wrong status")));
    await expect(c.listTenants()).rejects.toBeTruthy();
    expect(told).toBe(0);
  });

  it("works without a listener", async () => {
    blocked();
    await expect(mk().listTenants()).rejects.toMatchObject({ code: "MFA_SETUP_REQUIRED" });
  });
});
