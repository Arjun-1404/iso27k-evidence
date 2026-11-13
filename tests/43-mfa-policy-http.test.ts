import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import type { Pool } from "pg";
import { adminPool, appPool, makeWorld, type World } from "./helpers.ts";
import { createApp, type AppDeps } from "../src/http/app.ts";
import { InMemoryStorageProvider } from "../src/storage/inMemoryProvider.ts";
import { FakeScanner } from "../src/scan/types.ts";
import { FakeEmailSender } from "../src/email/types.ts";
import { JwtTokenVerifier } from "../src/auth/jwt.ts";
import { dbSessionCheck } from "../src/auth/sessionCheck.ts";
import { AesSecretStore } from "../src/auth/secretStore.ts";
import { hashPassword } from "../src/auth/password.ts";
import { totpAtStep, stepAt } from "../src/auth/totp.ts";
import { enforceMfaPolicy } from "../src/http/middleware/mfaPolicy.ts";
import { withUser } from "../src/db/pool.ts";
import { mapDbError } from "../src/errors.ts";

afterAll(async () => { await adminPool.end(); await appPool.end(); });

const SECRET = "mfa-policy-test-secret-value-long-enough";
const STORE = new AesSecretStore("44".repeat(32));
const PW = "a-perfectly-good-password-123";
let PW_HASH: string;

function setup(over: Partial<AppDeps> = {}) {
  return createApp({
    pool: appPool, storage: new InMemoryStorageProvider(), scanner: new FakeScanner(), email: new FakeEmailSender(),
    tokenVerifier: new JwtTokenVerifier(SECRET, dbSessionCheck(appPool)), jwtSecret: SECRET, appBaseUrl: "https://portal.example",
    secretStore: STORE, ...over,
  });
}
type App = ReturnType<typeof setup>;

let clock = 0;
function freeze() {
  clock = Math.ceil(Date.now() / 30_000) * 30_000 + 15_000;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clock);
}
const freshCode = (secret: string) => { clock += 30_000; vi.setSystemTime(clock); return totpAtStep(secret, stepAt(Date.now())); };

beforeAll(async () => { PW_HASH = await hashPassword(PW); });
beforeEach(() => { freeze(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const get = (app: App, t: string, path: string) => request(app).get(path).set(bearer(t));
const post = (app: App, t: string, path: string, body: object = {}) => request(app).post(path).set(bearer(t)).send(body);
const put = (app: App, t: string, path: string, body: object = {}) => request(app).put(path).set(bearer(t)).send(body);
const login = (app: App, email: string, password = PW) => request(app).post("/auth/login").send({ email, password });
const setPolicy = (app: App, t: string, policy: unknown) => put(app, t, "/org/mfa-policy", { policy });

/** Gives people in the test world a password so they can sign in (the world's users have none). */
async function withPasswords(w: World, ids: string[]) {
  for (const id of ids) await adminPool.query("UPDATE users SET password_hash=$2 WHERE id=$1", [id, PW_HASH]);
}
const emailOf = async (id: string) => (await adminPool.query("SELECT email FROM users WHERE id=$1", [id])).rows[0].email as string;
const sessionFor = async (app: App, id: string) => {
  const r = await login(app, await emailOf(id));
  expect(r.status).toBe(200);
  expect(r.body.token).toBeTruthy();
  return r.body.token as string;
};
/** A session for someone who is already signed in at the moment the policy changes. */
const tokenFor = (id: string) => jwt.sign({ sub: id }, SECRET, { issuer: "evidence-portal", expiresIn: 3600 });

/** Walks the real journey for turning two-step sign-in on; returns the secret and recovery codes. */
async function enrol(app: App, id: string, session?: string) {
  const s = session ?? await sessionFor(app, id);
  const begun = await post(app, s, "/auth/mfa/enroll", { password: PW });
  expect(begun.status).toBe(200);
  const secret = begun.body.secret as string;
  const done = await post(app, s, "/auth/mfa/enroll/confirm", { code: freshCode(secret) });
  expect(done.status).toBe(200);
  return { secret, recoveryCodes: done.body.recoveryCodes as string[], session: s };
}
const chainOk = async (org: string) => (await adminPool.query("SELECT verify_audit_chain($1) AS bad", [org])).rows[0].bad === null;
const policyAudits = async (org: string) =>
  (await adminPool.query("SELECT actor_id, change FROM audit_log WHERE org_id=$1 AND action='org.mfa_policy_changed' ORDER BY seq", [org])).rows;
const dbPolicy = async (org: string) => (await adminPool.query("SELECT mfa_policy FROM orgs WHERE id=$1", [org])).rows[0].mfa_policy as string;

// ====================================================================================================================
describe("the organisation's policy setting", () => {
  let w: World; let app: App; let admin: string;
  beforeAll(async () => {
    w = await makeWorld(); app = setup();
    await withPasswords(w, [w.admin, w.lead, w.auditor, w.tLead, w.adminB]);
    admin = await sessionFor(app, w.admin);
  });

  it("starts off, and shows how far along people are", async () => {
    const r = await get(app, admin, "/org/mfa-policy");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ policy: "off", available: true, staff: { total: 3, enrolled: 0 }, everyone: { total: 4, enrolled: 0 } });
  });

  it("is for organisation admins only", async () => {
    expect((await request(app).get("/org/mfa-policy")).status).toBe(401);
    expect((await request(app).put("/org/mfa-policy").send({ policy: "off" })).status).toBe(401);
    for (const id of [w.lead, w.auditor, w.tLead]) {
      const s = await sessionFor(app, id);
      const g = await get(app, s, "/org/mfa-policy");
      expect(g.status).toBe(403);
      expect(g.body.error.code).toBe("FORBIDDEN_ROLE");
      const p = await setPolicy(app, s, "off");
      expect(p.status).toBe(403);
      expect(p.body.error.code).toBe("FORBIDDEN_ROLE");
    }
    expect(await dbPolicy(w.orgA)).toBe("off");
  });

  it("checks what it is given", async () => {
    for (const body of [{}, { policy: "" }, { policy: "all" }, { policy: "EVERYONE" }, { policy: 1 }, { policy: null }]) {
      const r = await put(app, admin, "/org/mfa-policy", body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error.code).toBe("VALIDATION");
    }
    expect(await dbPolicy(w.orgA)).toBe("off");
  });

  it("can't be switched on by an admin who hasn't turned two-step sign-in on for themselves", async () => {
    for (const p of ["staff", "everyone"]) {
      const r = await setPolicy(app, admin, p);
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("MFA_ADMIN_NEEDS_MFA");
    }
    expect(await dbPolicy(w.orgA)).toBe("off");
    expect((await setPolicy(app, admin, "off")).body.policy).toBe("off"); // "off" never needs it
  });

  it("can't be switched on when this server can't do two-step sign-in, but can always be switched off", async () => {
    const noKey = setup({ secretStore: undefined });
    const r = await setPolicy(noKey, admin, "staff");
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("MFA_NOT_CONFIGURED");
    expect(await dbPolicy(w.orgA)).toBe("off");
    const g = await get(noKey, admin, "/org/mfa-policy");
    expect(g.body.available).toBe(false);
    expect((await setPolicy(noKey, admin, "off")).status).toBe(200);
  });

  it("is changed by an admin who has it on — and the new setting and the counts come back at once", async () => {
    const mine = await enrol(app, w.admin, admin);
    const staff = await setPolicy(app, mine.session, "staff");
    expect(staff.status).toBe(200);
    expect(staff.body).toEqual({ policy: "staff", available: true, staff: { total: 3, enrolled: 1 }, everyone: { total: 4, enrolled: 1 } });
    expect(await dbPolicy(w.orgA)).toBe("staff");
    const everyone = await setPolicy(app, mine.session, "everyone");
    expect(everyone.body.policy).toBe("everyone");
    expect(await dbPolicy(w.orgA)).toBe("everyone");
  });

  it("every change is in the audit log (and a repeat is not), and the log's chain is intact", async () => {
    const before = (await policyAudits(w.orgA)).length;
    const s = tokenFor(w.admin);
    expect((await setPolicy(app, s, "everyone")).status).toBe(200); // already everyone from the test above
    expect((await policyAudits(w.orgA)).length).toBe(before);
    expect((await setPolicy(app, s, "off")).status).toBe(200);
    const rows = await policyAudits(w.orgA);
    expect(rows.length).toBe(before + 1);
    expect(rows.at(-1)).toMatchObject({ actor_id: w.admin, change: { from: "everyone", to: "off" } });
    expect(await chainOk(w.orgA)).toBe(true);
  });

  it("only touches the admin's own organisation", async () => {
    const other = await sessionFor(app, w.adminB);
    const g = await get(app, other, "/org/mfa-policy");
    expect(g.status).toBe(200);
    expect(g.body.policy).toBe("off");
    expect(g.body.staff.total).toBe(1); // only org B's own people are counted
    await enrol(app, w.adminB, other);
    expect((await setPolicy(app, other, "everyone")).status).toBe(200);
    expect(await dbPolicy(w.orgB)).toBe("everyone");
    expect(await dbPolicy(w.orgA)).toBe("off");
  });
});

// ====================================================================================================================
describe("when the policy is on", () => {
  let w: World; let app: App; let admin: { session: string; secret: string; recoveryCodes: string[] };
  const STAFF = () => w.auditor;
  const CLIENT = () => w.tLead;

  beforeEach(async () => { /* a fresh world per test would be slow; tests below reset what they touch */ });
  beforeAll(async () => {
    w = await makeWorld(); app = setup();
    await withPasswords(w, [w.admin, w.auditor, w.lead, w.tLead, w.contrib]);
    admin = await enrol(app, w.admin);
    expect((await setPolicy(app, admin.session, "staff")).status).toBe(200);
  });
  const resetPolicy = async (p: "off" | "staff" | "everyone") => { await adminPool.query("UPDATE orgs SET mfa_policy=$2 WHERE id=$1", [w.orgA, p]); };
  const clearMfa = async (id: string) => {
    await adminPool.query("DELETE FROM user_mfa WHERE user_id=$1", [id]);
    await adminPool.query("DELETE FROM mfa_recovery_codes WHERE user_id=$1", [id]);
  };

  const BLOCKED = [
    ["GET", "/users"], ["GET", "/tenants"], ["GET", "/audit-log"], ["GET", "/org/mfa-policy"], ["PUT", "/org/mfa-policy"],
    ["POST", "/auth/change-password"], ["POST", "/auth/mfa/disable"], ["POST", "/auth/mfa/recovery-codes"],
  ] as const;

  it("someone it covers who hasn't set it up can set it up — and nothing else", async () => {
    await resetPolicy("staff"); await clearMfa(STAFF());
    const s = await sessionFor(app, STAFF()); // password alone still signs in: there is no second step yet
    for (const [method, path] of BLOCKED) {
      const r = method === "GET" ? await get(app, s, path) : method === "PUT" ? await put(app, s, path, {}) : await post(app, s, path, {});
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.body.error.code, `${method} ${path}`).toBe("MFA_SETUP_REQUIRED");
    }
    const status = await get(app, s, "/auth/mfa");
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ enabled: false, recoveryRemaining: 0, available: true, required: true });
    expect((await post(app, s, "/auth/mfa/enroll", { password: PW })).status).toBe(200);
  });

  it("setting it up lifts the block, with the very same session", async () => {
    await resetPolicy("staff"); await clearMfa(STAFF());
    const s = await sessionFor(app, STAFF());
    expect((await get(app, s, "/users")).status).toBe(403);
    await enrol(app, STAFF(), s);
    expect((await get(app, s, "/users")).status).toBe(200);
    const status = await get(app, s, "/auth/mfa");
    expect(status.body).toMatchObject({ enabled: true, required: true });
  });

  it("a half-finished set-up doesn't count", async () => {
    await resetPolicy("staff"); await clearMfa(STAFF());
    const s = await sessionFor(app, STAFF());
    expect((await post(app, s, "/auth/mfa/enroll", { password: PW })).status).toBe(200); // started, never confirmed
    expect((await get(app, s, "/users")).status).toBe(403);
  });

  it("someone who has set it up is not blocked", async () => {
    const r = await get(app, admin.session, "/users");
    expect(r.status).toBe(200);
  });

  it("takes effect for people already signed in, the moment it is switched on — and off", async () => {
    await resetPolicy("off"); await clearMfa(STAFF());
    const s = await sessionFor(app, STAFF());
    expect((await get(app, s, "/users")).status).toBe(200);
    expect((await setPolicy(app, admin.session, "staff")).status).toBe(200);
    expect((await get(app, s, "/users")).status).toBe(403);
    expect((await setPolicy(app, admin.session, "off")).status).toBe(200);
    expect((await get(app, s, "/users")).status).toBe(200);
  });

  it("'staff' covers the organisation's own people; 'everyone' covers clients as well", async () => {
    await resetPolicy("staff"); await clearMfa(CLIENT());
    const client = await sessionFor(app, CLIENT());
    const c1 = await get(app, client, "/auth/mfa");
    expect(c1.body.required).toBe(false);
    expect((await get(app, client, "/tenants")).status).not.toBe(403);

    expect((await setPolicy(app, admin.session, "everyone")).status).toBe(200);
    const c2 = await get(app, client, "/auth/mfa");
    expect(c2.status).toBe(200);
    expect(c2.body).toMatchObject({ enabled: false, required: true });
    const blocked = await get(app, client, "/tenants");
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("MFA_SETUP_REQUIRED");

    await enrol(app, CLIENT(), client);
    expect((await get(app, client, "/tenants")).status).not.toBe(403);
  });

  it("never covers an account that signs in elsewhere (no password held here)", async () => {
    await resetPolicy("everyone");
    await adminPool.query("UPDATE users SET password_hash=NULL WHERE id=$1", [w.contrib]);
    const sso = tokenFor(w.contrib);
    const r = await get(app, sso, "/auth/mfa");
    expect(r.status).toBe(200);
    expect(r.body.required).toBe(false);
    expect((await get(app, sso, "/tenants")).status).not.toBe(403);
    await adminPool.query("UPDATE users SET password_hash=$2 WHERE id=$1", [w.contrib, PW_HASH]);
  });

  it("someone it covers can't turn their own off — and is told before being asked for a password or a code", async () => {
    await resetPolicy("staff"); await clearMfa(STAFF());
    const me = await enrol(app, STAFF());
    const r = await post(app, me.session, "/auth/mfa/disable", { password: "not-even-the-password", code: freshCode(me.secret) });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("MFA_REQUIRED_BY_POLICY");
    const row = (await adminPool.query("SELECT failed_login_count FROM users WHERE id=$1", [STAFF()])).rows[0];
    expect(row.failed_login_count).toBe(0); // the wrong password wasn't even looked at
    expect((await get(app, me.session, "/auth/mfa")).body.enabled).toBe(true);
    expect((await adminPool.query("SELECT 1 FROM user_mfa WHERE user_id=$1 AND enabled_at IS NOT NULL", [STAFF()])).rowCount).toBe(1);
  });

  it("if the rule is switched on a moment after the page checked, the database's own refusal is the same clear 403", async () => {
    await resetPolicy("staff"); await clearMfa(STAFF());
    await enrol(app, STAFF());
    const failure = await withUser(appPool, STAFF(), (c) => c.query("SELECT mfa_disable()")).then(() => null, (e: unknown) => e);
    expect(failure).not.toBeNull();
    expect(mapDbError(failure)).toMatchObject({ status: 403, code: "MFA_REQUIRED_BY_POLICY" });
  });

  it("…but they can once the policy no longer covers them", async () => {
    await resetPolicy("staff"); await clearMfa(STAFF());
    const me = await enrol(app, STAFF());
    expect((await setPolicy(app, admin.session, "off")).status).toBe(200);
    const r = await post(app, me.session, "/auth/mfa/disable", { password: PW, code: freshCode(me.secret) });
    expect(r.status).toBe(200);
    expect((await get(app, me.session, "/auth/mfa")).body).toMatchObject({ enabled: false, required: false });
  });

  it("recovery codes can still be regenerated by someone it covers", async () => {
    await resetPolicy("staff"); await clearMfa(STAFF());
    const me = await enrol(app, STAFF());
    const r = await post(app, me.session, "/auth/mfa/recovery-codes", { password: PW, code: freshCode(me.secret) });
    expect(r.status).toBe(200);
    expect(r.body.recoveryCodes).toHaveLength(me.recoveryCodes.length);
  });

  it("an admin's reset sends the person back to setting it up again", async () => {
    await resetPolicy("staff"); await clearMfa(STAFF());
    const me = await enrol(app, STAFF());
    expect((await get(app, me.session, "/users")).status).toBe(200);
    // (sessions made on this test's clock, which runs ahead of the database's, would outlast a revocation — so check
    //  with one issued a minute ago by the real clock)
    const older = jwt.sign({ sub: STAFF(), iat: Math.floor(Date.now() / 1000) - 120 }, SECRET, { issuer: "evidence-portal", expiresIn: 3600 });
    expect((await get(app, older, "/auth/mfa")).status).toBe(200);
    const reset = await post(app, admin.session, `/users/${STAFF()}/reset-mfa`);
    expect(reset.body).toEqual({ reset: true });
    expect((await get(app, older, "/auth/mfa")).status).toBe(401); // the reset ends their sessions

    const again = await sessionFor(app, STAFF());
    const blocked = await get(app, again, "/users");
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("MFA_SETUP_REQUIRED");
    await enrol(app, STAFF(), again);
    expect((await get(app, again, "/users")).status).toBe(200);
  });

  it("an admin covered by the policy who is reset can still get in to set it up again", async () => {
    // (This is the lock-out the 'admin needs it on first' rule exists to prevent: it must also be recoverable.)
    await resetPolicy("staff");
    const second = await adminPool.query(
      "INSERT INTO users (org_id, email, full_name, role, status, password_hash) VALUES ($1,$2,'Second Admin','org_admin','active',$3) RETURNING id",
      [w.orgA, `admin2@audit-a-${w.tag}.test`, PW_HASH]);
    const id = second.rows[0].id as string;
    const s = await sessionFor(app, id);
    const blocked = await get(app, s, "/org/mfa-policy");
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("MFA_SETUP_REQUIRED");
    await enrol(app, id, s);
    expect((await get(app, s, "/org/mfa-policy")).status).toBe(200);
  });

  it("doesn't get in the way of signing in, or of anyone it doesn't cover", async () => {
    await resetPolicy("staff"); await clearMfa(STAFF()); await clearMfa(CLIENT());
    expect((await login(app, await emailOf(STAFF()))).status).toBe(200);
    const client = await sessionFor(app, CLIENT());
    expect((await get(app, client, "/tenants")).status).not.toBe(403);
  });
});

// ====================================================================================================================
describe("the check itself", () => {
  const fakeRes = () => {
    const res: { statusCode?: number; body?: unknown; status: (n: number) => typeof res; json: (b: unknown) => typeof res } = {
      status(n) { res.statusCode = n; return res; },
      json(b) { res.body = b; return res; },
    };
    return res;
  };
  const failingPool = () => ({ connect: vi.fn(() => Promise.reject(new Error("database is down"))) }) as unknown as Pool & { connect: ReturnType<typeof vi.fn> };

  it("fails closed: a database failure is an error, never 'carry on'", async () => {
    const pool = failingPool();
    const next = vi.fn(); const res = fakeRes();
    await enforceMfaPolicy(pool)({ method: "GET", path: "/users", userId: "11111111-1111-4111-8111-111111111111" } as never, res as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(res.statusCode).toBeUndefined();
  });

  it("an id that can't belong to an account (not a UUID) is passed through without touching the database", async () => {
    const pool = failingPool();
    const next = vi.fn();
    await enforceMfaPolicy(pool)({ method: "GET", path: "/users", userId: "auth0|abc123" } as never, fakeRes() as never, next);
    await enforceMfaPolicy(pool)({ method: "GET", path: "/users" } as never, fakeRes() as never, next);
    expect(next.mock.calls).toEqual([[], []]);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("the three set-up endpoints are let through without a lookup; look-alikes are not", async () => {
    const pool = failingPool();
    for (const [method, path] of [["GET", "/auth/mfa"], ["POST", "/auth/mfa/enroll"], ["POST", "/auth/mfa/enroll/confirm"]]) {
      const next = vi.fn();
      await enforceMfaPolicy(pool)({ method, path, userId: "11111111-1111-4111-8111-111111111111" } as never, fakeRes() as never, next);
      expect(next.mock.calls, `${method} ${path}`).toEqual([[]]);
    }
    expect(pool.connect).not.toHaveBeenCalled();
    for (const [method, path] of [["POST", "/auth/mfa"], ["GET", "/auth/mfa/enroll"], ["DELETE", "/auth/mfa"], ["HEAD", "/auth/mfa"], ["GET", "/auth/mfa/"], ["POST", "/auth/mfa/enroll/"], ["GET", "/AUTH/MFA"], ["POST", "/auth/mfa/disable"]]) {
      const next = vi.fn();
      await enforceMfaPolicy(pool)({ method, path, userId: "11111111-1111-4111-8111-111111111111" } as never, fakeRes() as never, next);
      expect(next.mock.calls[0]?.[0], `${method} ${path}`).toBeInstanceOf(Error); // reached the (failing) lookup
    }
  });

  it("through the whole app, a database failure in the check is a plain server error", async () => {
    const w = await makeWorld();
    await withPasswords(w, [w.auditor]);
    const good = setup();
    const s = await sessionFor(good, w.auditor);
    const broken = setup({ pool: failingPool() });
    const r = await get(broken, s, "/users");
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain("database is down");
  });
});
