import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { adminPool, appPool, makeWorld, as, denied, type World } from "./helpers.ts";
import { withoutUser } from "../src/db/pool.ts";

afterAll(async () => { await adminPool.end(); await appPool.end(); });

describe("built-in auth: database layer", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("auth_lookup_by_email works with no session context (true pre-login state)", async () => {
    const r = await withoutUser(appPool, (c) => c.query("SELECT * FROM auth_lookup_by_email($1)", [`admin@audit-a-${w.tag}.test`]));
    expect(r.rows[0].id).toBe(w.admin);
    expect(r.rows[0].status).toBe("active");
  });

  it("is case-insensitive and returns nothing for an unknown email, without erroring", async () => {
    const email = `admin@audit-a-${w.tag}.test`;
    const mixed = await withoutUser(appPool, (c) => c.query("SELECT id FROM auth_lookup_by_email($1)", [email.toUpperCase()]));
    expect(mixed.rowCount).toBe(1);
    const unknown = await withoutUser(appPool, (c) => c.query("SELECT id FROM auth_lookup_by_email('nobody@nowhere.test')"));
    expect(unknown.rowCount).toBe(0);
  });

  it("a plain unauthenticated SELECT on users still returns nothing — RLS filters it to empty, same as everywhere else", async () => {
    const r = await withoutUser(appPool, (c) => c.query("SELECT count(*)::int AS n FROM users"));
    expect(r.rows[0].n).toBe(0);
    // joining straight to the users table bypasses nothing: RLS still filters it to zero rows
    const joined = await withoutUser(appPool, (c) => c.query("SELECT u.id, u.email, u.role FROM auth_lookup_by_email('x@x.test') AS x JOIN users u ON u.id = x.id"));
    expect(joined.rowCount).toBe(0);
  });

  it("login failure counting locks the account after 5 attempts, and success resets it", async () => {
    for (let i = 0; i < 4; i++) await withoutUser(appPool, (c) => c.query("SELECT auth_record_login_failure($1)", [w.admin]));
    let row = await withoutUser(appPool, (c) => c.query("SELECT * FROM auth_lookup_by_email($1)", [`admin@audit-a-${w.tag}.test`]));
    expect(row.rows[0].failed_login_count).toBe(4);
    expect(row.rows[0].locked_until).toBeNull();
    await withoutUser(appPool, (c) => c.query("SELECT auth_record_login_failure($1)", [w.admin]));
    row = await withoutUser(appPool, (c) => c.query("SELECT * FROM auth_lookup_by_email($1)", [`admin@audit-a-${w.tag}.test`]));
    expect(row.rows[0].failed_login_count).toBe(5);
    expect(new Date(row.rows[0].locked_until).getTime()).toBeGreaterThan(Date.now());
    await withoutUser(appPool, (c) => c.query("SELECT auth_record_login_success($1)", [w.admin]));
    row = await withoutUser(appPool, (c) => c.query("SELECT * FROM auth_lookup_by_email($1)", [`admin@audit-a-${w.tag}.test`]));
    expect(row.rows[0].failed_login_count).toBe(0);
    expect(row.rows[0].locked_until).toBeNull();
  });

  it("an authenticated user can set their own invite token (ordinary RLS path)", async () => {
    const r = await as(w.admin, (c) =>
      c.query("UPDATE users SET invite_token_hash = 'abc123', invite_token_expires_at = now() + interval '7 days' WHERE id = $1 RETURNING id", [w.lead]));
    expect(r.rowCount).toBe(1);
  });

  it("the invite token lookup and completion work with no session context, and consume the token exactly once", async () => {
    await adminPool.query("UPDATE users SET invite_token_hash = 'tok-hash-1', invite_token_expires_at = now() + interval '1 day' WHERE id = $1", [w.auditor]);
    const found = await withoutUser(appPool, (c) => c.query("SELECT * FROM auth_lookup_by_invite_token('tok-hash-1')"));
    expect(found.rows[0].id).toBe(w.auditor);

    const completed = await withoutUser(appPool, (c) => c.query("SELECT auth_complete_invite('tok-hash-1', 'bcrypt-hash-here') AS id"));
    expect(completed.rows[0].id).toBe(w.auditor);
    const after = await adminPool.query("SELECT password_hash, status, invite_token_hash FROM users WHERE id = $1", [w.auditor]);
    expect(after.rows[0]).toEqual({ password_hash: "bcrypt-hash-here", status: "active", invite_token_hash: null });

    // the token is single-use: completing it again does nothing
    const again = await withoutUser(appPool, (c) => c.query("SELECT auth_complete_invite('tok-hash-1', 'different-hash') AS id"));
    expect(again.rows[0].id).toBeNull();
  });

  it("an expired invite token cannot be completed", async () => {
    await adminPool.query("UPDATE users SET invite_token_hash = 'tok-expired', invite_token_expires_at = now() - interval '1 hour' WHERE id = $1", [w.readOnly]);
    const r = await withoutUser(appPool, (c) => c.query("SELECT auth_complete_invite('tok-expired', 'x') AS id"));
    expect(r.rows[0].id).toBeNull();
    const row = await adminPool.query("SELECT password_hash FROM users WHERE id = $1", [w.readOnly]);
    expect(row.rows[0].password_hash).toBeNull();
  });

  it("password_hash, failed_login_count and locked_until can never be set via an ordinary authenticated UPDATE — only the SECURITY DEFINER functions reach them", async () => {
    await denied(as(w.admin, (c) => c.query("UPDATE users SET password_hash = 'forged' WHERE id = $1", [w.lead])), /permission denied/);
    await denied(as(w.admin, (c) => c.query("UPDATE users SET failed_login_count = 0 WHERE id = $1", [w.lead])), /permission denied/);
    await denied(as(w.admin, (c) => c.query("UPDATE users SET locked_until = NULL WHERE id = $1", [w.lead])), /permission denied/);
    // ordinary profile fields (unaffected by the narrowed grant) still work as before
    const ok = await as(w.admin, (c) => c.query("UPDATE users SET full_name = 'Renamed' WHERE id = $1 RETURNING full_name", [w.lead]));
    expect(ok.rows[0].full_name).toBe("Renamed");
  });
});
