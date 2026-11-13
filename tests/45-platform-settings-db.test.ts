import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { adminPool, appPool, as, makeWorld, denied, type World } from "./helpers.ts";
import { withoutUser } from "../src/db/pool.ts";

/**
 * The database side of "server settings in the web app": who the owner is, and that the settings can be read, saved
 * and removed only by that owner, only through the narrow functions, with secrets kept as ciphertext, every change
 * audited by field name (never value), and the table itself closed to the application's role.
 */

afterAll(async () => {
  await adminPool.query("DELETE FROM platform_settings");
  await adminPool.end(); await appPool.end();
});
beforeEach(async () => { await adminPool.query("DELETE FROM platform_settings"); });

const setOwner = (u: string, on = true) => adminPool.query("UPDATE users SET is_platform_owner=$2 WHERE id=$1", [u, on]);
const isOwner = (u: string) => as(u, (c) => c.query("SELECT platform_is_owner() AS o")).then((r) => r.rows[0].o as boolean);

const save = (u: string, key: unknown, config: unknown, enc: string | null = null, secrets: string[] = [], changed: unknown[] = []) =>
  as(u, (c) => c.query("SELECT platform_setting_save($1,$2::jsonb,$3,$4::text[],$5::text[])", [key, JSON.stringify(config), enc, secrets, changed]));
const read = (u: string) => as(u, (c) => c.query("SELECT * FROM platform_settings_read()")).then((r) => r.rows as Array<Record<string, unknown>>);
const clear = (u: string, key: unknown) => as(u, (c) => c.query("SELECT platform_setting_clear($1) AS gone", [key])).then((r) => r.rows[0].gone as boolean);
const load = () => withoutUser(appPool, (c) => c.query("SELECT * FROM platform_settings_load()")).then((r) => r.rows as Array<Record<string, unknown>>);

const EMAIL = { host: "mail.example.test", port: 587, security: "starttls", user: "mailer", from: "Portal <noreply@firm.example>" };
const CIPHER = "v1:abcdefABCDEF0123456789==";
const rows = async () => (await adminPool.query("SELECT * FROM platform_settings ORDER BY key")).rows as Array<Record<string, unknown>>;
const audits = async (org: string, action: string) =>
  (await adminPool.query("SELECT actor_id, entity, entity_id, change FROM audit_log WHERE org_id=$1 AND action=$2 ORDER BY seq", [org, action])).rows as Array<Record<string, unknown>>;
const chainOk = async (org: string) => (await adminPool.query("SELECT verify_audit_chain($1) AS bad", [org])).rows[0].bad === null;

// ====================================================================================================================
describe("who the owner is", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("nobody is the owner until the server's operator makes them one", async () => {
    for (const u of [w.admin, w.lead, w.auditor, w.adminB, w.tLead]) expect(await isOwner(u), u).toBe(false);
  });

  it("an active organisation admin with the flag is the owner", async () => {
    await setOwner(w.admin);
    try {
      expect(await isOwner(w.admin)).toBe(true);
      expect(await isOwner(w.adminB)).toBe(false); // another organisation's admin is not
      expect(await isOwner(w.lead)).toBe(false);
    } finally { await setOwner(w.admin, false); }
  });

  it("the flag alone is not enough: the person must be an active organisation admin", async () => {
    await setOwner(w.lead);
    try {
      expect(await isOwner(w.lead)).toBe(false); // not an org admin
    } finally { await setOwner(w.lead, false); }

    await setOwner(w.adminB);
    try {
      expect(await isOwner(w.adminB)).toBe(true);
      await adminPool.query("UPDATE users SET status='disabled' WHERE id=$1", [w.adminB]);
      expect(await isOwner(w.adminB)).toBe(false); // disabled
      await adminPool.query("UPDATE users SET status='active' WHERE id=$1", [w.adminB]);
      expect(await isOwner(w.adminB)).toBe(true);
      await adminPool.query("UPDATE users SET role='lead_auditor' WHERE id=$1", [w.adminB]);
      expect(await isOwner(w.adminB)).toBe(false); // no longer an org admin
    } finally {
      await adminPool.query("UPDATE users SET role='org_admin' WHERE id=$1", [w.adminB]);
      await setOwner(w.adminB, false);
    }
  });

  it("nobody who isn't signed in is the owner", async () => {
    await setOwner(w.admin);
    try {
      const r = await withoutUser(appPool, (c) => c.query("SELECT platform_is_owner() AS o"));
      expect(r.rows[0].o).toBe(false);
    } finally { await setOwner(w.admin, false); }
  });

  it("the application's role can neither read nor set the flag, on anyone", async () => {
    await denied(as(w.admin, (c) => c.query("SELECT is_platform_owner FROM users")), /permission denied/);
    await denied(as(w.admin, (c) => c.query("SELECT * FROM users")), /permission denied/);
    await denied(as(w.admin, (c) => c.query("UPDATE users SET is_platform_owner=true WHERE id=$1", [w.admin])), /permission denied/);
    await denied(as(w.admin, (c) => c.query("UPDATE users SET is_platform_owner=true")), /permission denied/);
    await denied(as(w.admin, (c) => c.query(
      "INSERT INTO users (org_id, email, role, status, is_platform_owner) VALUES ($1,$2,'org_admin','invited',true)", [w.orgA, `x-${w.tag}@audit-a-${w.tag}.test`])), /permission denied/);
    expect(await isOwner(w.admin)).toBe(false);
  });

  it("an organisation admin cannot hand themselves ownership by inviting or editing people", async () => {
    // The ordinary column-limited update still works for the columns it always allowed...
    await as(w.admin, (c) => c.query("UPDATE users SET full_name='Renamed Auditor' WHERE id=$1", [w.auditor]));
    // ...and ownership did not come with it.
    expect((await adminPool.query("SELECT count(*)::int AS n FROM users WHERE org_id=$1 AND is_platform_owner", [w.orgA])).rows[0].n).toBe(0);
  });
});

// ====================================================================================================================
describe("the settings table itself", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); await setOwner(w.admin); });

  it("is closed to the application's role: no reading, writing or deleting, even for the owner", async () => {
    await adminPool.query(`INSERT INTO platform_settings (key, config) VALUES ('scanner', '{"host":"clamav","port":3310}')`);
    await denied(as(w.admin, (c) => c.query("SELECT * FROM platform_settings")), /permission denied/);
    await denied(as(w.admin, (c) => c.query("SELECT key FROM platform_settings")), /permission denied/);
    await denied(as(w.admin, (c) => c.query(`INSERT INTO platform_settings (key, config) VALUES ('email', '{}')`)), /permission denied/);
    await denied(as(w.admin, (c) => c.query("UPDATE platform_settings SET config='{}'")), /permission denied/);
    await denied(as(w.admin, (c) => c.query("DELETE FROM platform_settings")), /permission denied/);
    await denied(withoutUser(appPool, (c) => c.query("SELECT * FROM platform_settings")), /permission denied/);
    expect((await rows())).toHaveLength(1);
  });

  it("has row-level security switched on as a second lock", async () => {
    const r = await adminPool.query("SELECT relrowsecurity FROM pg_class WHERE relname='platform_settings'");
    expect(r.rows[0].relrowsecurity).toBe(true);
  });

  it("only holds the three known groups", async () => {
    for (const k of ["smtp", "EMAIL", "", "other"]) {
      await denied(adminPool.query("INSERT INTO platform_settings (key, config) VALUES ($1,'{}')", [k]), /platform_settings_key_check/);
    }
  });

  it("holds ciphertext exactly when a secret is set, and only that group's own secret names", async () => {
    const ins = (key: string, enc: string | null, set: string[]) =>
      adminPool.query("INSERT INTO platform_settings (key, config, secret_enc, secrets_set) VALUES ($1,'{}',$2,$3::text[])", [key, enc, set]);
    await denied(ins("email", CIPHER, []), /platform_settings_secrets_consistent/);
    await denied(ins("email", null, ["password"]), /platform_settings_secrets_consistent/);
    await denied(ins("email", CIPHER, ["clientSecret"]), /platform_settings_secret_names/);
    await denied(ins("google", CIPHER, ["password"]), /platform_settings_secret_names/);
    await denied(ins("scanner", CIPHER, ["password"]), /platform_settings_secret_names/);
    await denied(ins("email", CIPHER, ["password", "extra"]), /platform_settings_secret_names/);
    await ins("email", CIPHER, ["password"]);
    await adminPool.query("DELETE FROM platform_settings");
    await ins("google", CIPHER, ["clientSecret"]);
    await adminPool.query("DELETE FROM platform_settings");
    await ins("scanner", null, []);
  });

  it("only holds a settings object of reasonable size", async () => {
    await denied(adminPool.query(`INSERT INTO platform_settings (key, config) VALUES ('scanner','[]')`), /platform_settings_config_check/);
    await denied(adminPool.query(`INSERT INTO platform_settings (key, config) VALUES ('scanner','"x"')`), /platform_settings_config_check/);
    await denied(adminPool.query(`INSERT INTO platform_settings (key, config) VALUES ('scanner', $1::jsonb)`, [JSON.stringify({ a: "x".repeat(4100) })]), /platform_settings_config_check/);
  });
});

// ====================================================================================================================
describe("reading, saving and removing settings", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); await setOwner(w.admin); });

  it("the owner can save a group and read it back, without any ciphertext", async () => {
    await save(w.admin, "email", EMAIL, CIPHER, ["password"], ["host", "port", "password"]);
    const r = await read(w.admin);
    expect(r).toHaveLength(1);
    expect(r[0].out_key).toBe("email");
    expect(r[0].out_config).toEqual(EMAIL);
    expect(r[0].out_secrets_set).toEqual(["password"]);
    expect(r[0].out_updated_at).toBeInstanceOf(Date);
    expect(typeof r[0].out_updated_by).toBe("string");
    expect(Object.keys(r[0])).not.toContain("out_secret_enc");
    expect(JSON.stringify(r)).not.toContain(CIPHER);
  });

  it("shows who last changed a group, by address", async () => {
    await save(w.admin, "scanner", { host: "clamav", port: 3310 });
    const email = (await adminPool.query("SELECT email FROM users WHERE id=$1", [w.admin])).rows[0].email;
    expect((await read(w.admin))[0].out_updated_by).toBe(email);
  });

  it("a later save by someone else shows that other person, not the first", async () => {
    await save(w.admin, "scanner", { host: "clamav", port: 3310 });
    const second = (await adminPool.query(
      "INSERT INTO users (org_id, email, role, status) VALUES ($1,$2,'org_admin','active') RETURNING id, email",
      [w.orgA, `second-owner-${w.tag}@audit-a-${w.tag}.test`])).rows[0] as { id: string; email: string };
    await setOwner(w.admin, false); await setOwner(second.id);
    try {
      await save(second.id, "scanner", { host: "clamav2", port: 3310 });
      expect((await read(second.id))[0].out_updated_by).toBe(second.email);
    } finally {
      await setOwner(second.id, false); await setOwner(w.admin);
      await adminPool.query("UPDATE users SET status='disabled' WHERE id=$1", [second.id]);
    }
  });

  it("the running server can load every group, as ciphertext, without anyone signed in", async () => {
    await save(w.admin, "email", EMAIL, CIPHER, ["password"], ["password"]);
    await save(w.admin, "scanner", { host: "clamav", port: 3310 });
    const r = await load();
    expect(r.map((x) => x.out_key).sort()).toEqual(["email", "scanner"]);
    const email = r.find((x) => x.out_key === "email")!;
    expect(email.out_config).toEqual(EMAIL);
    expect(email.out_secret_enc).toBe(CIPHER);
    expect(r.find((x) => x.out_key === "scanner")!.out_secret_enc).toBeNull();
  });

  it("saving again replaces the group, including dropping a secret", async () => {
    await save(w.admin, "email", EMAIL, CIPHER, ["password"], ["password"]);
    await save(w.admin, "email", { ...EMAIL, host: "other.example.test", user: undefined }, null, [], ["host", "user"]);
    const [row] = await rows();
    expect((row.config as { host: string }).host).toBe("other.example.test");
    expect(row.secret_enc).toBeNull();
    expect(row.secrets_set).toEqual([]);
    expect(await rows()).toHaveLength(1);
  });

  it("removing a group deletes it, and says whether there was anything to remove", async () => {
    await save(w.admin, "google", { clientId: "id", redirectUri: "https://p.example/oauth/google/callback" }, CIPHER, ["clientSecret"]);
    expect(await clear(w.admin, "google")).toBe(true);
    expect(await rows()).toHaveLength(0);
    expect(await clear(w.admin, "google")).toBe(false);
    expect(await load()).toEqual([]);
  });

  it("refuses an unknown group, a settings value that is not an object, and mismatched secrets", async () => {
    for (const k of ["smtp", "", "EMAIL", null, "email; DROP TABLE users"]) {
      await denied(save(w.admin, k, EMAIL), /VALIDATION/);
      await denied(clear(w.admin, k), /VALIDATION/);
    }
    await denied(save(w.admin, "email", [EMAIL]), /VALIDATION/);
    await denied(save(w.admin, "email", "text"), /VALIDATION/);
    await denied(save(w.admin, "email", null), /VALIDATION/);
    await denied(save(w.admin, "email", EMAIL, CIPHER, []), /VALIDATION/); // ciphertext but no secret named
    await denied(save(w.admin, "email", EMAIL, null, ["password"]), /VALIDATION/); // a secret named but no ciphertext
    await denied(save(w.admin, "email", EMAIL, CIPHER, ["clientSecret"]), /platform_settings_secret_names/);
    await denied(save(w.admin, "scanner", { host: "x", port: 1 }, CIPHER, ["password"]), /platform_settings_secret_names/);
    expect(await rows()).toHaveLength(0);
  });

  it("refuses ciphertext that is far too large", async () => {
    await denied(save(w.admin, "email", EMAIL, "x".repeat(8001), ["password"]), /platform_settings_secret_enc_check/);
  });
});

// ====================================================================================================================
describe("nobody else can", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); await setOwner(w.admin); });

  it("read, save or remove settings: not another admin, not staff, not a client's person, not another organisation's admin", async () => {
    await save(w.admin, "email", EMAIL, CIPHER, ["password"], ["host"]);
    const before = JSON.stringify(await rows());
    for (const [name, u] of Object.entries({ lead: w.lead, auditor: w.auditor, readOnly: w.readOnly, tLead: w.tLead, contrib: w.contrib, viewer: w.viewer, adminB: w.adminB })) {
      await denied(read(u), /FORBIDDEN_ROLE/);
      await denied(save(u, "email", { ...EMAIL, host: "evil.example.test" }, CIPHER, ["password"], ["host"]), /FORBIDDEN_ROLE/);
      await denied(save(u, "scanner", { host: "evil", port: 1 }), /FORBIDDEN_ROLE/);
      await denied(clear(u, "email"), /FORBIDDEN_ROLE/);
      expect(name).toBeTruthy();
    }
    expect(JSON.stringify(await rows())).toBe(before);
  });

  it("an organisation admin who is not the owner can't, even in the owner's own organisation", async () => {
    const second = (await adminPool.query(
      "INSERT INTO users (org_id, email, role, status) VALUES ($1,$2,'org_admin','active') RETURNING id", [w.orgA, `second-${w.tag}@audit-a-${w.tag}.test`])).rows[0].id as string;
    await denied(read(second), /FORBIDDEN_ROLE/);
    await denied(save(second, "scanner", { host: "x", port: 1 }), /FORBIDDEN_ROLE/);
    await denied(clear(second, "scanner"), /FORBIDDEN_ROLE/);
  });

  it("a person who is not signed in can't", async () => {
    const run = (sql: string, params: unknown[] = []) => withoutUser(appPool, (c) => c.query(sql, params));
    await denied(run("SELECT * FROM platform_settings_read()"), /FORBIDDEN_ROLE/);
    await denied(run("SELECT platform_setting_save('scanner', '{}'::jsonb, NULL, '{}', '{}')"), /FORBIDDEN_ROLE/);
    await denied(run("SELECT platform_setting_clear('scanner')"), /FORBIDDEN_ROLE/);
    expect(await rows()).toHaveLength(0);
  });

  it("a disabled owner can't", async () => {
    await adminPool.query("UPDATE users SET status='disabled' WHERE id=$1", [w.admin]);
    try {
      await denied(read(w.admin), /FORBIDDEN_ROLE/);
      await denied(save(w.admin, "scanner", { host: "x", port: 1 }), /FORBIDDEN_ROLE/);
    } finally { await adminPool.query("UPDATE users SET status='active' WHERE id=$1", [w.admin]); }
  });
});

// ====================================================================================================================
describe("the audit trail", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); await setOwner(w.admin); });

  it("records a save with the field names that changed, and no value", async () => {
    await save(w.admin, "email", EMAIL, CIPHER, ["password"], ["host", "port", "password"]);
    const a = await audits(w.orgA, "platform.setting_saved");
    expect(a).toHaveLength(1);
    expect(a[0].actor_id).toBe(w.admin);
    expect(a[0].entity).toBe("platform_setting");
    expect(a[0].entity_id).toBe("email");
    expect(a[0].change).toEqual({ fields: ["host", "port", "password"] });
    const text = JSON.stringify(a);
    for (const secretish of [CIPHER, EMAIL.host, EMAIL.user, EMAIL.from]) expect(text).not.toContain(secretish);
  });

  it("records a removal, and nothing for removing what was never there", async () => {
    await save(w.admin, "scanner", { host: "clamav", port: 3310 }, null, [], ["host"]);
    const before = (await audits(w.orgA, "platform.setting_cleared")).length;
    expect(await clear(w.admin, "scanner")).toBe(true);
    expect(await clear(w.admin, "scanner")).toBe(false);
    const a = await audits(w.orgA, "platform.setting_cleared");
    expect(a.length - before).toBe(1);
    expect(a[a.length - 1].entity_id).toBe("scanner");
    expect(a[a.length - 1].change).toEqual({});
  });

  it("writes to the owner's own organisation's log, and the chain stays intact", async () => {
    await save(w.admin, "google", { clientId: "id", redirectUri: "https://p.example/oauth/google/callback" }, CIPHER, ["clientSecret"], ["clientId"]);
    expect((await audits(w.orgB, "platform.setting_saved"))).toHaveLength(0);
    expect(await chainOk(w.orgA)).toBe(true);
  });

  it("a refused attempt is not recorded as a change", async () => {
    const before = (await audits(w.orgA, "platform.setting_saved")).length;
    await denied(save(w.lead, "scanner", { host: "x", port: 1 }, null, [], ["host"]), /FORBIDDEN_ROLE/);
    await denied(save(w.admin, "nope", {}), /VALIDATION/);
    expect((await audits(w.orgA, "platform.setting_saved")).length).toBe(before);
  });

  it("accepts only plain field names in the changed list", async () => {
    for (const bad of [[null], ["has space"], ["semi;colon"], ["1starts"], ["x".repeat(41)], ["a'b"], ["a\"b"], [""]]) {
      await denied(save(w.admin, "scanner", { host: "x", port: 1 }, null, [], bad as unknown[]), /VALIDATION/);
    }
    await denied(save(w.admin, "scanner", { host: "x", port: 1 }, null, [], Array.from({ length: 21 }, (_, i) => `f${i}`)), /VALIDATION/);
    await save(w.admin, "scanner", { host: "x", port: 1 }, null, [], ["clientId", "timeout_seconds", "a1"]);
  });
});

// ====================================================================================================================
describe("installations that already have people in them", () => {
  // The statement is taken from the migration actually in use (a breakage run points MIGRATIONS_DIR at a changed copy).
  const backfillSql = () => {
    const dir = process.env.MIGRATIONS_DIR ? path.resolve(process.env.MIGRATIONS_DIR) : path.resolve("db/migrations");
    const sql = fs.readFileSync(path.join(dir, "012_platform_settings.sql"), "utf8");
    return sql.match(/UPDATE users SET is_platform_owner = true[\s\S]*?;\n/)![0];
  };
  const owners = async (c: { query: (q: string) => Promise<{ rows: Array<{ id: string }> }> }) =>
    (await c.query("SELECT id FROM users WHERE is_platform_owner ORDER BY id")).rows.map((r) => r.id);

  it("the migration makes the first active organisation admin the owner, but only if nobody is yet", async () => {
    const w = await makeWorld();
    const backfill = backfillSql();
    const c = await adminPool.connect();
    try {
      await c.query("BEGIN");
      // People who must NOT be chosen even though they are the oldest accounts there are: a disabled organisation
      // admin, and someone who is active but is not an organisation admin.
      await c.query(
        "INSERT INTO users (org_id, email, role, status, created_at) VALUES ($1,$2,'org_admin','disabled','2000-01-01'), ($1,$3,'lead_auditor','active','2000-01-01')",
        [w.orgA, `old-disabled-${w.tag}@audit-a-${w.tag}.test`, `old-lead-${w.tag}@audit-a-${w.tag}.test`]);
      await c.query("UPDATE users SET is_platform_owner = false WHERE is_platform_owner");
      await c.query(backfill);
      const first = (await c.query(
        "SELECT id FROM users WHERE role='org_admin' AND status IN ('active','invited') ORDER BY created_at, id LIMIT 1")).rows[0].id as string;
      expect(await owners(c)).toEqual([first]);

      // Running it again changes nothing: there is an owner now (even if it is someone else).
      await c.query("UPDATE users SET is_platform_owner = false");
      await c.query("UPDATE users SET is_platform_owner = true WHERE id = (SELECT id FROM users WHERE role='org_admin' AND status='active' ORDER BY created_at DESC, id DESC LIMIT 1)");
      const before = await owners(c);
      expect(before).not.toEqual([first]);
      await c.query(backfill);
      expect(await owners(c)).toEqual(before);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });
});
