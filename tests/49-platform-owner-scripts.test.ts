import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { adminPool, appPool, as, makeWorld, type World } from "./helpers.ts";
import { setPlatformOwner } from "../src/db/platformOwner.ts";
import { databaseHint } from "../src/db/failureHints.ts";

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
  it("bootstrap-admin, run as the restricted portal_app role by mistake, creates nothing and says to use the database owner", async () => {
    const before = (await adminPool.query("SELECT count(*)::int AS n FROM orgs")).rows[0].n as number;
    const r = run(BOOTSTRAP, { DATABASE_URL: "postgres://portal_app@127.0.0.1:54329/portal_test", ORG_NAME: "Wrong Role Org", ORG_DOMAIN: "wrong-role.example", ADMIN_EMAIL: "wrong-role@wrong-role.example" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Bootstrap failed: permission denied for table orgs/);
    expect(r.stderr).toContain("must connect as the database owner");
    expect(r.stderr).toContain("postgres://postgres:");
    expect((await adminPool.query("SELECT count(*)::int AS n FROM orgs")).rows[0].n).toBe(before);
    expect((await adminPool.query("SELECT 1 FROM users WHERE email='wrong-role@wrong-role.example'")).rowCount).toBe(0);
  });

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

/**
 * "password authentication failed" is what a Docker user sees when .env was regenerated after the database volume
 * already existed (PostgreSQL keeps the password it was first started with). The commands say what that means and what to do.
 */
describe("a database that refuses the password", () => {
  it("the hint names the cause and both ways out, for Docker and without it; other errors get none", () => {
    const hint = databaseHint({ code: "28P01" })!;
    expect(hint).toMatch(/keeps the password it was first created with/);
    expect(hint).toContain("docker compose down -v");
    expect(hint).toContain("docker compose up -d");
    expect(hint).toContain("ALTER USER postgres PASSWORD");
    expect(databaseHint({ code: "42501" })).toBeNull();
    expect(databaseHint(new Error("boom"))).toBeNull();
    expect(databaseHint(null)).toBeNull();
  });

  /** A stand-in for PostgreSQL that answers every connection the way a server with a different password does. */
  function refusingServer(): Promise<{ port: number; close: () => void }> {
    const field = (tag: string, v: string) => Buffer.concat([Buffer.from(tag), Buffer.from(v + "\0")]);
    const body = Buffer.concat([field("S", "FATAL"), field("V", "FATAL"), field("C", "28P01"), field("M", 'password authentication failed for user "postgres"'), Buffer.from("\0")]);
    const msg = Buffer.concat([Buffer.from("E"), Buffer.alloc(4), body]);
    msg.writeInt32BE(body.length + 4, 1);
    return new Promise((ok) => {
      const srv = net.createServer((sock) => { sock.once("data", () => { sock.end(msg); }); sock.on("error", () => {}); });
      srv.listen(0, "127.0.0.1", () => ok({ port: (srv.address() as net.AddressInfo).port, close: () => srv.close() }));
    });
  }

  it("db:migrate, db:bootstrap-admin and db:grant-platform-owner print it under the raw error, and exit non-zero", async () => {
    const srv = await refusingServer();
    try {
      const url = `postgres://postgres:0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f50617@127.0.0.1:${srv.port}/x`;
      const env = { DATABASE_URL: url, APP_DB_PASSWORD: "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928", ORG_NAME: "X", ORG_DOMAIN: "x.example", ADMIN_EMAIL: "a@x.example" };
      for (const [script, label] of [[resolve(__dirname, "../src/db/migrate-cli.ts"), "Migration failed"], [BOOTSTRAP, "Bootstrap failed"], [GRANT, "Failed"]]) {
        // Not spawnSync: that would freeze this process, and the stand-in server lives in it.
        const r = await new Promise<{ status: number | null; stderr: string }>((done) => {
          const child = spawn(TSX, [script], { env: { PATH: process.env.PATH ?? "", ...env } });
          let stderr = ""; child.stderr.on("data", (d) => { stderr += d; });
          const timer = setTimeout(() => child.kill(), 60_000);
          child.on("close", (status) => { clearTimeout(timer); done({ status, stderr }); });
        });
        expect(r.status, script).toBe(1);
        expect(r.stderr, script).toContain(`${label}: password authentication failed for user "postgres"`);
        expect(r.stderr, script).toContain("docker compose down -v");
      }
    } finally { srv.close(); }
  });

  it("the README tells a Docker user what to do when migrate fails, inside the Linux (with Docker) section", () => {
    const readme = readFileSync(resolve(__dirname, "../README.md"), "utf8");
    const section = readme.slice(readme.indexOf("### 4. Linux (with Docker)"), readme.indexOf("### 5. Linux (without Docker)"));
    expect(section).toContain("service \"migrate\" didn't complete successfully");
    expect(section).toContain("docker compose logs migrate | tail -5");
    expect(section).toContain("password authentication failed for user \"postgres\"");
    expect(section).toContain("docker compose down -v");
    expect(section).toMatch(/is still the example text from \.env\.example/);
  });
});
