import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { adminPool, appPool, as, makeWorld, denied, type World } from "./helpers.ts";
import { withoutUser } from "../src/db/pool.ts";

afterAll(async () => { await adminPool.end(); await appPool.end(); });

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const newToken = () => { const raw = randomBytes(32).toString("hex"); return { raw, hash: sha(raw) }; };

const request = (email: string, hash: string) =>
  withoutUser(appPool, (c) => c.query("SELECT * FROM password_reset_request($1,$2)", [email, hash])).then((r) => r.rows as Array<{ out_email: string }>);
const consume = (hash: string, pw: string) =>
  withoutUser(appPool, (c) => c.query("SELECT password_reset_consume($1,$2) AS id", [hash, pw])).then((r) => r.rows[0].id as string | null);

const userRow = async (id: string) => (await adminPool.query("SELECT email, status, password_hash, failed_login_count, locked_until, sessions_valid_after FROM users WHERE id=$1", [id])).rows[0];
const emailOf = async (id: string) => (await userRow(id)).email as string;
const resetRows = async (userId: string) => (await adminPool.query("SELECT * FROM password_resets WHERE user_id=$1 ORDER BY created_at", [userId])).rows;
const withPassword = (id: string, hash = "old-hash") => adminPool.query("UPDATE users SET password_hash=$2 WHERE id=$1", [id, hash]);
const auditCount = async (org: string, action: string, actor: string) =>
  (await adminPool.query("SELECT count(*)::int AS n FROM audit_log WHERE org_id=$1 AND action=$2 AND actor_id=$3", [org, action, actor])).rows[0].n as number;

describe("password_reset_request", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("for an active account with a password: returns the address to email, and stores only a hash that expires in one hour", async () => {
    await withPassword(w.auditor);
    const email = await emailOf(w.auditor);
    const t = newToken();
    const out = await request(email, t.hash);
    expect(out).toEqual([{ out_email: email }]);

    const rows = await resetRows(w.auditor);
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(t.hash);
    expect(JSON.stringify(rows[0])).not.toContain(t.raw); // the secret itself is never stored
    expect(rows[0].used_at).toBeNull();
    const minutes = (new Date(rows[0].expires_at).getTime() - Date.now()) / 60000;
    expect(minutes).toBeGreaterThan(58);
    expect(minutes).toBeLessThanOrEqual(60.1);
  });

  it("the caller cannot choose how long the link lives: expiry is not even a parameter", async () => {
    const r = await adminPool.query("SELECT pronargs FROM pg_proc WHERE proname = 'password_reset_request'");
    expect(r.rows[0].pronargs).toBe(2);
  });

  it("matches the address case-insensitively, and returns the stored spelling", async () => {
    await withPassword(w.lead);
    const email = await emailOf(w.lead);
    const out = await request(email.toUpperCase(), newToken().hash);
    expect(out).toEqual([{ out_email: email }]);
  });

  it("an unknown address yields nothing and writes nothing", async () => {
    const before = (await adminPool.query("SELECT count(*)::int AS n FROM password_resets")).rows[0].n;
    expect(await request("nobody@nowhere.test", newToken().hash)).toEqual([]);
    expect((await adminPool.query("SELECT count(*)::int AS n FROM password_resets")).rows[0].n).toBe(before);
  });

  it("yields nothing for accounts that must not be reset this way — invited, disabled, or with no password", async () => {
    const w2 = await makeWorld();
    // active but no password (e.g. signs in through an external identity provider)
    expect(await request(await emailOf(w2.auditor), newToken().hash)).toEqual([]);
    // invited, never set a password
    await adminPool.query("UPDATE users SET status='invited' WHERE id=$1", [w2.readOnly]);
    expect(await request(await emailOf(w2.readOnly), newToken().hash)).toEqual([]);
    // disabled, even though it has a password
    await withPassword(w2.dash);
    await adminPool.query("UPDATE users SET status='disabled' WHERE id=$1", [w2.dash]);
    expect(await request(await emailOf(w2.dash), newToken().hash)).toEqual([]);
    for (const u of [w2.auditor, w2.readOnly, w2.dash]) expect(await resetRows(u)).toHaveLength(0);
  });

  it("at most three links per account per hour; the fourth is silently refused, and other accounts are unaffected", async () => {
    const w3 = await makeWorld();
    await withPassword(w3.auditor); await withPassword(w3.lead);
    const email = await emailOf(w3.auditor);
    for (let i = 0; i < 3; i++) expect(await request(email, newToken().hash), `request ${i + 1}`).toHaveLength(1);
    expect(await request(email, newToken().hash)).toEqual([]);
    expect(await resetRows(w3.auditor)).toHaveLength(3);
    expect(await request(await emailOf(w3.lead), newToken().hash)).toHaveLength(1); // someone else is fine

    await adminPool.query("UPDATE password_resets SET created_at = now() - interval '2 hours' WHERE user_id=$1", [w3.auditor]);
    expect(await request(email, newToken().hash)).toHaveLength(1); // the hour has passed
  });

  it("is written to the audit log against the account, and the log's hash chain stays intact", async () => {
    const w4 = await makeWorld();
    await withPassword(w4.auditor);
    await request(await emailOf(w4.auditor), newToken().hash);
    expect(await auditCount(w4.orgA, "user.password_reset_requested", w4.auditor)).toBe(1);
    expect((await adminPool.query("SELECT verify_audit_chain($1) AS bad", [w4.orgA])).rows[0].bad).toBeNull();
  });

  it("clears out long-expired links so the table can't grow forever", async () => {
    const w5 = await makeWorld();
    await withPassword(w5.auditor); await withPassword(w5.lead);
    await adminPool.query("INSERT INTO password_resets (user_id, token_hash, created_at, expires_at) VALUES ($1,$2, now() - interval '9 days', now() - interval '8 days')", [w5.lead, sha("ancient")]);
    await request(await emailOf(w5.auditor), newToken().hash);
    expect(await resetRows(w5.lead)).toHaveLength(0);
  });
});

describe("password_reset_consume", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });
  async function link(user: string): Promise<{ raw: string; hash: string }> {
    await withPassword(user);
    const t = newToken();
    await adminPool.query("DELETE FROM password_resets WHERE user_id=$1", [user]); // keep the per-hour throttle out of the way
    expect(await request(await emailOf(user), t.hash)).toHaveLength(1);
    return t;
  }

  it("a valid link sets the new password, clears any lockout, revokes older sessions, and is audited", async () => {
    const t = await link(w.auditor);
    await adminPool.query("UPDATE users SET failed_login_count=5, locked_until=now()+interval '15 minutes' WHERE id=$1", [w.auditor]);

    expect(await consume(t.hash, "NEW-HASH-1")).toBe(w.auditor);
    const u = await userRow(w.auditor);
    expect(u.password_hash).toBe("NEW-HASH-1");
    expect(u.failed_login_count).toBe(0);
    expect(u.locked_until).toBeNull();
    expect(Date.now() - new Date(u.sessions_valid_after).getTime()).toBeLessThan(10_000);
    expect(await auditCount(w.orgA, "user.password_reset", w.auditor)).toBe(1);
    expect((await adminPool.query("SELECT verify_audit_chain($1) AS bad", [w.orgA])).rows[0].bad).toBeNull();
  });

  it("a link works once: the second use changes nothing", async () => {
    const t = await link(w.lead);
    expect(await consume(t.hash, "FIRST")).toBe(w.lead);
    expect(await consume(t.hash, "SECOND")).toBeNull();
    expect((await userRow(w.lead)).password_hash).toBe("FIRST");
    expect(await auditCount(w.orgA, "user.password_reset", w.lead)).toBe(1);
  });

  it("an expired link is refused and changes nothing", async () => {
    const t = await link(w.readOnly);
    await adminPool.query("UPDATE password_resets SET expires_at = now() - interval '1 second' WHERE token_hash=$1", [t.hash]);
    expect(await consume(t.hash, "TOO-LATE")).toBeNull();
    expect((await userRow(w.readOnly)).password_hash).toBe("old-hash");
  });

  it("an unknown link is refused, and so is an almost-right one", async () => {
    const t = await link(w.dash);
    expect(await consume(sha("never-issued"), "X")).toBeNull();
    expect(await consume(t.hash.slice(0, -1) + (t.hash.endsWith("0") ? "1" : "0"), "X")).toBeNull();
    expect(await consume(t.raw, "X")).toBeNull(); // the raw secret is not the stored hash
    expect((await userRow(w.dash)).password_hash).toBe("old-hash");
  });

  it("using one link voids every other outstanding link for the account", async () => {
    await withPassword(w.tLead);
    await adminPool.query("DELETE FROM password_resets WHERE user_id=$1", [w.tLead]);
    const a = newToken(); const b = newToken();
    await request(await emailOf(w.tLead), a.hash); await request(await emailOf(w.tLead), b.hash);
    expect(await consume(a.hash, "VIA-A")).toBe(w.tLead);
    expect(await consume(b.hash, "VIA-B")).toBeNull();
    expect((await userRow(w.tLead)).password_hash).toBe("VIA-A");
  });

  it("an account disabled after the link was sent is NOT reset", async () => {
    const t = await link(w.contrib);
    await adminPool.query("UPDATE users SET status='disabled' WHERE id=$1", [w.contrib]);
    expect(await consume(t.hash, "SNEAKY")).toBeNull();
    const u = await userRow(w.contrib);
    expect(u.password_hash).toBe("old-hash");
    expect(u.status).toBe("disabled");
  });

  it("one account's link can never change another account's password", async () => {
    const t = await link(w.viewer);
    await withPassword(w.tDash, "TDASH-ORIGINAL");
    expect(await consume(t.hash, "VIEWER-NEW")).toBe(w.viewer);
    expect((await userRow(w.tDash)).password_hash).toBe("TDASH-ORIGINAL");
    expect((await userRow(w.viewer)).password_hash).toBe("VIEWER-NEW");
  });
});

describe("the app role has no way in except the functions", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); await withPassword(w.auditor); await request(await emailOf(w.auditor), newToken().hash); });

  it("cannot read, add, change or delete reset links — not even as an org admin", async () => {
    await denied(as(w.admin, (c) => c.query("SELECT * FROM password_resets")), /permission denied/);
    await denied(as(w.admin, (c) => c.query("INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,'x', now()+interval '1 day')", [w.admin])), /permission denied/);
    await denied(as(w.admin, (c) => c.query("UPDATE password_resets SET used_at = NULL")), /permission denied/);
    await denied(as(w.admin, (c) => c.query("DELETE FROM password_resets")), /permission denied/);
    await denied(withoutUser(appPool, (c) => c.query("SELECT * FROM password_resets")), /permission denied/);
  });

  it("cannot write a password hash, a lockout or the session-revocation marker straight onto a user", async () => {
    for (const col of ["password_hash", "locked_until", "failed_login_count", "sessions_valid_after"]) {
      const value = col === "failed_login_count" ? "0" : col === "password_hash" ? "'x'" : "NULL";
      await denied(as(w.admin, (c) => c.query(`UPDATE users SET ${col} = ${value} WHERE id = $1`, [w.auditor])), /permission denied/);
    }
  });
});

describe("auth_session_valid", () => {
  const valid = (id: string, issued: Date) =>
    withoutUser(appPool, (c) => c.query("SELECT auth_session_valid($1,$2) AS ok", [id, issued])).then((r) => r.rows[0].ok as boolean);
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("is true for an active account with no reset on record", async () => {
    expect(await valid(w.auditor, new Date(Date.now() - 3_600_000))).toBe(true);
  });

  it("is false for an account that doesn't exist, or is disabled", async () => {
    expect(await valid("00000000-0000-0000-0000-000000000000", new Date())).toBe(false);
    await adminPool.query("UPDATE users SET status='disabled' WHERE id=$1", [w.readOnly]);
    expect(await valid(w.readOnly, new Date())).toBe(false);
  });

  it("after a reset: sessions issued before it are dead, those issued at or after it are fine", async () => {
    await withPassword(w.lead);
    const t = newToken();
    await request(await emailOf(w.lead), t.hash);
    await consume(t.hash, "NEW");
    const floor = new Date((await userRow(w.lead)).sessions_valid_after);
    const floorSecond = new Date(Math.floor(floor.getTime() / 1000) * 1000);

    expect(await valid(w.lead, new Date(floor.getTime() - 3_600_000))).toBe(false); // an hour-old session
    expect(await valid(w.lead, new Date(floorSecond.getTime() - 1000))).toBe(false); // the second before
    expect(await valid(w.lead, floorSecond)).toBe(true);                             // same second as the reset
    expect(await valid(w.lead, new Date(floor.getTime() + 5000))).toBe(true);        // a new sign-in afterwards
  });

  it("only ever answers yes or no", async () => {
    const r = await withoutUser(appPool, (c) => c.query("SELECT auth_session_valid($1,$2) AS ok", [w.auditor, new Date()]));
    expect(typeof r.rows[0].ok).toBe("boolean");
  });
});
