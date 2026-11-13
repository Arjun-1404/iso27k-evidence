import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "../src/config.ts";
import { AesSecretStore } from "../src/auth/secretStore.ts";

/**
 * `npm run setup` writes the .env for a new installation. What matters: the secrets are real and different from each
 * other, the result is something the server and docker compose actually accept, an existing file is never touched, and
 * the file is private.
 */

const SCRIPT = resolve(__dirname, "../scripts/init-env.mjs");
const TEMPLATE_PATH = resolve(__dirname, "../.env.example");
const TEMPLATE = readFileSync(TEMPLATE_PATH, "utf8");

type Mod = { buildEnv(template: string, opts?: { random?: (bytes: number) => string; appUrl?: string; apiUrl?: string }): string };
const load = async () => (await import(pathToFileURL(SCRIPT).href)) as Mod;

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0) out[t.slice(0, eq)] = t.slice(eq + 1);
  }
  return out;
}
const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "init-env-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("building the .env text", () => {
  it("fills in the four secrets and nothing else is left as a placeholder", async () => {
    const { buildEnv } = await load();
    const vars = parseEnv(buildEnv(TEMPLATE));
    expect(vars.POSTGRES_PASSWORD).toMatch(/^[0-9a-f]{48}$/);
    expect(vars.APP_DB_PASSWORD).toMatch(/^[0-9a-f]{48}$/);
    expect(vars.JWT_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(vars.SECRET_ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(buildEnv(TEMPLATE)).not.toMatch(/change-me/);
  });

  it("uses a different value for every secret, and different ones every time", async () => {
    const { buildEnv } = await load();
    const a = parseEnv(buildEnv(TEMPLATE)); const b = parseEnv(buildEnv(TEMPLATE));
    const secrets = ["POSTGRES_PASSWORD", "APP_DB_PASSWORD", "JWT_SECRET", "SECRET_ENCRYPTION_KEY"] as const;
    expect(new Set(secrets.map((k) => a[k])).size).toBe(4);
    for (const k of secrets) expect(a[k], k).not.toBe(b[k]);
  });

  it("asks for the amount of randomness each secret needs", async () => {
    const { buildEnv } = await load();
    const asked: number[] = [];
    buildEnv(TEMPLATE, { random: (n) => { asked.push(n); return "ab".repeat(n); } });
    expect(asked).toEqual([24, 24, 32, 32]);
  });

  it("keeps every explanation and every other setting exactly as in .env.example", async () => {
    const { buildEnv } = await load();
    const before = TEMPLATE.split("\n"); const after = buildEnv(TEMPLATE).split("\n");
    expect(after).toHaveLength(before.length);
    const changed = before.map((l, i) => [l, after[i]] as const).filter(([x, y]) => x !== y);
    expect(changed.map(([x]) => x.replace(/=.*/, "").replace(/^# /, ""))).toEqual(["POSTGRES_PASSWORD", "APP_DB_PASSWORD", "JWT_SECRET", "SECRET_ENCRYPTION_KEY"]);
  });

  it("produces a configuration the server accepts, with the encryption key it can really use", async () => {
    const { buildEnv } = await load();
    const vars = parseEnv(buildEnv(TEMPLATE));
    const saved = { ...process.env };
    try {
      for (const k of ["JWT_SECRET", "SECRET_ENCRYPTION_KEY", "APP_BASE_URL", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REDIRECT_URI", "CORS_ALLOWED_ORIGINS"]) delete process.env[k];
      Object.assign(process.env, vars, { DATABASE_URL: "postgres://x@localhost/x" });
      const c = loadConfig();
      expect(c.secretEncryptionKey).toBe(vars.SECRET_ENCRYPTION_KEY);
      expect(c.jwtSecret).toBe(vars.JWT_SECRET);
      const store = new AesSecretStore(c.secretEncryptionKey!);
      expect(store.decrypt(store.encrypt("round trip"))).toBe("round trip");
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it("makes passwords that are safe inside the database address docker compose builds from them", async () => {
    const { buildEnv } = await load();
    const vars = parseEnv(buildEnv(TEMPLATE));
    for (const k of ["POSTGRES_PASSWORD", "APP_DB_PASSWORD"]) {
      expect(encodeURIComponent(vars[k]), k).toBe(vars[k]); // nothing that would need escaping in postgres://user:pw@host
    }
  });

  it("only gives the compose file variables it actually passes on", () => {
    const compose = parseYaml(readFileSync(resolve(__dirname, "../docker-compose.yml"), "utf8")) as { services: Record<string, { environment?: Record<string, string> }> };
    const text = JSON.stringify(compose);
    for (const k of ["POSTGRES_PASSWORD", "APP_DB_PASSWORD", "JWT_SECRET", "SECRET_ENCRYPTION_KEY"]) expect(text, k).toContain("${" + k);
    expect(compose.services.api.environment).toHaveProperty("SECRET_ENCRYPTION_KEY");
  });

  it("can set the public addresses, and tidies them", async () => {
    const { buildEnv } = await load();
    const vars = parseEnv(buildEnv(TEMPLATE, { appUrl: "https://portal.example.com/", apiUrl: "https://api.example.com" }));
    expect(vars.APP_BASE_URL).toBe("https://portal.example.com");
    expect(vars.API_PUBLIC_URL).toBe("https://api.example.com");
  });

  it("refuses addresses that wouldn't work, naming the option", async () => {
    const { buildEnv } = await load();
    for (const bad of ["portal.example.com", "ftp://portal.example.com", "https://user:pw@portal.example.com", "https://portal.example.com/?x=1", "https://portal.example.com/#top", ""]) {
      expect(() => buildEnv(TEMPLATE, { appUrl: bad }), bad).toThrow(/--app-url/);
      expect(() => buildEnv(TEMPLATE, { apiUrl: bad }), bad).toThrow(/--api-url/);
    }
  });

  it("fails loudly if .env.example ever loses a line it needs to fill in (rather than leaving a placeholder behind)", async () => {
    const { buildEnv } = await load();
    for (const name of ["POSTGRES_PASSWORD", "APP_DB_PASSWORD", "JWT_SECRET", "# SECRET_ENCRYPTION_KEY"]) {
      const broken = TEMPLATE.split("\n").filter((l) => !l.startsWith(`${name}=`)).join("\n");
      expect(() => buildEnv(broken), name).toThrow(new RegExp(`no longer has the line for ${name.replace("# ", "")}`));
    }
  });
});

describe("running it", () => {
  it("creates the file, readable only by its owner, and prints what to do next — without printing a secret", () => {
    const target = join(dir, ".env");
    const r = run("--out", target);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(target)).toBe(true);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    const vars = parseEnv(readFileSync(target, "utf8"));
    expect(vars.JWT_SECRET).toMatch(/^[0-9a-f]{64}$/);
    for (const secret of [vars.POSTGRES_PASSWORD, vars.APP_DB_PASSWORD, vars.JWT_SECRET, vars.SECRET_ENCRYPTION_KEY]) {
      expect(r.stdout).not.toContain(secret);
      expect(r.stderr).not.toContain(secret);
    }
    expect(r.stdout).toMatch(/docker compose build api/);
    expect(r.stdout).toMatch(/docker compose up -d/);
    expect(r.stdout).toMatch(/db:bootstrap-admin/);
    expect(r.stdout).toMatch(/Server settings/);
    expect(r.stdout).toMatch(/SECRET_ENCRYPTION_KEY/);
  });

  it("never overwrites a file that is already there", () => {
    const target = join(dir, ".env");
    writeFileSync(target, "JWT_SECRET=precious\n");
    const r = run("--out", target);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/already exists, so it was left alone/);
    expect(readFileSync(target, "utf8")).toBe("JWT_SECRET=precious\n");
  });

  it("running it twice keeps the first file", () => {
    const target = join(dir, ".env");
    expect(run("--out", target).status).toBe(0);
    const first = readFileSync(target, "utf8");
    expect(run("--out", target).status).toBe(1);
    expect(readFileSync(target, "utf8")).toBe(first);
  });

  it("passes the public addresses through", () => {
    const target = join(dir, ".env");
    expect(run("--out", target, "--app-url", "https://portal.example.com", "--api-url", "https://api.example.com").status).toBe(0);
    const vars = parseEnv(readFileSync(target, "utf8"));
    expect(vars.APP_BASE_URL).toBe("https://portal.example.com");
    expect(vars.API_PUBLIC_URL).toBe("https://api.example.com");
  });

  it("explains a bad address and writes nothing", () => {
    const target = join(dir, ".env");
    const r = run("--out", target, "--app-url", "not-a-url");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--app-url must be a full web address/);
    expect(r.stderr).toMatch(/Usage:/);
    expect(existsSync(target)).toBe(false);
  });

  it("explains an unknown option or a missing value", () => {
    const target = join(dir, ".env");
    expect(run("--out", target, "--force").status).toBe(2);
    expect(run("--out", target, "--force").stderr).toMatch(/Unknown option: --force/);
    const missing = run("--out");
    expect(missing.status).toBe(2);
    expect(missing.stderr).toMatch(/--out needs a value/);
    expect(run("--app-url", "--out", target).stderr).toMatch(/--app-url needs a value/);
    expect(existsSync(target)).toBe(false);
  });

  it("says what went wrong when it can't write there", () => {
    const r = run("--out", join(dir, "no-such-folder", ".env"));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^Failed: /);
  });

  it("shows help and exits cleanly", () => {
    const r = run("--help");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage: node scripts\/init-env\.mjs/);
  });

  it("is what `npm run setup` runs", () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.setup).toBe("node scripts/init-env.mjs");
  });
});
