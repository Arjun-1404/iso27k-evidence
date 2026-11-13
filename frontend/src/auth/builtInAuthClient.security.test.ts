import { describe, it, expect, beforeEach } from "vitest";
import { server, http, json, API_BASE } from "../test/mswServer";
import { BuiltInAuthClient } from "./builtInAuthClient";

beforeEach(() => localStorage.clear());

const SESSION = { token: "jwt.first", userId: "u1", role: "lead_auditor", tenantId: null };
async function signedIn() {
  server.use(http.post(`${API_BASE}/auth/login`, () => json(SESSION)));
  const client = new BuiltInAuthClient(API_BASE);
  await client.login("priya@harbor.test", "pw-123456789");
  return client;
}

describe("BuiltInAuthClient.replaceSession (after a password change)", () => {
  it("swaps the token for the fresh one, keeping the same person signed in", async () => {
    const client = await signedIn();
    const seen: unknown[] = [];
    client.subscribe((u) => seen.push(u));
    const before = client.getUser();
    client.replaceSession({ token: "jwt.fresh", userId: "u1", role: "lead_auditor", tenantId: null });
    expect(await client.getToken()).toBe("jwt.fresh");
    expect(client.getUser()).toEqual(before);
    expect(seen).toEqual([]); // nobody is signed out or in: nothing for the app to re-render around
  });

  it("is what a reload finds", async () => {
    const client = await signedIn();
    client.replaceSession({ token: "jwt.fresh", userId: "u1", role: "lead_auditor" });
    const reloaded = new BuiltInAuthClient(API_BASE);
    expect(await reloaded.getToken()).toBe("jwt.fresh");
    expect(reloaded.getUser()?.email).toBe("priya@harbor.test");
    expect(localStorage.getItem("evidence-portal-session")).not.toContain("jwt.first");
  });

  it("never swaps in a session for somebody else", async () => {
    const client = await signedIn();
    client.replaceSession({ token: "jwt.someone-else", userId: "u2", role: "auditor" });
    expect(await client.getToken()).toBe("jwt.first");
    expect(client.getUser()?.userId).toBe("u1");
  });

  it("does nothing when nobody is signed in", async () => {
    const client = new BuiltInAuthClient(API_BASE);
    client.replaceSession({ token: "jwt.fresh", userId: "u1", role: "lead_auditor" });
    expect(await client.getToken()).toBeNull();
    expect(client.getUser()).toBeNull();
    expect(localStorage.length).toBe(0);
  });
});
