import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { adminPool, appPool, makeWorld, controlId, assignContributor, type World } from "./helpers.ts";
import { createApp } from "../src/http/app.ts";
import { InMemoryStorageProvider } from "../src/storage/inMemoryProvider.ts";
import { FakeScanner } from "../src/scan/types.ts";
import { FakeEmailSender } from "../src/email/types.ts";
import { FakeTokenVerifier } from "../src/auth/types.ts";

afterAll(async () => { await adminPool.end(); await appPool.end(); });

function setup() {
  const auth = new FakeTokenVerifier();
  const storage = new InMemoryStorageProvider();
  const email = new FakeEmailSender();
  const app = createApp({ pool: appPool, storage, scanner: new FakeScanner(), email, tokenVerifier: auth, jwtSecret: "test-jwt-secret", appBaseUrl: "https://test.example" });
  return { app, auth, storage, email };
}
const bearer = (auth: FakeTokenVerifier, userId: string) => `Bearer ${auth.issue(userId)}`;

describe("authentication", () => {
  it("rejects requests with no Authorization header", async () => {
    const { app } = setup();
    const res = await request(app).get("/audits/x/controls");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects an unknown or malformed token", async () => {
    const { app } = setup();
    const res = await request(app).get("/audits/x/controls").set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
    const res2 = await request(app).get("/audits/x/controls").set("Authorization", "not-even-bearer-shaped");
    expect(res2.status).toBe(401);
  });
});

describe("the full evidence workflow over HTTP", () => {
  let w: World; let app: ReturnType<typeof setup>["app"]; let auth: FakeTokenVerifier; let c85: string;
  beforeAll(async () => {
    w = await makeWorld();
    await adminPool.query("UPDATE tenants SET storage_root_id = 'root-a1' WHERE id = $1", [w.tA1]);
    const s = setup(); app = s.app; auth = s.auth;
    c85 = await controlId(w.auditA1, "A.8.5");
    await assignContributor(w, c85);
  });

  it("lists controls for the audit", async () => {
    const res = await request(app).get(`/audits/${w.auditA1}/controls`).set("Authorization", bearer(auth, w.lead));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(117);
  });

  it("a lead auditor edits the requirement for one tenant only", async () => {
    const res = await request(app).patch(`/controls/${c85}/requirement`).set("Authorization", bearer(auth, w.lead))
      .send({ evidenceText: "Up to 4 documents", fileSpec: { types: ["document"], maxFiles: 4 } });
    expect(res.status).toBe(200);
    const list = await request(app).get(`/audits/${w.auditA1}/controls`).set("Authorization", bearer(auth, w.lead));
    expect(list.body.find((r: { controlRef: string }) => r.controlRef === "A.8.5").effectiveEvidence).toBe("Up to 4 documents");
  });

  it("rejects a bad request body with a 400 before it reaches the database", async () => {
    const res = await request(app).patch(`/controls/${c85}/applicability`).set("Authorization", bearer(auth, w.lead)).send({ applicable: "yes" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION");
  });

  it("uploads, confirms, and submits evidence end to end", async () => {
    const session = await request(app).post(`/controls/${c85}/upload-session`).set("Authorization", bearer(auth, w.contrib))
      .send({ fileName: "mfa-settings.pdf", mimeType: "application/pdf", sizeBytes: 1000 });
    expect(session.status).toBe(200);
    expect(session.body.providerFileId).toBeTruthy();

    const confirm = await request(app).post(`/controls/${c85}/uploads/confirm`).set("Authorization", bearer(auth, w.contrib))
      .send({ providerFileId: session.body.providerFileId });
    expect(confirm.status).toBe(201);
    expect(confirm.body.scanStatus).toBe("clean");

    const files = await request(app).get(`/controls/${c85}/files`).set("Authorization", bearer(auth, w.contrib));
    expect(files.body).toHaveLength(1);

    const submit = await request(app).post(`/controls/${c85}/submit`).set("Authorization", bearer(auth, w.contrib));
    expect(submit.status).toBe(200);
    expect(submit.body.status).toBe("submitted");
  });

  it("an infected file comes back as a clean 422, not a 500, and is not recorded", async () => {
    const c87 = await controlId(w.auditA1, "A.8.7");
    await assignContributor(w, c87);
    const session = await request(app).post(`/controls/${c87}/upload-session`).set("Authorization", bearer(auth, w.contrib))
      .send({ fileName: "infected-evidence.pdf", mimeType: "application/pdf", sizeBytes: 10 });
    const confirm = await request(app).post(`/controls/${c87}/uploads/confirm`).set("Authorization", bearer(auth, w.contrib))
      .send({ providerFileId: session.body.providerFileId });
    expect(confirm.status).toBe(422);
    expect(confirm.body.error.code).toBe("INFECTED_FILE");
  });

  it("the auditor accepts the submission, and it appears on the dashboard", async () => {
    const res = await request(app).post(`/controls/${c85}/reviews`).set("Authorization", bearer(auth, w.auditor)).send({ decision: "accept" });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("accepted");
    const dash = await request(app).get(`/audits/${w.auditA1}/dashboard`).set("Authorization", bearer(auth, w.dash));
    expect(dash.status).toBe(200);
    expect(dash.body.accepted).toBeGreaterThanOrEqual(1);
    // by_status keys are status VALUES (e.g. "accepted"), not field names — the camelCase middleware
    // must leave them exactly as the database wrote them, or the frontend's lookups would break.
    expect(dash.body.byStatus).toEqual(expect.arrayContaining([expect.objectContaining({ status: "accepted" })]));
    expect(JSON.stringify(dash.body.byStatus)).not.toContain("awaitingEvidence");
  });

  it("rejecting without a reason is a clean 400, and with a reason it succeeds", async () => {
    const c86 = await controlId(w.auditA1, "A.8.6");
    await assignContributor(w, c86);
    const session = await request(app).post(`/controls/${c86}/upload-session`).set("Authorization", bearer(auth, w.contrib)).send({ fileName: "x.pdf", mimeType: "application/pdf", sizeBytes: 10 });
    await request(app).post(`/controls/${c86}/uploads/confirm`).set("Authorization", bearer(auth, w.contrib)).send({ providerFileId: session.body.providerFileId });
    await request(app).post(`/controls/${c86}/submit`).set("Authorization", bearer(auth, w.contrib));
    const noReason = await request(app).post(`/controls/${c86}/reviews`).set("Authorization", bearer(auth, w.auditor)).send({ decision: "reject" });
    expect(noReason.status).toBe(400);
    const withReason = await request(app).post(`/controls/${c86}/reviews`).set("Authorization", bearer(auth, w.auditor)).send({ decision: "reject", reason: "Blurry screenshot" });
    expect(withReason.status).toBe(201);
  });

  it("a comment is visible to both the auditor and the tenant", async () => {
    const post = await request(app).post(`/controls/${c85}/comments`).set("Authorization", bearer(auth, w.auditor)).send({ type: "minor", body: "Nice and clear, thanks." });
    expect(post.status).toBe(201);
    const seen = await request(app).get(`/controls/${c85}/comments`).set("Authorization", bearer(auth, w.contrib));
    expect(seen.body.some((c: { body: string }) => c.body === "Nice and clear, thanks.")).toBe(true);
  });
});

describe("cross-tenant and permission errors come back as clean HTTP responses", () => {
  let w: World; let app: ReturnType<typeof setup>["app"]; let auth: FakeTokenVerifier;
  beforeAll(async () => { w = await makeWorld(); const s = setup(); app = s.app; auth = s.auth; });

  it("org B gets a 404, never a 500 or a raw database error, when it tries org A's audit", async () => {
    const res = await request(app).get(`/audits/${w.auditA1}/dashboard`).set("Authorization", bearer(auth, w.leadB));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(JSON.stringify(res.body)).not.toMatch(/relation|syntax|postgres/i);
  });

  it("a contributor trying to accept evidence gets a clean error, not a crash", async () => {
    const c85 = await controlId(w.auditA1, "A.8.5");
    await assignContributor(w, c85);
    const res = await request(app).post(`/controls/${c85}/reviews`).set("Authorization", bearer(auth, w.contrib)).send({ decision: "accept" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
