import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { adminPool, appPool, makeWorld, type World } from "./helpers.ts";
import { createApp } from "../src/http/app.ts";
import { InMemoryStorageProvider } from "../src/storage/inMemoryProvider.ts";
import { FakeScanner } from "../src/scan/types.ts";
import { FakeEmailSender } from "../src/email/types.ts";
import { FakeTokenVerifier } from "../src/auth/types.ts";

afterAll(async () => { await adminPool.end(); await appPool.end(); });

function setup() {
  const auth = new FakeTokenVerifier();
  const app = createApp({ pool: appPool, storage: new InMemoryStorageProvider(), scanner: new FakeScanner(), email: new FakeEmailSender(), tokenVerifier: auth, jwtSecret: "test-jwt-secret", appBaseUrl: "https://test.example" });
  return { app, auth };
}
const bearer = (auth: FakeTokenVerifier, userId: string) => `Bearer ${auth.issue(userId)}`;

describe("audit log endpoint", () => {
  let w: World; let app: ReturnType<typeof setup>["app"]; let auth: FakeTokenVerifier;
  beforeAll(async () => {
    w = await makeWorld();
    ({ app, auth } = setup());
    await request(app).patch("/org").set("Authorization", bearer(auth, w.admin)).send({ name: "Logged Co" });
  });

  it("an org admin can read the log, camelCased", async () => {
    const res = await request(app).get("/audit-log").set("Authorization", bearer(auth, w.admin));
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty("createdAt");
    expect(res.body[0]).toHaveProperty("actorId");
  });

  it("nobody but org admins and lead auditors can read it — an empty list, not an error", async () => {
    for (const u of [w.auditor, w.readOnly, w.tLead, w.contrib]) {
      const res = await request(app).get("/audit-log").set("Authorization", bearer(auth, u));
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    }
  });

  it("org B never sees org A's log entries", async () => {
    const res = await request(app).get("/audit-log").set("Authorization", bearer(auth, w.leadB));
    expect(res.body).toEqual([]);
  });
});
