import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { adminPool, appPool, as, makeWorld, denied, type World } from "./helpers.ts";
import { withoutUser } from "../src/db/pool.ts";

afterAll(async () => { await adminPool.end(); await appPool.end(); });

// ---- thin wrappers over the SQL functions, the way the application calls them -------------------------------
/** A string shaped like a real bcrypt hash ($2b$, cost 12, 53 characters of salt+hash). `tag` must be [./A-Za-z0-9]. */
const bc = (tag: string, prefix = "$2b$12$") => prefix + (tag + "a".repeat(53)).slice(0, 53);
const setHash = (users: string[], hash: string) => adminPool.query("UPDATE users SET password_hash=$2 WHERE id = ANY($1)", [users, hash]);
const change = (user: string, oldHash: string | null, newHash: string | null) =>
  as(user, (c) => c.query("SELECT auth_change_password($1,$2) AS at", [oldHash, newHash])).then((r) => r.rows[0].at as Date | null);
const account = async (user: string) =>
  (await adminPool.query("SELECT password_hash, failed_login_count, locked_until, sessions_valid_after FROM users WHERE id=$1", [user])).rows[0];
const sessionOk = (user: string, issuedAt: Date) =>
  withoutUser(appPool, (c) => c.query("SELECT auth_session_valid($1,$2) AS ok", [user, issuedAt])).then((r) => r.rows[0].ok as boolean);

const policyOf = async (org: string) => (await adminPool.query("SELECT mfa_policy AS p FROM orgs WHERE id=$1", [org])).rows[0].p as string;
const setPolicyRaw = (org: string, p: string) => adminPool.query("UPDATE orgs SET mfa_policy=$2 WHERE id=$1", [org, p]);
const setPolicy = (user: string, p: string | null) => as(user, (c) => c.query("SELECT org_set_mfa_policy($1) AS changed", [p])).then((r) => r.rows[0].changed as boolean);
const getPolicy = (user: string) => as(user, (c) => c.query("SELECT * FROM mfa_policy_get()")).then((r) => r.rows as Array<Record<string, unknown>>);
const requirement = (user: string | null) =>
  withoutUser(appPool, (c) => c.query("SELECT * FROM mfa_requirement($1)", [user])).then((r) => r.rows as Array<{ required: boolean; enabled: boolean }>);
const disable = (user: string) => as(user, (c) => c.query("SELECT mfa_disable() AS ok")).then((r) => r.rows[0].ok as boolean);
const adminReset = (actor: string, target: string) => as(actor, (c) => c.query("SELECT mfa_admin_reset($1) AS ok", [target])).then((r) => r.rows[0].ok as boolean);

/** Turns two-step sign-in fully on for a user, the way the signed-in person would. */
async function enableMfa(user: string) {
  await as(user, (c) => c.query("SELECT mfa_begin_enrollment($1)", [`ct-${user.slice(0, 6)}`]));
  expect((await as(user, (c) => c.query("SELECT mfa_confirm_enrollment($1,$2) AS ok", [100, ["rc-a", "rc-b"]]))).rows[0].ok).toBe(true);
}
const beginOnly = (user: string) => as(user, (c) => c.query("SELECT mfa_begin_enrollment($1)", [`pending-${user.slice(0, 6)}`]));
const mfaOn = async (user: string) => (await adminPool.query("SELECT enabled_at FROM user_mfa WHERE user_id=$1", [user])).rows[0]?.enabled_at != null;
const recoveryLeft = async (user: string) => (await adminPool.query("SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE user_id=$1 AND used_at IS NULL", [user])).rows[0].n as number;

const audits = async (org: string, action: string, actor?: string) =>
  (await adminPool.query("SELECT count(*)::int AS n FROM audit_log WHERE org_id=$1 AND action=$2" + (actor ? " AND actor_id=$3" : ""), actor ? [org, action, actor] : [org, action])).rows[0].n as number;
const auditChanges = async (org: string, action: string) =>
  (await adminPool.query("SELECT change FROM audit_log WHERE org_id=$1 AND action=$2 ORDER BY seq", [org, action])).rows.map((r) => r.change as Record<string, unknown>);
const chainOk = async (org: string) => (await adminPool.query("SELECT verify_audit_chain($1) AS bad", [org])).rows[0].bad === null;

// ====================================================================================================================
describe("the organisation's policy setting", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("starts as 'off' for every organisation", async () => {
    expect(await policyOf(w.orgA)).toBe("off");
    expect(await policyOf(w.orgB)).toBe("off");
  });

  it("only accepts off, staff or everyone", async () => {
    for (const bad of ["all", "EVERYONE", "", "on", "staff,everyone"]) {
      await denied(adminPool.query("UPDATE orgs SET mfa_policy=$2 WHERE id=$1", [w.orgA, bad]), /orgs_mfa_policy_check/);
    }
    await denied(adminPool.query("UPDATE orgs SET mfa_policy=NULL WHERE id=$1", [w.orgA]), /not-null|null value/);
    expect(await policyOf(w.orgA)).toBe("off");
  });

  it("cannot be changed directly by the application's role, even by an organisation admin", async () => {
    await denied(as(w.admin, (c) => c.query("UPDATE orgs SET mfa_policy='everyone' WHERE id=$1", [w.orgA])), /permission denied/);
    await denied(as(w.admin, (c) => c.query("UPDATE orgs SET mfa_policy='staff'")), /permission denied/);
    expect(await policyOf(w.orgA)).toBe("off");
  });

  it("does not disturb the settings an admin can still change directly", async () => {
    await as(w.admin, (c) => c.query("UPDATE orgs SET name='Renamed Org A' WHERE id=$1", [w.orgA]));
    expect((await adminPool.query("SELECT name FROM orgs WHERE id=$1", [w.orgA])).rows[0].name).toBe("Renamed Org A");
  });

  it("can be read by people in the organisation, about their own organisation only", async () => {
    await setPolicyRaw(w.orgB, "everyone");
    const mine = await as(w.auditor, (c) => c.query("SELECT id, mfa_policy FROM orgs"));
    expect(mine.rows).toEqual([{ id: w.orgA, mfa_policy: "off" }]);
    await setPolicyRaw(w.orgB, "off");
  });
});

// ====================================================================================================================
describe("changing your own password: auth_change_password", () => {
  let w: World;
  const OLD = bc("OldHash0001"), NEW = bc("NewHash0002");
  beforeAll(async () => { w = await makeWorld(); });

  it("sets the new hash, clears the lock-out, ends older sessions, and says when", async () => {
    await setHash([w.auditor], OLD);
    await adminPool.query("UPDATE users SET failed_login_count=3, locked_until=now()+interval '5 minutes' WHERE id=$1", [w.auditor]);
    const at = await change(w.auditor, OLD, NEW);
    expect(at).toBeInstanceOf(Date);
    const a = await account(w.auditor);
    expect(a.password_hash).toBe(NEW);
    expect(a.failed_login_count).toBe(0);
    expect(a.locked_until).toBeNull();
    expect(a.sessions_valid_after.getTime()).toBe(at!.getTime());
  });

  it("revokes every session issued before the change but not the one issued at (or after) that moment", async () => {
    await setHash([w.lead], OLD);
    const at = (await change(w.lead, OLD, NEW))!;
    const sec = Math.floor(at.getTime() / 1000) * 1000;
    expect(await sessionOk(w.lead, new Date(sec - 1000))).toBe(false);
    expect(await sessionOk(w.lead, new Date(sec - 3_600_000))).toBe(false);
    expect(await sessionOk(w.lead, new Date(sec))).toBe(true);
    expect(await sessionOk(w.lead, new Date(sec + 60_000))).toBe(true);
  });

  it("is written to the audit log (and the log's chain stays intact), without any password material", async () => {
    await setHash([w.readOnly], OLD);
    const before = await audits(w.orgA, "user.password_changed", w.readOnly);
    await change(w.readOnly, OLD, NEW);
    expect(await audits(w.orgA, "user.password_changed", w.readOnly)).toBe(before + 1);
    const rows = (await adminPool.query("SELECT action, entity, entity_id, change::text AS change FROM audit_log WHERE org_id=$1 AND action='user.password_changed' AND actor_id=$2", [w.orgA, w.readOnly])).rows;
    expect(rows[0]).toMatchObject({ entity: "user", entity_id: w.readOnly, change: "{}" });
    const everything = (await adminPool.query("SELECT row_to_json(a)::text AS t FROM audit_log a WHERE org_id=$1", [w.orgA])).rows.map((r) => r.t).join("\n");
    expect(everything).not.toContain(OLD);
    expect(everything).not.toContain(NEW);
    expect(await chainOk(w.orgA)).toBe(true);
  });

  it("does nothing if the stored hash is no longer the one that was verified (a stale or replayed proof)", async () => {
    await setHash([w.dash], OLD);
    const stale = bc("SomethingElse3");
    const sessionsBefore = (await account(w.dash)).sessions_valid_after;
    const auditsBefore = await audits(w.orgA, "user.password_changed", w.dash);
    expect(await change(w.dash, stale, NEW)).toBeNull();
    expect(await change(w.dash, null, NEW)).toBeNull();
    const a = await account(w.dash);
    expect(a.password_hash).toBe(OLD);
    expect(a.sessions_valid_after).toEqual(sessionsBefore);
    expect(await audits(w.orgA, "user.password_changed", w.dash)).toBe(auditsBefore);
  });

  it("works once per proof: a second use of the same old hash changes nothing", async () => {
    await setHash([w.tLead], OLD);
    expect(await change(w.tLead, OLD, NEW)).toBeInstanceOf(Date);
    const later = bc("LaterHash0004");
    expect(await change(w.tLead, OLD, later)).toBeNull();
    expect((await account(w.tLead)).password_hash).toBe(NEW);
    expect(await change(w.tLead, NEW, later)).toBeInstanceOf(Date); // the real current hash works
    expect((await account(w.tLead)).password_hash).toBe(later);
  });

  it("only ever acts for the signed-in person: someone else's hash is no use, and nobody else is touched", async () => {
    await setHash([w.contrib], bc("ContribHash05"));
    await setHash([w.viewer], bc("ViewerHash006"));
    const viewerBefore = await account(w.viewer);
    // contrib presents viewer's real hash as the "old" one: refused, nothing changes for either.
    expect(await change(w.contrib, bc("ViewerHash006"), NEW)).toBeNull();
    expect((await account(w.contrib)).password_hash).toBe(bc("ContribHash05"));
    expect(await account(w.viewer)).toEqual(viewerBefore);
    // a real change by contrib leaves viewer (same org, same tenant) and everyone else alone.
    expect(await change(w.contrib, bc("ContribHash05"), NEW)).toBeInstanceOf(Date);
    expect(await account(w.viewer)).toEqual(viewerBefore);
    expect((await account(w.tDash)).sessions_valid_after).toBeNull();
    expect((await account(w.adminB)).sessions_valid_after).toBeNull();
  });

  it("needs someone signed in", async () => {
    await denied(withoutUser(appPool, (c) => c.query("SELECT auth_change_password($1,$2)", [OLD, NEW])), /FORBIDDEN_ROLE/);
  });

  it("does nothing for an account that is disabled or has no password held here", async () => {
    await setHash([w.tDash], OLD);
    await adminPool.query("UPDATE users SET status='disabled' WHERE id=$1", [w.tDash]);
    expect(await change(w.tDash, OLD, NEW)).toBeNull();
    expect((await account(w.tDash)).password_hash).toBe(OLD);

    // an account with no password (single sign-in only) can't gain one this way, whatever it passes as "old"
    expect((await account(w.tLead2)).password_hash).toBeNull();
    expect(await change(w.tLead2, null, NEW)).toBeNull();
    expect(await change(w.tLead2, "", NEW)).toBeNull();
    expect((await account(w.tLead2)).password_hash).toBeNull();
  });

  it("only stores something that looks like a bcrypt hash — never blank, never plain text", async () => {
    await setHash([w.adminB], OLD);
    const ok2a = bc("Aa", "$2a$10$"), ok2y = bc("Yy", "$2y$12$");
    for (const bad of [null, "", "hunter2hunter2", "plain text password!", "$2b$12$tooshort", bc("X").slice(0, -1), bc("X") + "a", "$2c$12$" + "a".repeat(53), "$2b$1$" + "a".repeat(53), bc("X").replace("$2b$", "2b$"), bc("has space").replace(/a/g, " ")]) {
      await denied(change(w.adminB, OLD, bad), /VALIDATION/);
      expect((await account(w.adminB)).password_hash).toBe(OLD);
    }
    expect(await change(w.adminB, OLD, ok2a)).toBeInstanceOf(Date);
    expect(await change(w.adminB, ok2a, ok2y)).toBeInstanceOf(Date);
    expect((await account(w.adminB)).password_hash).toBe(ok2y);
  });

  it("is atomic with its audit entry: nothing is changed when the new hash is refused", async () => {
    await setHash([w.leadB], OLD);
    const before = await audits(w.orgB, "user.password_changed");
    await denied(change(w.leadB, OLD, "nope"), /VALIDATION/);
    expect(await audits(w.orgB, "user.password_changed")).toBe(before);
    expect((await account(w.leadB)).sessions_valid_after).toBeNull();
  });
});

// ====================================================================================================================
describe("who the policy covers: mfa_requirement", () => {
  let w: World;
  beforeAll(async () => {
    w = await makeWorld();
    await setHash([w.admin, w.lead, w.auditor, w.tLead, w.contrib, w.adminB, w.tLeadB], bc("Seed0000001"));
  });

  it("covers nobody while the policy is off", async () => {
    await setPolicyRaw(w.orgA, "off");
    for (const u of [w.admin, w.auditor, w.tLead, w.contrib]) expect(await requirement(u)).toEqual([{ required: false, enabled: false }]);
  });

  it("'staff' covers the organisation's own people and not clients", async () => {
    await setPolicyRaw(w.orgA, "staff");
    for (const u of [w.admin, w.lead, w.auditor]) expect((await requirement(u))[0].required).toBe(true);
    for (const u of [w.tLead, w.contrib]) expect((await requirement(u))[0].required).toBe(false);
  });

  it("'everyone' covers clients too", async () => {
    await setPolicyRaw(w.orgA, "everyone");
    for (const u of [w.admin, w.auditor, w.tLead, w.contrib]) expect((await requirement(u))[0].required).toBe(true);
  });

  it("never covers an account with no password held here (it signs in through single sign-on)", async () => {
    await setPolicyRaw(w.orgA, "everyone");
    expect(await requirement(w.viewer)).toEqual([{ required: false, enabled: false }]);
    expect(await requirement(w.readOnly)).toEqual([{ required: false, enabled: false }]);
  });

  it("never covers a disabled account", async () => {
    await setPolicyRaw(w.orgA, "everyone");
    await adminPool.query("UPDATE users SET status='disabled' WHERE id=$1", [w.contrib]);
    expect((await requirement(w.contrib))[0].required).toBe(false);
    await adminPool.query("UPDATE users SET status='active' WHERE id=$1", [w.contrib]);
    expect((await requirement(w.contrib))[0].required).toBe(true);
  });

  it("says whether two-step sign-in is set up — a pending enrolment does not count", async () => {
    await setPolicyRaw(w.orgA, "everyone");
    expect((await requirement(w.lead))[0].enabled).toBe(false);
    await beginOnly(w.lead);
    expect(await requirement(w.lead)).toEqual([{ required: true, enabled: false }]);
    await as(w.lead, (c) => c.query("SELECT mfa_confirm_enrollment($1,$2)", [7, ["rc-1"]]));
    expect(await requirement(w.lead)).toEqual([{ required: true, enabled: true }]);
  });

  it("follows each person's own organisation's policy", async () => {
    await setPolicyRaw(w.orgA, "everyone");
    await setPolicyRaw(w.orgB, "off");
    expect((await requirement(w.adminB))[0].required).toBe(false);
    expect((await requirement(w.tLeadB))[0].required).toBe(false);
    await setPolicyRaw(w.orgB, "staff");
    expect((await requirement(w.adminB))[0].required).toBe(true);
    expect((await requirement(w.tLeadB))[0].required).toBe(false);
    await setPolicyRaw(w.orgA, "off");
    expect((await requirement(w.admin))[0].required).toBe(false);
    expect((await requirement(w.adminB))[0].required).toBe(true);
  });

  it("gives no answer for an unknown account", async () => {
    expect(await requirement("00000000-0000-4000-8000-000000000000")).toEqual([]);
    expect(await requirement(null)).toEqual([]);
  });
});

// ====================================================================================================================
describe("the policy and progress, for an organisation admin: mfa_policy_get", () => {
  let w: World;
  beforeAll(async () => {
    w = await makeWorld();
    // password holders: staff = admin, lead, auditor; clients = tLead, contrib. Not counted: viewer (disabled), readOnly (no password).
    await setHash([w.admin, w.lead, w.auditor, w.tLead, w.contrib, w.viewer], bc("Seed0000002"));
    await adminPool.query("UPDATE users SET status='disabled' WHERE id=$1", [w.viewer]);
    await enableMfa(w.lead); await enableMfa(w.tLead);
    await setHash([w.adminB, w.leadB, w.tLeadB], bc("Seed0000003"));
  });

  it("gives an organisation admin the policy and the numbers", async () => {
    expect(await getPolicy(w.admin)).toEqual([{ out_policy: "off", out_staff_total: 3, out_staff_enrolled: 1, out_all_total: 5, out_all_enrolled: 2 }]);
    await setPolicyRaw(w.orgA, "staff");
    expect((await getPolicy(w.admin))[0].out_policy).toBe("staff");
    await setPolicyRaw(w.orgA, "off");
  });

  it("gives everyone else nothing", async () => {
    for (const u of [w.lead, w.auditor, w.readOnly, w.dash, w.tLead, w.contrib, w.viewer, w.tDash]) expect(await getPolicy(u)).toEqual([]);
    expect(await withoutUser(appPool, (c) => c.query("SELECT * FROM mfa_policy_get()")).then((r) => r.rows)).toEqual([]);
  });

  it("is about the admin's own organisation only", async () => {
    expect(await getPolicy(w.adminB)).toEqual([{ out_policy: "off", out_staff_total: 2, out_staff_enrolled: 0, out_all_total: 3, out_all_enrolled: 0 }]);
  });

  it("counts people as they enrol, disable or leave — and not a set-up that was started but never finished", async () => {
    await beginOnly(w.auditor);
    expect((await getPolicy(w.admin))[0]).toMatchObject({ out_staff_enrolled: 1, out_all_enrolled: 2 });
    await enableMfa(w.auditor);
    expect((await getPolicy(w.admin))[0]).toMatchObject({ out_staff_enrolled: 2, out_all_enrolled: 3 });
    await adminPool.query("UPDATE users SET status='disabled' WHERE id=$1", [w.contrib]);
    expect((await getPolicy(w.admin))[0]).toMatchObject({ out_staff_total: 3, out_all_total: 4 });
    await adminPool.query("UPDATE users SET status='active' WHERE id=$1", [w.contrib]);
  });

  it("is refused to an admin whose own account is no longer active", async () => {
    await adminPool.query("UPDATE users SET status='disabled' WHERE id=$1", [w.leadB]);
    await adminPool.query("UPDATE users SET role='org_admin' WHERE id=$1", [w.leadB]);
    expect(await getPolicy(w.leadB)).toEqual([]);
  });
});

// ====================================================================================================================
describe("changing the policy: org_set_mfa_policy", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("is for organisation admins only", async () => {
    for (const u of [w.lead, w.auditor, w.readOnly, w.dash, w.tLead, w.contrib]) {
      await denied(setPolicy(u, "off"), /FORBIDDEN_ROLE/);
      await denied(setPolicy(u, "staff"), /FORBIDDEN_ROLE/);
    }
    await denied(withoutUser(appPool, (c) => c.query("SELECT org_set_mfa_policy('off')")), /FORBIDDEN_ROLE/);
    expect(await policyOf(w.orgA)).toBe("off");
  });

  it("is refused to a disabled admin", async () => {
    await enableMfa(w.adminB);
    await adminPool.query("UPDATE users SET status='disabled' WHERE id=$1", [w.adminB]);
    await denied(setPolicy(w.adminB, "staff"), /FORBIDDEN_ROLE/);
    await adminPool.query("UPDATE users SET status='active' WHERE id=$1", [w.adminB]);
    expect(await policyOf(w.orgB)).toBe("off");
  });

  it("only accepts off, staff or everyone", async () => {
    await enableMfa(w.admin);
    for (const bad of [null, "all", "on", "", "Staff", "staff "]) {
      await denied(setPolicy(w.admin, bad), /VALIDATION/);
    }
    expect(await policyOf(w.orgA)).toBe("off");
  });

  it("will not switch the policy on for an admin who hasn't turned two-step sign-in on themselves", async () => {
    await adminPool.query("DELETE FROM user_mfa WHERE user_id=$1", [w.admin]); // back to having none
    await denied(setPolicy(w.admin, "staff"), /MFA_ADMIN_NEEDS_MFA/);
    await denied(setPolicy(w.admin, "everyone"), /MFA_ADMIN_NEEDS_MFA/);
    expect(await policyOf(w.orgA)).toBe("off");
    // a half-finished enrolment doesn't count
    await beginOnly(w.admin);
    await denied(setPolicy(w.admin, "staff"), /MFA_ADMIN_NEEDS_MFA/);
    expect(await policyOf(w.orgA)).toBe("off");
  });

  it("lets any admin switch it OFF, with or without two-step sign-in of their own", async () => {
    await adminPool.query("DELETE FROM user_mfa WHERE user_id=$1", [w.admin]);
    await setPolicyRaw(w.orgA, "everyone");
    expect(await setPolicy(w.admin, "off")).toBe(true);
    expect(await policyOf(w.orgA)).toBe("off");
    expect(await setPolicy(w.admin, "off")).toBe(false);
  });

  it("changes the policy, says whether anything changed, and records who changed what", async () => {
    await adminPool.query("DELETE FROM user_mfa WHERE user_id=$1", [w.admin]);
    await enableMfa(w.admin);
    const before = await audits(w.orgA, "org.mfa_policy_changed");
    expect(await setPolicy(w.admin, "staff")).toBe(true);
    expect(await policyOf(w.orgA)).toBe("staff");
    expect(await setPolicy(w.admin, "staff")).toBe(false); // already so: no change, no audit entry
    expect(await audits(w.orgA, "org.mfa_policy_changed")).toBe(before + 1);
    expect(await setPolicy(w.admin, "everyone")).toBe(true);
    expect(await setPolicy(w.admin, "off")).toBe(true);
    expect(await policyOf(w.orgA)).toBe("off");

    const changes = (await auditChanges(w.orgA, "org.mfa_policy_changed")).slice(before);
    expect(changes).toEqual([{ from: "off", to: "staff" }, { from: "staff", to: "everyone" }, { from: "everyone", to: "off" }]);
    expect(await audits(w.orgA, "org.mfa_policy_changed", w.admin)).toBe(before + 3);
    expect(await chainOk(w.orgA)).toBe(true);
  });

  it("only changes the admin's own organisation", async () => {
    expect(await mfaOn(w.adminB)).toBe(true); // turned on in an earlier test
    expect(await setPolicy(w.adminB, "everyone")).toBe(true);
    expect(await policyOf(w.orgB)).toBe("everyone");
    expect(await policyOf(w.orgA)).toBe("off");
    expect(await setPolicy(w.admin, "staff")).toBe(true);
    expect(await policyOf(w.orgB)).toBe("everyone");
    expect(await policyOf(w.orgA)).toBe("staff");
    expect(await audits(w.orgB, "org.mfa_policy_changed")).toBe(1);
    await setPolicyRaw(w.orgA, "off"); await setPolicyRaw(w.orgB, "off");
  });

  it("doesn't touch anyone's own two-step settings when the policy changes", async () => {
    await adminPool.query("DELETE FROM user_mfa WHERE user_id = ANY($1)", [[w.admin, w.lead]]);
    await enableMfa(w.admin); await enableMfa(w.lead);
    const codes = await recoveryLeft(w.lead);
    await setPolicy(w.admin, "everyone");
    expect(await mfaOn(w.lead)).toBe(true);
    expect(await recoveryLeft(w.lead)).toBe(codes);
    await setPolicyRaw(w.orgA, "off");
  });
});

// ====================================================================================================================
describe("two-step sign-in can't be turned off by someone the policy covers: mfa_disable", () => {
  let w: World;
  beforeAll(async () => {
    w = await makeWorld();
    await setHash([w.admin, w.auditor, w.tLead, w.contrib, w.lead], bc("Seed0000004"));
    await enableMfa(w.admin);
  });

  it("is refused for a covered person who has it on, and nothing is lost or recorded", async () => {
    await enableMfa(w.auditor);
    await setPolicyRaw(w.orgA, "staff");
    const before = await audits(w.orgA, "user.mfa_disabled");
    await denied(disable(w.auditor), /MFA_REQUIRED_BY_POLICY/);
    expect(await mfaOn(w.auditor)).toBe(true);
    expect(await recoveryLeft(w.auditor)).toBe(2);
    expect(await audits(w.orgA, "user.mfa_disabled")).toBe(before);
  });

  it("is refused for an admin too (they can switch the policy off first)", async () => {
    await setPolicyRaw(w.orgA, "staff");
    await denied(disable(w.admin), /MFA_REQUIRED_BY_POLICY/);
    expect(await mfaOn(w.admin)).toBe(true);
  });

  it("still works for someone the policy doesn't cover", async () => {
    await enableMfa(w.tLead);
    await setPolicyRaw(w.orgA, "staff"); // staff only: clients are not covered
    expect(await disable(w.tLead)).toBe(true);
    expect(await mfaOn(w.tLead)).toBe(false);
  });

  it("covers clients when the policy says everyone", async () => {
    await enableMfa(w.contrib);
    await setPolicyRaw(w.orgA, "everyone");
    await denied(disable(w.contrib), /MFA_REQUIRED_BY_POLICY/);
    expect(await mfaOn(w.contrib)).toBe(true);
  });

  it("still works when the policy is off, and once an admin has switched the policy off", async () => {
    await setPolicyRaw(w.orgA, "off");
    expect(await disable(w.contrib)).toBe(true);
    await enableMfa(w.contrib);
    await setPolicyRaw(w.orgA, "everyone");
    await denied(disable(w.contrib), /MFA_REQUIRED_BY_POLICY/);
    expect(await setPolicy(w.admin, "off")).toBe(true);
    expect(await disable(w.contrib)).toBe(true);
  });

  it("lets a covered person cancel an enrolment they have not finished (nothing is being switched off)", async () => {
    await setPolicyRaw(w.orgA, "everyone");
    await beginOnly(w.lead);
    expect(await disable(w.lead)).toBe(false);
    expect((await adminPool.query("SELECT count(*)::int AS n FROM user_mfa WHERE user_id=$1", [w.lead])).rows[0].n).toBe(0);
  });

  it("does not cover an account with no password held here", async () => {
    await adminPool.query("UPDATE users SET password_hash=NULL WHERE id=$1", [w.contrib]);
    await enableMfa(w.contrib);
    await setPolicyRaw(w.orgA, "everyone");
    expect(await disable(w.contrib)).toBe(true);
  });

  it("still leaves the one way out: an admin resetting the person, who then has to set it up again", async () => {
    await setHash([w.auditor], bc("Seed0000005"));
    await setPolicyRaw(w.orgA, "staff");
    expect(await mfaOn(w.auditor)).toBe(true);
    expect(await adminReset(w.admin, w.auditor)).toBe(true);
    expect(await mfaOn(w.auditor)).toBe(false);
    expect(await requirement(w.auditor)).toEqual([{ required: true, enabled: false }]);
    expect(await chainOk(w.orgA)).toBe(true);
  });

  it("changes nothing else about how turning it off works when the policy doesn't apply", async () => {
    await setPolicyRaw(w.orgA, "off");
    await enableMfa(w.auditor);
    const before = await audits(w.orgA, "user.mfa_disabled", w.auditor);
    expect(await disable(w.auditor)).toBe(true);
    expect(await recoveryLeft(w.auditor)).toBe(0);
    expect(await audits(w.orgA, "user.mfa_disabled", w.auditor)).toBe(before + 1);
    expect(await disable(w.auditor)).toBe(false); // nothing left to turn off
  });
});
