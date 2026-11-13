import { describe, it, expect, beforeEach } from "vitest";
import { server, http, json, apiError, API_BASE } from "../test/mswServer";
import { BuiltInAuthClient } from "./builtInAuthClient";
import { ApiError } from "../api/client";

beforeEach(() => localStorage.clear());

describe("BuiltInAuthClient", () => {
  it("logs in against the real backend shape, stores the session, and notifies listeners", async () => {
    server.use(http.post(`${API_BASE}/auth/login`, () => json({ token: "jwt.abc", userId: "u1", role: "lead_auditor", tenantId: null })));
    const client = new BuiltInAuthClient(API_BASE);
    const seen: unknown[] = [];
    client.subscribe((u) => seen.push(u));

    await client.login("priya@harbor.test", "correct-password-123");

    expect(client.getUser()).toEqual({ userId: "u1", email: "priya@harbor.test", name: "priya@harbor.test", role: "lead_auditor", tenantId: undefined });
    expect(await client.getToken()).toBe("jwt.abc");
    expect(seen).toHaveLength(1);
  });

  it("surfaces the backend's real error message and does not establish a session on failure", async () => {
    server.use(http.post(`${API_BASE}/auth/login`, () => apiError(401, "INVALID_CREDENTIALS", "Incorrect email or password.")));
    const client = new BuiltInAuthClient(API_BASE);
    await expect(client.login("x@x.test", "wrong")).rejects.toMatchObject({ message: "Incorrect email or password.", status: 401 });
    expect(client.getUser()).toBeNull();
    expect(await client.getToken()).toBeNull();
  });

  it("a locked-account response surfaces its own distinct message", async () => {
    server.use(http.post(`${API_BASE}/auth/login`, () => apiError(423, "ACCOUNT_LOCKED", "Too many failed attempts. Please try again in a few minutes.")));
    const client = new BuiltInAuthClient(API_BASE);
    const err = await client.login("x@x.test", "wrong").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("ACCOUNT_LOCKED");
  });

  it("persists the session across a reload (a fresh instance picks up localStorage)", async () => {
    server.use(http.post(`${API_BASE}/auth/login`, () => json({ token: "jwt.xyz", userId: "u2", role: "contributor", tenantId: "t1" })));
    const first = new BuiltInAuthClient(API_BASE);
    await first.login("sam@brightpath.test", "a-real-password-123");

    const reloaded = new BuiltInAuthClient(API_BASE);
    expect(reloaded.getUser()?.userId).toBe("u2");
    expect(reloaded.getUser()?.tenantId).toBe("t1");
    expect(await reloaded.getToken()).toBe("jwt.xyz");
  });

  it("logout clears the session, persists across a reload, and notifies listeners", async () => {
    server.use(http.post(`${API_BASE}/auth/login`, () => json({ token: "jwt.abc", userId: "u1", role: "auditor", tenantId: null })));
    const client = new BuiltInAuthClient(API_BASE);
    await client.login("x@x.test", "a-real-password-123");
    const seen: unknown[] = [];
    client.subscribe((u) => seen.push(u));

    client.logout();

    expect(client.getUser()).toBeNull();
    expect(seen).toEqual([null]);
    const reloaded = new BuiltInAuthClient(API_BASE);
    expect(reloaded.getUser()).toBeNull();
  });

  it("a brand new instance with no prior session returns null, not an error", async () => {
    const client = new BuiltInAuthClient(API_BASE);
    expect(client.getUser()).toBeNull();
    expect(await client.getToken()).toBeNull();
  });
});
