import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { adminPool, appPool, makeWorld, type World } from "./helpers.ts";
import { createApp } from "../src/http/app.ts";
import { InMemoryStorageProvider } from "../src/storage/inMemoryProvider.ts";
import { FakeScanner } from "../src/scan/types.ts";
import { FakeEmailSender } from "../src/email/types.ts";
import { FakeTokenVerifier } from "../src/auth/types.ts";
import { JwtTokenVerifier } from "../src/auth/jwt.ts";

afterAll(async () => { await adminPool.end(); await appPool.end(); });

const SECRET = "http-test-secret-value-long-enough";

function setup() {
  const email = new FakeEmailSender();
  const app = createApp({
    pool: appPool, storage: new InMemoryStorageProvider(), scanner: new FakeScanner(), email,
    tokenVerifier: new JwtTokenVerifier(SECRET), jwtSecret: SECRET, appBaseUrl: "https://portal.example",
  });
  return { app, email };
}

describe("auth routes", () => {
  let w: World; let app: ReturnType<typeof setup>["app"]; let email: FakeEmailSender;
  beforeAll(async () => { w = await makeWorld(); ({ app, email } = setup()); });

  it("invite -> accept-invite -> login -> an authenticated request, entirely over HTTP", async () => {
    const auth2 = new FakeTokenVerifier(); // only to authenticate the admin who sends the invite
    const adminApp = createApp({
      pool: appPool, storage: new InMemoryStorageProvider(), scanner: new FakeScanner(), email,
      tokenVerifier: auth2, jwtSecret: SECRET, appBaseUrl: "https://portal.example",
    });
    const invite = await request(adminApp).post("/users").set("Authorization", `Bearer ${auth2.issue(w.admin)}`)
      .send({ email: `new@audit-a-${w.tag}.test`, role: "auditor" });
    expect(invite.status).toBe(201);
    const rawToken = email.sent.at(-1)!.text.match(/token=([0-9a-f]+)/)![1];

    const accepted = await request(app).post("/auth/accept-invite").send({ token: rawToken, password: "a-genuinely-long-password-999" });
    expect(accepted.status).toBe(200);
    expect(accepted.body.token).toBeTruthy();

    const login = await request(app).post("/auth/login").send({ email: `new@audit-a-${w.tag}.test`, password: "a-genuinely-long-password-999" });
    expect(login.status).toBe(200);
    expect(login.body.role).toBe("auditor");

    const controls = await request(app).get(`/audits/${w.auditA1}/controls`).set("Authorization", `Bearer ${login.body.token}`);
    expect(controls.status).toBe(200);
  });

  it("wrong credentials are a clean 401, never a 500", async () => {
    const res = await request(app).post("/auth/login").send({ email: "nobody@nowhere.test", password: "whatever-it-is-here" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("a malformed login body is rejected by validation before touching the database", async () => {
    const res = await request(app).post("/auth/login").send({ email: "not-an-email", password: "" });
    expect(res.status).toBe(400);
  });

  it("an invalid invite token is a clean 400", async () => {
    const res = await request(app).post("/auth/accept-invite").send({ token: "garbage", password: "a-genuinely-long-password-999" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_INVITE");
  });

  it("every other route still requires a token — login does not implicitly grant access to anything else", async () => {
    const res = await request(app).get(`/audits/${w.auditA1}/controls`);
    expect(res.status).toBe(401);
  });
});
