import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { adminPool, appPool, as, makeWorld, type World } from "./helpers.ts";
import { setPlatformOwner } from "../src/db/platformOwner.ts";

/**
 * Who becomes the owner of an installation, and how it is handed over. These run as the database owner (like
 * db:bootstrap-admin), because the application's own role must never be able to hand the power out.
 */

const URL = "postgres://postgres@127.0.0.1:54329/portal_test";
const BOOTSTRAP = resolve(__dirname, "../src/db/bootstrap-admin-cli.ts");
const GRANT = resolve(__dirname, "../src/db/grant-platform-owner-cli.ts");
const TSX = resolve(__dirname, "../node_modules/.bin/tsx");

let w: World;
beforeAll(async () => { w = await makeWorld(); await adminPool.query("UPDATE users SET is_platform_owner=false WHERE is_platform_owner"); });
afterAll(async () => { await adminPool.query("UPDATE users SET is_platform_owner=false WHERE is_platform_owner"); await adminPool.end(); await appPool.end(); });

const owners = async () => (await adminPool.query("SELECT id FROM users WHERE is_platform_owner ORDER BY id")).rows.map((r) => r.id as string);
const emailOf = async (id: string) => (await adminPool.query("SELECT email FROM users WHERE id=$1", [id])).rows[0].email as string;
const isOwner = (id: string) => as(id, (c) => c.query("SELECT platform_is_owner() AS o")).then((r) => r.rows[0].o as boolean);
const run = (script: string, env: Record<string, string>) =>
  spawnSync(TSX, [script], { encoding: "utf8", env: { ...process.env, DATABASE_URL: URL, APP_BASE_URL: "https://portal.example", ...env } });

describe("handing over the ownership of the installation", () => {
  it("makes one organisation admin the only owner, and says who stopped being one", async () => {
    const adminEmail = await emailOf(w.admin); const adminBEmail = await emailOf(w.adminB);
    const first = await setPlatformOwner(adminPool, adminEmail);
    expect(first).toEqual({ userId: w.admin, email: adminEmail, previousOwners: [] });
    expect(await owners()).toEqual([w.admin]);
    expect(await isOwner(w.admin)).toBe(true);

    const second = await setPlatformOwner(adminPool, adminBEmail);
    expect(second.previousOwners).toEqual([adminEmail]);
    expect(await owners()).toEqual([w.adminB]);
    expect(await isOwner(w.admin)).toBe(false); // the old owner lost the power with the flag
    expect(await isOwner(w.adminB)).toBe(true);
  });

  it("doesn't mind capital letters or spaces in the address", async () => {
    const e = await emailOf(w.admin);
    await setPlatformOwner(adminPool, `  ${e.toUpperCase()} `);
    expect(await owners()).toEqual([w.admin]);
  });

  it("handing it to the current owner changes nothing", async () => {
    const e = await emailOf(w.admin);
    await setPlatformOwner(adminPool, e);
    const again = await setPlatformOwner(adminPool, e);
    expect(again.previousOwners).toEqual([]);
    expect(await owners()).toEqual([w.admin]);
  });

  it("refuses someone who isn't an organisation admin, who is disabled, or who doesn't exist — and changes nothing", async () => {
    await setPlatformOwner(adminPool, await emailOf(w.admin));
    await expect(setPlatformOwner(adminPool, await emailOf(w.lead))).rejects.toThrow(/not an organisation admin/);
    await expect(setPlatformOwner(adminPool, await emailOf(w.tLead))).rejects.toThrow(/not an organisation admin/);
    await expect(setPlatformOwner(adminPool, "nobody@nowhere.test")).rejects.toThrow(/No user with the email/);
    await adminPool.query("UPDATE users SET status='disabled' WHERE id=$1", [w.adminB]);
    try {
      await expect(setPlatformOwner(adminPool, await emailOf(w.adminB))).rejects.toThrow(/is disabled/);
    } finally { await adminPool.query("UPDATE users SET status='active' WHERE id=$1", [w.adminB]); }
    expect(await owners()).toEqual([w.admin]);
  });

  it("is not something the application's own database role can do", async () => {
    await expect(setPlatformOwner(appPool, await emailOf(w.admin))).rejects.toThrow();
    await expect(as(w.admin, (c) => c.query("UPDATE users SET is_platform_owner = true WHERE id = $1", [w.admin]))).rejects.toThrow(/permission denied/);
  });
});

describe("the command-line tools", () => {
  it("grant-platform-owner hands the ownership over and says so", async () => {
    await setPlatformOwner(adminPool, await emailOf(w.admin));
    const target = await emailOf(w.adminB);
    const r = run(GRANT, { ADMIN_EMAIL: target });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`${target} is now the owner of this installation.`);
    expect(r.stdout).toContain(await emailOf(w.admin)); // names the previous owner
    expect(await owners()).toEqual([w.adminB]);
  });

  it("grant-platform-owner explains a refusal and exits with an error", async () => {
    const r = run(GRANT, { ADMIN_EMAIL: await emailOf(w.lead) });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not an organisation admin/);
    const missing = run(GRANT, { ADMIN_EMAIL: "" });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/ADMIN_EMAIL/);
  });

  it("the first administrator of a fresh installation becomes its owner; the second organisation's is not", async () => {
    await adminPool.query("UPDATE users SET is_platform_owner=false WHERE is_platform_owner");
    const tag = Math.random().toString(36).slice(2, 8);
    const first = run(BOOTSTRAP, { ORG_NAME: `Firm ${tag}`, ORG_DOMAIN: `firm-${tag}.test`, ADMIN_EMAIL: `boss@firm-${tag}.test` });
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toMatch(/They are the owner of this installation/);
    expect(first.stdout).toMatch(/https:\/\/portal\.example\/accept-invite\?token=/);
    const id = (await adminPool.query("SELECT id FROM users WHERE email=$1", [`boss@firm-${tag}.test`])).rows[0].id as string;
    expect(await owners()).toEqual([id]);

    const second = run(BOOTSTRAP, { ORG_NAME: `Other ${tag}`, ORG_DOMAIN: `other-${tag}.test`, ADMIN_EMAIL: `boss@other-${tag}.test` });
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toMatch(/already has an owner, so they are an ordinary organisation admin/);
    expect(await owners()).toEqual([id]);
  });

  it("bootstrap doesn't hand the ownership to an administrator it refuses to create", async () => {
    const dup = await emailOf(w.admin);
    const before = await owners();
    const r = run(BOOTSTRAP, { ORG_NAME: "Dup", ORG_DOMAIN: "dup.test", ADMIN_EMAIL: dup });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/already exists/);
    expect(await owners()).toEqual(before);
  });
});
