import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { adminPool, appPool, as, makeWorld, denied, type World } from "./helpers.ts";

afterAll(async () => { await adminPool.end(); await appPool.end(); });

/**
 * The application's database role must not be able to read or write the secret columns of `users`, whoever it is
 * acting for. (Login, invites, password reset and the like reach them only through SECURITY DEFINER functions.)
 */
const SECRET_COLUMNS = ["password_hash", "invite_token_hash", "invite_token_expires_at", "failed_login_count", "locked_until", "sessions_valid_after"];
const PROFILE_COLUMNS = ["id", "org_id", "tenant_id", "email", "full_name", "role", "status", "created_at"];

describe("what the app role can see of a user row", () => {
  let w: World;
  beforeAll(async () => {
    w = await makeWorld();
    await adminPool.query("UPDATE users SET password_hash='A-REAL-LOOKING-HASH', invite_token_hash='SOME-INVITE-HASH' WHERE id=$1", [w.auditor]);
  });

  it.each(SECRET_COLUMNS)("cannot read %s — not another user's, not even the signed-in user's own", async (col) => {
    await denied(as(w.admin, (c) => c.query(`SELECT ${col} FROM users WHERE id = $1`, [w.auditor])));
    await denied(as(w.auditor, (c) => c.query(`SELECT ${col} FROM users WHERE id = $1`, [w.auditor])));
  });

  it("cannot get at them with SELECT * either, nor through a RETURNING clause", async () => {
    await denied(as(w.admin, (c) => c.query("SELECT * FROM users WHERE id = $1", [w.auditor])));
    await denied(as(w.admin, (c) => c.query("UPDATE users SET full_name = full_name WHERE id = $1 RETURNING password_hash", [w.auditor])));
  });

  it("still sees the ordinary profile columns the application is built on", async () => {
    const r = await as(w.admin, (c) => c.query(`SELECT ${PROFILE_COLUMNS.join(", ")} FROM users WHERE id = $1`, [w.auditor]));
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].email).toContain("auditor@");
  });

  it("the column list the policy allows is exactly the profile columns (a new secret column must not slip in unnoticed)", async () => {
    const r = await adminPool.query(
      "SELECT column_name FROM information_schema.column_privileges WHERE table_name='users' AND grantee='portal_app' AND privilege_type='SELECT' ORDER BY 1");
    expect(r.rows.map((x) => x.column_name)).toEqual([...PROFILE_COLUMNS].sort());
  });
});

describe("what the app role can write to a user row", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("cannot create a user with a password already set (an invite is the only way in)", async () => {
    await denied(as(w.admin, (c) => c.query(
      "INSERT INTO users (org_id, email, full_name, role, status, password_hash) VALUES ($1,$2,'X','auditor','active','chosen-by-the-caller')",
      [w.orgA, `sneaky@audit-a-${w.tag}.test`])));
  });

  it.each(["failed_login_count", "locked_until", "sessions_valid_after"])("cannot set %s on a new row", async (col) => {
    const value = col === "failed_login_count" ? "0" : "now()";
    await denied(as(w.admin, (c) => c.query(
      `INSERT INTO users (org_id, email, full_name, role, status, ${col}) VALUES ($1,$2,'X','auditor','invited',${value})`,
      [w.orgA, `sneaky2-${col}@audit-a-${w.tag}.test`])));
  });

  it("can still invite someone — a row with an invite token hash and expiry, and no password", async () => {
    const r = await as(w.admin, (c) => c.query(
      `INSERT INTO users (org_id, email, full_name, role, status, invite_token_hash, invite_token_expires_at)
       VALUES ($1,$2,'Invited','auditor','invited','hash-of-invite', now() + interval '7 days') RETURNING id, email, role, status`,
      [w.orgA, `invitee@audit-a-${w.tag}.test`]));
    expect(r.rows[0].status).toBe("invited");
    const stored = await adminPool.query("SELECT password_hash, invite_token_hash FROM users WHERE id=$1", [r.rows[0].id]);
    expect(stored.rows[0]).toEqual({ password_hash: null, invite_token_hash: "hash-of-invite" });
  });

  it("still cannot overwrite a password hash by updating a row", async () => {
    await denied(as(w.admin, (c) => c.query("UPDATE users SET password_hash = 'x' WHERE id = $1", [w.auditor])));
  });
});

describe("the login-time functions keep working, because they run as the table's owner", () => {
  it("auth_lookup_by_email still returns the password hash to the (signed-out) caller", async () => {
    const w = await makeWorld();
    await adminPool.query("UPDATE users SET password_hash='stored-hash' WHERE id=$1", [w.lead]);
    const email = (await adminPool.query("SELECT email FROM users WHERE id=$1", [w.lead])).rows[0].email;
    const r = await appPool.query("SELECT password_hash, status FROM auth_lookup_by_email($1)", [email]);
    expect(r.rows[0]).toEqual({ password_hash: "stored-hash", status: "active" });
  });
});
