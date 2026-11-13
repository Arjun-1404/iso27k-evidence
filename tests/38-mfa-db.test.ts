import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { adminPool, appPool, as, makeWorld, denied, type World } from "./helpers.ts";
import { withoutUser } from "../src/db/pool.ts";

afterAll(async () => { await adminPool.end(); await appPool.end(); });

// ---- thin wrappers over the SQL functions, the way the application calls them -------------------------------
const begin = (user: string, secret = "ciphertext-1") => as(user, (c) => c.query("SELECT mfa_begin_enrollment($1)", [secret]));
const enrollSecret = (user: string) => as(user, (c) => c.query("SELECT mfa_enrollment_secret() AS s")).then((r) => r.rows[0].s as string | null);
const confirm = (user: string, step: number | null, hashes: string[] | null) =>
  as(user, (c) => c.query("SELECT mfa_confirm_enrollment($1,$2) AS ok", [step, hashes])).then((r) => r.rows[0].ok as boolean);
const status = (user: string) => as(user, (c) => c.query("SELECT * FROM mfa_status()")).then((r) => r.rows[0] as { enabled: boolean; recovery_remaining: number });
const disable = (user: string) => as(user, (c) => c.query("SELECT mfa_disable() AS ok")).then((r) => r.rows[0].ok as boolean);
const replaceCodes = (user: string, hashes: string[] | null) => as(user, (c) => c.query("SELECT mfa_replace_recovery_codes($1) AS ok", [hashes])).then((r) => r.rows[0].ok as boolean);
const adminReset = (actor: string, target: string) => as(actor, (c) => c.query("SELECT mfa_admin_reset($1) AS ok", [target])).then((r) => r.rows[0].ok as boolean);
const complete = (user: string, step: number | null, recovery: string | null = null) =>
  withoutUser(appPool, (c) => c.query("SELECT mfa_complete_login($1,$2,$3) AS ok", [user, step, recovery])).then((r) => r.rows[0].ok as boolean);
const loginState = (user: string) => withoutUser(appPool, (c) => c.query("SELECT * FROM mfa_login_state($1)", [user])).then((r) => r.rows as Array<{ secret_enc: string; locked: boolean }>);
const isEnabled = (user: string) => withoutUser(appPool, (c) => c.query("SELECT mfa_is_enabled($1) AS e", [user])).then((r) => r.rows[0].e as boolean);

const row = async (user: string) => (await adminPool.query("SELECT * FROM user_mfa WHERE user_id=$1", [user])).rows[0];
const codes = async (user: string) => (await adminPool.query("SELECT code_hash, used_at FROM mfa_recovery_codes WHERE user_id=$1 ORDER BY code_hash", [user])).rows;
const audits = async (org: string, action: string, actor?: string) =>
  (await adminPool.query("SELECT count(*)::int AS n FROM audit_log WHERE org_id=$1 AND action=$2" + (actor ? " AND actor_id=$3" : ""), actor ? [org, action, actor] : [org, action])).rows[0].n as number;
const chainOk = async (org: string) => (await adminPool.query("SELECT verify_audit_chain($1) AS bad", [org])).rows[0].bad === null;
const hashes = (...h: string[]) => h;

/** Turns two-step sign-in fully on for a user (as the signed-in user would), with the given recovery code hashes. */
async function enableFor(user: string, step = 100, recovery = hashes("rc-a", "rc-b", "rc-c")) {
  await begin(user, `ct-${user.slice(0, 6)}`);
  expect(await confirm(user, step, recovery)).toBe(true);
}
const lockoutIn = async (user: string) => (await row(user)).locked_until as Date | null;

describe("the tables are closed to the application's database role", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); await enableFor(w.auditor); });

  it("cannot read, write or delete either table directly", async () => {
    for (const sql of [
      "SELECT * FROM user_mfa", "SELECT * FROM mfa_recovery_codes",
      "UPDATE user_mfa SET failed_attempts = 0", "UPDATE mfa_recovery_codes SET used_at = NULL",
      "DELETE FROM user_mfa", "DELETE FROM mfa_recovery_codes",
    ]) await denied(as(w.auditor, (c) => c.query(sql)), /permission denied/);
    await denied(as(w.auditor, (c) => c.query("INSERT INTO user_mfa (user_id, secret_enc) VALUES ($1, 'x')", [w.lead])), /permission denied/);
    await denied(as(w.auditor, (c) => c.query("INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, 'x')", [w.auditor])), /permission denied/);
  });
});

describe("enrolment", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("starting stores a pending secret for the signed-in user only; nothing is on yet", async () => {
    await begin(w.auditor, "ct-auditor");
    expect(await enrollSecret(w.auditor)).toBe("ct-auditor");
    expect(await enrollSecret(w.lead)).toBeNull(); // someone else's pending secret is invisible
    expect(await status(w.auditor)).toEqual({ enabled: false, recovery_remaining: 0 });
    expect(await isEnabled(w.auditor)).toBe(false);
    expect(await loginState(w.auditor)).toEqual([]); // a pending enrolment can't be used to sign in
    expect((await row(w.auditor)).enabled_at).toBeNull();
  });

  it("starting needs a signed-in, active user", async () => {
    await denied(withoutUser(appPool, (c) => c.query("SELECT mfa_begin_enrollment('x')")), /FORBIDDEN_ROLE/);
    await adminPool.query("UPDATE users SET status='disabled' WHERE id=$1", [w.contrib]);
    await denied(as(w.contrib, (c) => c.query("SELECT mfa_begin_enrollment('x')")), /FORBIDDEN_ROLE/);
  });

  it("starting again replaces the pending secret (a fresh QR code each time)", async () => {
    await begin(w.readOnly, "first"); await begin(w.readOnly, "second");
    expect(await enrollSecret(w.readOnly)).toBe("second");
    expect((await adminPool.query("SELECT count(*)::int AS n FROM user_mfa WHERE user_id=$1", [w.readOnly])).rows[0].n).toBe(1);
  });

  it("confirming turns it on, stores the recovery codes only as given (hashes), and is audited", async () => {
    await begin(w.lead, "ct-lead");
    expect(await confirm(w.lead, 4242, hashes("hash-1", "hash-2"))).toBe(true);
    const r = await row(w.lead);
    expect(r.enabled_at).not.toBeNull();
    expect(Number(r.last_used_step)).toBe(4242); // the confirming code can't be replayed to sign in
    expect((await codes(w.lead)).map((c) => c.code_hash)).toEqual(["hash-1", "hash-2"]);
    expect(await status(w.lead)).toEqual({ enabled: true, recovery_remaining: 2 });
    expect(await isEnabled(w.lead)).toBe(true);
    expect(await audits(w.orgA, "user.mfa_enabled", w.lead)).toBe(1);
    expect(await enrollSecret(w.lead)).toBeNull(); // no longer "pending"
  });

  it("cannot be turned on without recovery codes (an account must never be left with no way back in)", async () => {
    await begin(w.dash, "ct-dash");
    await denied(confirm(w.dash, 1, []), /MFA_NEEDS_RECOVERY_CODES/);
    await denied(confirm(w.dash, 1, null), /MFA_NEEDS_RECOVERY_CODES/);
    expect((await row(w.dash)).enabled_at).toBeNull();
  });

  it("confirming with nothing pending, or confirming twice, does nothing", async () => {
    expect(await confirm(w.viewer, 1, hashes("h"))).toBe(false);
    await begin(w.tLead, "ct-t"); expect(await confirm(w.tLead, 5, hashes("h1"))).toBe(true);
    expect(await confirm(w.tLead, 6, hashes("h2"))).toBe(false);
    expect((await codes(w.tLead)).map((c) => c.code_hash)).toEqual(["h1"]); // the second attempt changed nothing
  });

  it("someone else cannot confirm your enrolment — each person only ever acts on their own", async () => {
    await begin(w.tDash, "ct-td");
    expect(await confirm(w.tLead2, 9, hashes("evil"))).toBe(false);
    expect((await row(w.tDash)).enabled_at).toBeNull();
  });

  it("cannot be started again while it is on", async () => {
    await denied(begin(w.lead, "another"), /MFA_ALREADY_ENABLED/);
    expect((await row(w.lead)).secret_enc).toBe("ct-lead"); // the working secret was not replaced
  });
});

describe("completing a sign-in (mfa_complete_login)", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("accepts a fresh time step once; the same step again, or an older one, is refused; a newer one works", async () => {
    await enableFor(w.auditor, 100);
    expect(await complete(w.auditor, 101)).toBe(true);
    expect(await complete(w.auditor, 101)).toBe(false); // replay
    expect(await complete(w.auditor, 100)).toBe(false); // older
    expect(await complete(w.auditor, 99)).toBe(false);
    expect(await complete(w.auditor, 102)).toBe(true);
  });

  it("the code that confirmed enrolment cannot be used to sign in straight afterwards", async () => {
    await enableFor(w.lead, 500);
    expect(await complete(w.lead, 500)).toBe(false);
    expect(await complete(w.lead, 501)).toBe(true);
  });

  it("two simultaneous attempts with the same code: exactly one succeeds (the second waits for the first, then sees it used)", async () => {
    await enableFor(w.readOnly, 10);
    // Two real, overlapping transactions — deterministic, unlike hoping parallel requests happen to collide.
    const a = await appPool.connect(); const b = await appPool.connect();
    try {
      await a.query("BEGIN"); await b.query("BEGIN");
      const first = await a.query("SELECT mfa_complete_login($1,$2,NULL) AS ok", [w.readOnly, 11]); // takes the row lock, not yet committed
      const secondPending = b.query("SELECT mfa_complete_login($1,$2,NULL) AS ok", [w.readOnly, 11]);
      await new Promise((r) => setTimeout(r, 150)); // let the second reach the lock
      await a.query("COMMIT");
      const second = await secondPending;
      await b.query("COMMIT");
      expect([first.rows[0].ok, second.rows[0].ok]).toEqual([true, false]);
    } finally { a.release(); b.release(); }
  });

  it("five wrong attempts lock it for 15 minutes — and the lock is audited once", async () => {
    await enableFor(w.dash, 1);
    for (let i = 0; i < 4; i++) expect(await complete(w.dash, null)).toBe(false);
    expect(await lockoutIn(w.dash)).toBeNull(); // not locked until the fifth
    expect((await loginState(w.dash))[0].locked).toBe(false);
    expect(await complete(w.dash, null)).toBe(false);

    const until = (await lockoutIn(w.dash))!;
    const minutes = (until.getTime() - Date.now()) / 60000;
    expect(minutes).toBeGreaterThan(14); expect(minutes).toBeLessThanOrEqual(15.1);
    expect((await loginState(w.dash))[0].locked).toBe(true);
    expect(await audits(w.orgA, "user.mfa_locked", w.dash)).toBe(1);
  });

  it("while locked, even a correct code is refused, is NOT used up, and doesn't extend the lock", async () => {
    const before = await row(w.dash);
    expect(await complete(w.dash, 50)).toBe(false);
    expect(await complete(w.dash, null, "rc-a")).toBe(false);
    const after = await row(w.dash);
    expect(Number(after.last_used_step)).toBe(Number(before.last_used_step));
    expect(after.failed_attempts).toBe(before.failed_attempts);
    expect(after.locked_until).toEqual(before.locked_until);
    expect((await codes(w.dash)).every((c) => c.used_at === null)).toBe(true); // recovery codes untouched too
  });

  it("when the lock has run out a correct code works and clears the count; a wrong one locks again at once", async () => {
    await adminPool.query("UPDATE user_mfa SET locked_until = now() - interval '1 minute' WHERE user_id=$1", [w.dash]);
    expect(await complete(w.dash, null)).toBe(false); // wrong code after the lock expired: back to locked (count was already 5)
    expect((await lockoutIn(w.dash))!.getTime()).toBeGreaterThan(Date.now());

    await adminPool.query("UPDATE user_mfa SET locked_until = now() - interval '1 minute' WHERE user_id=$1", [w.dash]);
    expect(await complete(w.dash, 60)).toBe(true);
    const r = await row(w.dash);
    expect(r.failed_attempts).toBe(0);
    expect(r.locked_until).toBeNull();
  });

  it("a success resets the count, so scattered mistakes never add up to a lock", async () => {
    await enableFor(w.tLead, 1);
    for (let i = 0; i < 4; i++) await complete(w.tLead, null);
    expect(await complete(w.tLead, 2)).toBe(true);
    for (let i = 0; i < 4; i++) await complete(w.tLead, null);
    expect(await lockoutIn(w.tLead)).toBeNull();
  });

  it("a replayed code counts as a failed attempt", async () => {
    await enableFor(w.contrib, 20);
    await complete(w.contrib, 21);
    expect((await row(w.contrib)).failed_attempts).toBe(0);
    await complete(w.contrib, 21);
    expect((await row(w.contrib)).failed_attempts).toBe(1);
  });

  it("a recovery code works once; using it again is a failed attempt", async () => {
    await enableFor(w.viewer, 1, hashes("good-1", "good-2"));
    expect(await complete(w.viewer, null, "good-1")).toBe(true);
    expect((await codes(w.viewer)).find((c) => c.code_hash === "good-1")!.used_at).not.toBeNull();
    expect((await row(w.viewer)).failed_attempts).toBe(0);
    expect(await complete(w.viewer, null, "good-1")).toBe(false);
    expect((await row(w.viewer)).failed_attempts).toBe(1);
    expect(await complete(w.viewer, null, "good-2")).toBe(true); // the others still work
    expect(await audits(w.orgA, "user.mfa_recovery_code_used", w.viewer)).toBe(2);
    expect(await status(w.viewer)).toEqual({ enabled: true, recovery_remaining: 0 });
  });

  it("an unknown recovery code is a failed attempt, and one account's code never works for another", async () => {
    await enableFor(w.tDash, 1, hashes("shared-looking-value"));
    await enableFor(w.tLead2, 1, hashes("own-code"));
    expect(await complete(w.tDash, null, "no-such-code")).toBe(false);
    expect((await row(w.tDash)).failed_attempts).toBe(1);
    expect(await complete(w.tLead2, null, "shared-looking-value")).toBe(false); // belongs to tDash, not tLead2
    expect(await complete(w.tDash, null, "shared-looking-value")).toBe(true);
  });

  it("a recovery code can sit alongside a valid authenticator step without being spent by it", async () => {
    await enableFor(w.adminB, 1, hashes("keep-me"));
    expect(await complete(w.adminB, 2)).toBe(true);
    expect((await codes(w.adminB))[0].used_at).toBeNull();
  });

  it("is refused for an account that is not active, hasn't finished enrolling, or never enrolled", async () => {
    await enableFor(w.leadB, 1);
    await adminPool.query("UPDATE users SET status='disabled' WHERE id=$1", [w.leadB]);
    expect(await complete(w.leadB, 5)).toBe(false);
    expect(await loginState(w.leadB)).toEqual([]);

    await begin(w.tLeadB, "pending"); // pending, never confirmed
    expect(await complete(w.tLeadB, 5)).toBe(false);
    const stranger = (await adminPool.query("SELECT gen_random_uuid() AS id")).rows[0].id as string;
    expect(await complete(stranger, 5)).toBe(false);
  });

  it("the login state hands out only the encrypted secret, and only to an enrolled, active account", async () => {
    const s = await loginState(w.auditor);
    expect(s).toHaveLength(1);
    expect(s[0].secret_enc).toMatch(/^ct-/);
    expect(s[0].locked).toBe(false);
  });

  it("the audit chain is still intact after all of that", async () => {
    expect(await chainOk(w.orgA)).toBe(true);
  });
});

describe("turning it off, and replacing recovery codes", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("turning it off removes the secret and every recovery code, and is audited", async () => {
    await enableFor(w.auditor, 1, hashes("a", "b"));
    expect(await disable(w.auditor)).toBe(true);
    expect(await row(w.auditor)).toBeUndefined();
    expect(await codes(w.auditor)).toEqual([]);
    expect(await status(w.auditor)).toEqual({ enabled: false, recovery_remaining: 0 });
    expect(await isEnabled(w.auditor)).toBe(false);
    expect(await complete(w.auditor, 99)).toBe(false);
    expect(await audits(w.orgA, "user.mfa_disabled", w.auditor)).toBe(1);
  });

  it("it can be switched on again afterwards with a fresh secret", async () => {
    await begin(w.auditor, "second-time");
    expect(await confirm(w.auditor, 7, hashes("c"))).toBe(true);
    expect(await loginState(w.auditor)).toEqual([{ secret_enc: "second-time", locked: false }]);
  });

  it("with nothing to turn off it says so; cancelling an unfinished enrolment removes it quietly", async () => {
    expect(await disable(w.lead)).toBe(false);
    await begin(w.lead, "never-finished");
    expect(await disable(w.lead)).toBe(false);
    expect(await row(w.lead)).toBeUndefined();
    expect(await audits(w.orgA, "user.mfa_disabled", w.lead)).toBe(0);
  });

  it("regenerating recovery codes makes the old ones stop working", async () => {
    await enableFor(w.readOnly, 1, hashes("old-1", "old-2"));
    expect(await replaceCodes(w.readOnly, hashes("new-1", "new-2", "new-3"))).toBe(true);
    expect(await complete(w.readOnly, null, "old-1")).toBe(false);
    expect(await complete(w.readOnly, null, "new-1")).toBe(true);
    expect(await status(w.readOnly)).toEqual({ enabled: true, recovery_remaining: 2 });
    expect(await audits(w.orgA, "user.mfa_recovery_codes_regenerated", w.readOnly)).toBe(1);
  });

  it("regenerating needs it to be on, and needs at least one new code", async () => {
    expect(await replaceCodes(w.dash, hashes("x"))).toBe(false); // not enabled
    await denied(replaceCodes(w.readOnly, []), /MFA_NEEDS_RECOVERY_CODES/);
    await denied(replaceCodes(w.readOnly, null), /MFA_NEEDS_RECOVERY_CODES/);
    expect((await codes(w.readOnly)).length).toBe(3); // untouched by the refused attempts
  });

  it("each person can only turn off or change their own", async () => {
    await enableFor(w.contrib, 1, hashes("mine"));
    await disable(w.viewer); await replaceCodes(w.viewer, hashes("evil"));
    expect(await isEnabled(w.contrib)).toBe(true);
    expect((await codes(w.contrib)).map((c) => c.code_hash)).toEqual(["mine"]);
  });
});

describe("an organisation admin resetting someone else's two-step sign-in", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("switches it off, ends the person's existing sessions, and is audited against the admin", async () => {
    await enableFor(w.auditor, 1, hashes("r1"));
    const issuedBefore = new Date(Date.now() - 120_000);
    expect((await withoutUser(appPool, (c) => c.query("SELECT auth_session_valid($1,$2) AS ok", [w.auditor, issuedBefore]))).rows[0].ok).toBe(true);

    expect(await adminReset(w.admin, w.auditor)).toBe(true);

    expect(await isEnabled(w.auditor)).toBe(false);
    expect(await row(w.auditor)).toBeUndefined();
    expect(await codes(w.auditor)).toEqual([]);
    expect((await withoutUser(appPool, (c) => c.query("SELECT auth_session_valid($1,$2) AS ok", [w.auditor, issuedBefore]))).rows[0].ok).toBe(false);
    expect(await audits(w.orgA, "user.mfa_reset", w.admin)).toBe(1);
    const entry = (await adminPool.query("SELECT entity_id FROM audit_log WHERE org_id=$1 AND action='user.mfa_reset'", [w.orgA])).rows[0];
    expect(entry.entity_id).toBe(w.auditor);
    expect(await chainOk(w.orgA)).toBe(true);
  });

  it("does nothing (and ends no sessions) for someone who didn't have it on", async () => {
    const issuedBefore = new Date(Date.now() - 120_000);
    expect(await adminReset(w.admin, w.lead)).toBe(false);
    expect((await withoutUser(appPool, (c) => c.query("SELECT auth_session_valid($1,$2) AS ok", [w.lead, issuedBefore]))).rows[0].ok).toBe(true);
  });

  it("is refused for every role except organisation admin", async () => {
    await enableFor(w.readOnly, 1);
    for (const actor of [w.lead, w.auditor, w.dash, w.tLead, w.contrib]) {
      await denied(adminReset(actor, w.readOnly), /FORBIDDEN_ROLE/);
    }
    expect(await isEnabled(w.readOnly)).toBe(true);
  });

  it("is refused for someone in another organisation, and says the same thing as for an unknown id", async () => {
    await enableFor(w.adminB, 1);
    await denied(adminReset(w.admin, w.adminB), /You don't have access to do that/);
    const stranger = (await adminPool.query("SELECT gen_random_uuid() AS id")).rows[0].id as string;
    await denied(adminReset(w.admin, stranger), /You don't have access to do that/);
    expect(await isEnabled(w.adminB)).toBe(true);
  });

  it("is refused for one's own account (that needs the password and a code, in Security settings)", async () => {
    await enableFor(w.admin, 1);
    await denied(adminReset(w.admin, w.admin), /own two-step sign-in/);
    expect(await isEnabled(w.admin)).toBe(true);
  });

  it("an admin who is disabled, or nobody at all, cannot reset anything", async () => {
    await enableFor(w.contrib, 1);
    await denied(withoutUser(appPool, (c) => c.query("SELECT mfa_admin_reset($1)", [w.contrib])), /FORBIDDEN_ROLE/);
    await adminPool.query("UPDATE users SET status='disabled' WHERE id=$1", [w.admin]);
    await denied(adminReset(w.admin, w.contrib), /FORBIDDEN_ROLE/);
    await adminPool.query("UPDATE users SET status='active' WHERE id=$1", [w.admin]);
    expect(await isEnabled(w.contrib)).toBe(true);
  });
});

describe("auth_lookup_by_id", () => {
  it("returns the same facts as the lookup by email, for the second sign-in step and 'confirm your password'", async () => {
    const w = await makeWorld();
    await adminPool.query("UPDATE users SET password_hash='h' WHERE id=$1", [w.lead]);
    const r = await withoutUser(appPool, (c) => c.query("SELECT * FROM auth_lookup_by_id($1)", [w.lead]));
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ id: w.lead, org_id: w.orgA, role: "lead_auditor", status: "active", password_hash: "h", failed_login_count: 0 });
    const none = await withoutUser(appPool, (c) => c.query("SELECT * FROM auth_lookup_by_id(gen_random_uuid())"));
    expect(none.rows).toEqual([]);
  });
});

describe("mfa_org_status: who has two-step sign-in on", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); await enableFor(w.auditor, 1); await enableFor(w.adminB, 1); await begin(w.readOnly, "pending-only"); });
  const orgStatus = (user: string) => as(user, (c) => c.query("SELECT * FROM mfa_org_status()")).then((r) => r.rows as Array<{ user_id: string; enabled: boolean }>);

  it("an organisation admin sees every user of their own organisation, with a yes/no", async () => {
    const rows = await orgStatus(w.admin);
    const byId = new Map(rows.map((r) => [r.user_id, r.enabled]));
    expect(byId.get(w.auditor)).toBe(true);
    expect(byId.get(w.lead)).toBe(false);
    expect(byId.get(w.readOnly)).toBe(false); // an unfinished enrolment is not "on"
    expect(byId.has(w.tLead)).toBe(true); // tenant users of the organisation too
    expect(Object.keys(rows[0]).sort()).toEqual(["enabled", "user_id"]); // nothing but a yes/no
  });

  it("never shows another organisation's users", async () => {
    const rows = await orgStatus(w.admin);
    expect(rows.map((r) => r.user_id)).not.toContain(w.adminB);
    expect(rows.map((r) => r.user_id)).not.toContain(w.leadB);
  });

  it("everyone else gets nothing", async () => {
    for (const user of [w.lead, w.auditor, w.readOnly, w.dash, w.tLead, w.contrib]) expect(await orgStatus(user)).toEqual([]);
    expect((await withoutUser(appPool, (c) => c.query("SELECT * FROM mfa_org_status()"))).rows).toEqual([]);
  });

  it("a disabled admin gets nothing either", async () => {
    await adminPool.query("UPDATE users SET status='disabled' WHERE id=$1", [w.admin]);
    expect(await orgStatus(w.admin)).toEqual([]);
  });
});
