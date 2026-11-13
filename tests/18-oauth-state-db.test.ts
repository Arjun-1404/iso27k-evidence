import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { adminPool, appPool, as, makeWorld, denied, type World } from "./helpers.ts";
import { withoutUser } from "../src/db/pool.ts";

afterAll(async () => { await adminPool.end(); await appPool.end(); });

describe("oauth_states: database layer", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("an org admin can create a state row, scoped to their own org automatically", async () => {
    const r = await as(w.admin, (c) =>
      c.query("INSERT INTO oauth_states (org_id, actor_id, provider, state_hash, expires_at) SELECT org_id, $1, 'google_drive', 'state-hash-1', now() + interval '10 minutes' FROM users WHERE id = $1 RETURNING id", [w.admin]));
    expect(r.rowCount).toBe(1);
  });

  it("nobody but an org admin can start an OAuth flow", async () => {
    for (const u of [w.lead, w.auditor, w.tLead]) {
      await denied(as(u, (c) =>
        c.query("INSERT INTO oauth_states (org_id, actor_id, provider, state_hash, expires_at) VALUES ($1,$2,'google_drive','x',now()+interval '10 minutes')", [w.orgA, u])), /row-level security/);
    }
  });

  it("the callback (no session) can consume a valid state exactly once", async () => {
    await adminPool.query(
      "INSERT INTO oauth_states (org_id, actor_id, provider, state_hash, expires_at) VALUES ($1,$2,'google_drive','consume-me',now()+interval '10 minutes')",
      [w.orgA, w.admin]);
    const first = await withoutUser(appPool, (c) => c.query("SELECT * FROM oauth_state_consume('consume-me')"));
    expect(first.rows[0]).toEqual({ org_id: w.orgA, actor_id: w.admin, provider: "google_drive" });

    const second = await withoutUser(appPool, (c) => c.query("SELECT * FROM oauth_state_consume('consume-me')"));
    expect(second.rowCount).toBe(0);
  });

  it("an expired state cannot be consumed", async () => {
    await adminPool.query(
      "INSERT INTO oauth_states (org_id, actor_id, provider, state_hash, expires_at) VALUES ($1,$2,'google_drive','expired-one',now()-interval '1 minute')",
      [w.orgA, w.admin]);
    const r = await withoutUser(appPool, (c) => c.query("SELECT * FROM oauth_state_consume('expired-one')"));
    expect(r.rowCount).toBe(0);
  });

  it("an unknown state is simply not found, no error", async () => {
    const r = await withoutUser(appPool, (c) => c.query("SELECT * FROM oauth_state_consume('never-existed')"));
    expect(r.rowCount).toBe(0);
  });

  it("a plain unauthenticated SELECT on oauth_states still returns nothing — the function is the only door", async () => {
    const r = await withoutUser(appPool, (c) => c.query("SELECT count(*)::int AS n FROM oauth_states"));
    expect(r.rows[0].n).toBe(0);
  });

  it("org B cannot see org A's oauth_states rows", async () => {
    const r = await as(w.adminB, (c) => c.query("SELECT count(*)::int AS n FROM oauth_states"));
    expect(r.rows[0].n).toBe(0);
  });
});

describe("oauth_complete_connection: atomic consume-and-write", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("writes the storage connection using the org derived from the state, and consumes the state", async () => {
    await adminPool.query(
      "INSERT INTO oauth_states (org_id, actor_id, provider, state_hash, expires_at) VALUES ($1,$2,'google_drive','complete-1',now()+interval '10 minutes')",
      [w.orgA, w.admin]);
    const r = await withoutUser(appPool, (c) =>
      c.query("SELECT * FROM oauth_complete_connection('complete-1', 'encrypted-ref-abc', 'svc-account@project.iam')"));
    expect(r.rows[0].out_org_id).toBe(w.orgA);
    expect(r.rows[0].out_actor_id).toBe(w.admin);
    expect(r.rows[0].out_provider).toBe("google_drive");

    const row = await adminPool.query("SELECT org_id, provider, token_ref, account_label, status FROM storage_connections WHERE id = $1", [r.rows[0].out_connection_id]);
    expect(row.rows[0]).toEqual({ org_id: w.orgA, provider: "google_drive", token_ref: "encrypted-ref-abc", account_label: "svc-account@project.iam", status: "active" });

    // the state is single-use, same as oauth_state_consume
    const again = await withoutUser(appPool, (c) => c.query("SELECT * FROM oauth_complete_connection('complete-1', 'other-ref', null)"));
    expect(again.rowCount).toBe(0);
  });

  it("reconnecting (a second valid state for the same org+provider) replaces the token reference, not a duplicate row", async () => {
    await adminPool.query(
      "INSERT INTO oauth_states (org_id, actor_id, provider, state_hash, expires_at) VALUES ($1,$2,'google_drive','complete-2',now()+interval '10 minutes')",
      [w.orgA, w.admin]);
    await withoutUser(appPool, (c) => c.query("SELECT * FROM oauth_complete_connection('complete-2', 'new-ref-xyz', null)"));
    const rows = await adminPool.query("SELECT token_ref FROM storage_connections WHERE org_id = $1 AND provider = 'google_drive'", [w.orgA]);
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].token_ref).toBe("new-ref-xyz");
  });

  it("an invalid state writes nothing", async () => {
    const before = await adminPool.query("SELECT count(*)::int AS n FROM storage_connections");
    const r = await withoutUser(appPool, (c) => c.query("SELECT * FROM oauth_complete_connection('never-existed', 'ref', null)"));
    expect(r.rowCount).toBe(0);
    const after = await adminPool.query("SELECT count(*)::int AS n FROM storage_connections");
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("an EXPIRED state writes nothing, logs nothing, and is left unconsumed", async () => {
    // Own world so the "nothing written" assertions can't be confused by other tests' rows.
    const w2 = await makeWorld();
    await adminPool.query(
      "INSERT INTO oauth_states (org_id, actor_id, provider, state_hash, expires_at) VALUES ($1,$2,'google_drive','complete-expired',now()-interval '1 minute')",
      [w2.orgA, w2.admin]);

    const r = await withoutUser(appPool, (c) => c.query("SELECT * FROM oauth_complete_connection('complete-expired', 'must-not-be-stored', null)"));
    expect(r.rowCount).toBe(0);

    const conns = await adminPool.query("SELECT count(*)::int AS n FROM storage_connections WHERE org_id = $1", [w2.orgA]);
    expect(conns.rows[0].n).toBe(0);
    const logs = await adminPool.query("SELECT count(*)::int AS n FROM audit_log WHERE org_id = $1 AND action = 'org.storage_connected'", [w2.orgA]);
    expect(logs.rows[0].n).toBe(0);
    const st = await adminPool.query("SELECT consumed_at FROM oauth_states WHERE state_hash = 'complete-expired'");
    expect(st.rows[0].consumed_at).toBeNull();
  });

  it("the resulting connection is visible through the normal authenticated read path, and only to that org", async () => {
    await adminPool.query(
      "INSERT INTO oauth_states (org_id, actor_id, provider, state_hash, expires_at) VALUES ($1,$2,'google_drive','complete-3',now()+interval '10 minutes')",
      [w.orgA, w.admin]);
    await withoutUser(appPool, (c) => c.query("SELECT * FROM oauth_complete_connection('complete-3', 'visible-ref', null)"));
    const own = await as(w.admin, (c) => c.query("SELECT token_ref FROM storage_connections WHERE provider = 'google_drive'"));
    expect(own.rows[0].token_ref).toBeTruthy();
    const other = await as(w.adminB, (c) => c.query("SELECT count(*)::int AS n FROM storage_connections"));
    expect(other.rows[0].n).toBe(0);
  });
});
