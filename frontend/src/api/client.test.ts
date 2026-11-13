import { describe, it, expect, vi } from "vitest";
import { server, http, json, apiError, API_BASE } from "../test/mswServer";
import { ApiClient, ApiError } from "./client";

const clientWith = (token: string | null, onUnauthorized?: () => void) =>
  new ApiClient({ baseUrl: API_BASE, getToken: async () => token, onUnauthorized });

describe("ApiClient: a session the server no longer accepts", () => {
  it("calls onUnauthorized when a request that carried a session token gets 401, and still throws the error", async () => {
    server.use(http.get(`${API_BASE}/users`, () => apiError(401, "UNAUTHENTICATED", "Invalid or expired session.")));
    const onUnauthorized = vi.fn();
    await expect(clientWith("jwt.old", onUnauthorized).listOrgUsers()).rejects.toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("does NOT call it for a 401 on a request that had no token (a wrong password is not 'your session ended')", async () => {
    server.use(http.post(`${API_BASE}/auth/accept-invite`, () => apiError(401, "UNAUTHENTICATED", "nope")));
    const onUnauthorized = vi.fn();
    await expect(clientWith(null, onUnauthorized).acceptInvite("t", "pw")).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("does NOT call it for other failures — a 403, 404, 429 or 500 does not sign anyone out", async () => {
    const onUnauthorized = vi.fn();
    for (const status of [403, 404, 429, 500]) {
      server.use(http.get(`${API_BASE}/users`, () => apiError(status, "X", "no")));
      await expect(clientWith("jwt.ok", onUnauthorized).listOrgUsers()).rejects.toMatchObject({ status });
    }
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("works without a handler (nothing to call, nothing breaks)", async () => {
    server.use(http.get(`${API_BASE}/users`, () => apiError(401, "UNAUTHENTICATED", "x")));
    await expect(clientWith("jwt.old").listOrgUsers()).rejects.toMatchObject({ status: 401 });
  });
});

describe("ApiClient: password reset", () => {
  it("asks for a reset email with just the address, and sends the link's secret with the new password", async () => {
    const seen: Array<{ path: string; body: unknown; auth: string | null }> = [];
    server.use(
      http.post(`${API_BASE}/auth/forgot-password`, async ({ request }) => { seen.push({ path: "forgot", body: await request.json(), auth: request.headers.get("authorization") }); return json({ message: "ok" }, 202); }),
      http.post(`${API_BASE}/auth/reset-password`, async ({ request }) => { seen.push({ path: "reset", body: await request.json(), auth: request.headers.get("authorization") }); return json({ ok: true }); }),
    );
    const api = clientWith(null);
    await api.requestPasswordReset("a@b.test");
    await api.resetPassword("secret-from-link", "a-brand-new-password-1");
    expect(seen).toEqual([
      { path: "forgot", body: { email: "a@b.test" }, auth: null },
      { path: "reset", body: { token: "secret-from-link", password: "a-brand-new-password-1" }, auth: null },
    ]);
  });
});
