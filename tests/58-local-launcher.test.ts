import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import { parse as parseConnectionString } from "pg-connection-string";
import { isMainModule } from "../src/isMainModule.ts";

/**
 * `node scripts/local.mjs …` is how the portal is installed and started without Docker — and the only route that works
 * the same in Windows PowerShell, cmd and Linux terminals (no `export`, no `VAR=value command`, no `sudo -u postgres`).
 *
 * Three layers: the small pure pieces (reading .env, building database addresses, explaining errors); the commands with
 * the computer pretended (a fake PostgreSQL client and fake program launcher); and the real thing — a real PostgreSQL that
 * demands a password with awkward characters, like the one the Windows installer creates, and real child processes.
 */

const SCRIPT = resolve(__dirname, "../scripts/local.mjs");
const REPO = resolve(__dirname, "..");

type Item = { level: "ok" | "warn" | "fail"; text: string; hint?: string };
type Handle = { done: Promise<number>; stop(): void };
type LaunchOpts = { cwd: string; env: Record<string, string | undefined>; label?: string; onLine?: (line: string) => void; out?: { write(s: string): unknown }; err?: { write(s: string): unknown } };
type Deps = {
  root: string; platform: string; arch: string; nodeVersion: string; env: Record<string, string | undefined>; home?: string;
  launch?(args: string[], o: LaunchOpts): Handle;
  onInterrupt?(cb: () => void): () => void;
  portIsFree(p: number): Promise<boolean>;
  connectPg(url: string): Promise<{ query(sql: string, p?: unknown[]): Promise<{ rowCount: number }>; end(): Promise<void> }>;
  runNode(args: string[], o: { cwd: string; env: Record<string, string | undefined> }): Promise<number>;
};
type Mod = {
  parseEnv(t: string): Record<string, string>;
  databaseUrl(o: { user: string; password: string; host: string; port: number; database: string }): string;
  problemsWith(s: Record<string, string>, names: string[]): string[];
  postgresConfig(s: Record<string, string>): { host: string; port: number; adminUser: string; adminPassword: string; appPassword: string };
  explainPgError(e: unknown, pg: ReturnType<Mod["postgresConfig"]>, who: "admin" | "app"): string;
  inspectInstall(o: Record<string, unknown>): Item[];
  main(argv: string[], io: { log(s: string): void; error(s: string): void }, deps: Deps): Promise<number>;
  programArgs(root: string, file: string): string[];
  evidenceFolder(settings: Record<string, string>, deps: { env: Record<string, string | undefined>; home?: string }): string;
  launch(args: string[], o: LaunchOpts): Handle;
};
let M: Mod;
beforeAll(async () => { M = (await import(pathToFileURL(SCRIPT).href)) as Mod; });

describe("reading .env", () => {
  it("copes with what Windows editors write: a byte-order mark, CRLF line ends, export, quotes, comments", () => {
    const text = "\uFEFFPOSTGRES_PASSWORD=abc123\r\n# a comment\r\nexport JWT_SECRET=\"quoted value\"\r\nA='single'\r\n\r\nB = spaced  # trailing comment\r\nC=has#hash\r\nD=has=equals\r\nE=\r\n  F=indented\r\nnot a setting\r\n";
    expect(M.parseEnv(text)).toEqual({
      POSTGRES_PASSWORD: "abc123", JWT_SECRET: "quoted value", A: "single", B: "spaced", C: "has#hash", D: "has=equals", E: "", F: "indented",
    });
  });

  it("a quoted value keeps its spaces and #, and ignores what follows the closing quote", () => {
    expect(M.parseEnv('P="p@ss word # not a comment" # real comment')).toEqual({ P: "p@ss word # not a comment" });
  });

  it("commented-out lines are not settings", () => {
    expect(M.parseEnv("# SECRET_ENCRYPTION_KEY=abc\n#POSTGRES_PORT=1\n")).toEqual({});
  });
});

describe("database addresses", () => {
  it("survive any password: the address parses back to exactly the characters typed", () => {
    for (const password of ["simple", "p@ss:w/rd#1", "100% sure & ?x=y", "ünï©ode 日本", "'\"\\ ", "a b"]) {
      const user = password === "simple" ? "postgres" : "db admin@corp:1/x#y";   // an administrator account may have an awkward name too
      const url = M.databaseUrl({ user, password, host: "127.0.0.1", port: 5433, database: "evidenceportal" });
      const parsed = parseConnectionString(url);
      expect(parsed.password, password).toBe(password);
      expect(parsed.user, password).toBe(user); expect(parsed.host).toBe("127.0.0.1"); expect(parsed.port).toBe("5433"); expect(parsed.database).toBe("evidenceportal");
    }
  });
});

describe("is a port free?", () => {
  type PortMod = { portIsFree(p: number): Promise<boolean> };
  const listen = (host: string | undefined) => new Promise<{ port: number; close(): Promise<void> }>((ok, fail) => {
    const s = createServer(); s.once("error", fail);
    s.listen(0, host, () => ok({ port: (s.address() as AddressInfo).port, close: () => new Promise<void>((done) => s.close(() => done())) }));
  });
  it("is also false when something uses the port on just another address of this computer, which a plain bind to every address would run into", async () => {
    const { portIsFree } = M as unknown as PortMod;
    let other;
    try { other = await listen("127.0.0.2"); } catch { return; }   // not every system answers on 127.0.0.2 (Linux does)
    try { expect(await portIsFree(other.port)).toBe(false); } finally { await other.close(); }
  });
  it("is false when something already uses the port — whether it listens on this computer only or on every address — and true once it is released", async () => {
    const { portIsFree } = M as unknown as PortMod;
    for (const host of ["127.0.0.1", undefined]) {
      const taken = await listen(host);
      expect(await portIsFree(taken.port), String(host)).toBe(false);
      await taken.close();
      expect(await portIsFree(taken.port), `${host} released`).toBe(true);
    }
  });
});

describe("checking settings", () => {
  it("flags missing values and the placeholders from .env.example, and nothing else", () => {
    expect(M.problemsWith({ A: "x", B: "", C: "change-me", D: "change-me-too", E: "Change-Me-To-A-Long-Random-Value" }, ["A", "B", "C", "D", "E", "F"])).toEqual([
      "B has no value", 'C is still the placeholder "change-me"', 'D is still the placeholder "change-me-too"',
      'E is still the placeholder "Change-Me-To-A-Long-Random-Value"', "F has no value",
    ]);
  });

  it("PostgreSQL details default to this computer, port 5432, user postgres; a blank POSTGRES_PORT line means the default", () => {
    expect(M.postgresConfig({ POSTGRES_PASSWORD: "p", APP_DB_PASSWORD: "a" })).toEqual({ host: "127.0.0.1", port: 5432, adminUser: "postgres", adminPassword: "p", appPassword: "a" });
    expect(M.postgresConfig({ POSTGRES_PORT: "" }).port).toBe(5432);
    expect(M.postgresConfig({ POSTGRES_PORT: "5433", POSTGRES_USER: "admin", POSTGRES_HOST: "10.0.0.5" })).toMatchObject({ port: 5433, adminUser: "admin", host: "10.0.0.5" });
    expect(() => M.postgresConfig({ POSTGRES_PORT: "abc" })).toThrow(/POSTGRES_PORT/);
    expect(() => M.postgresConfig({ POSTGRES_PORT: "70000" })).toThrow(/POSTGRES_PORT/);
  });
});

describe("explaining PostgreSQL errors in plain words", () => {
  const pg = { host: "127.0.0.1", port: 5433, adminUser: "postgres", adminPassword: "SECRET-PW", appPassword: "APP-PW" };

  it("not running → how to start it on Windows, and how to say it uses another port", () => {
    const t = M.explainPgError({ code: "ECONNREFUSED" }, pg, "admin");
    expect(t).toContain("127.0.0.1:5433"); expect(t).toMatch(/Services/); expect(t).toContain("POSTGRES_PORT");
    expect(M.explainPgError({ errors: [{ code: "ECONNREFUSED" }] }, pg, "admin")).toContain("Cannot reach PostgreSQL");   // Node reports both IPv4 and IPv6 attempts this way
  });
  it("wrong administrator password → points at the password from the installer and at .env", () => {
    const t = M.explainPgError({ code: "28P01" }, pg, "admin");
    expect(t).toMatch(/password you typed in the PostgreSQL installer/); expect(t).toContain("notepad .env"); expect(t).not.toContain("SECRET-PW");
  });
  it("portal_app refused → run the db step first", () => {
    expect(M.explainPgError({ code: "28P01" }, pg, "app")).toMatch(/node scripts\/local\.mjs db/);
    expect(M.explainPgError({ code: "3D000" }, pg, "app")).toMatch(/node scripts\/local\.mjs db/);
  });
  it("anything else keeps PostgreSQL's own words", () => {
    expect(M.explainPgError(new Error("boom"), pg, "admin")).toContain("boom");
  });
});

describe("inspecting the installation", () => {
  let root: string;
  const settings = { POSTGRES_PASSWORD: "p", APP_DB_PASSWORD: "a", JWT_SECRET: "j", SECRET_ENCRYPTION_KEY: "k" };
  const base = () => ({ root, platform: "win32", arch: "x64", nodeVersion: "v22.12.0", settings, envFileExists: true, envPath: join(root, ".env") });
  const levels = (items: Item[]) => items.map((i) => i.level);
  const failing = (items: Item[]) => items.filter((i) => i.level === "fail").map((i) => i.text + " " + (i.hint ?? ""));
  const build = (opts: { esbuild?: string[]; tsx?: boolean; pg?: boolean; dist?: boolean } = {}) => {
    const { esbuild = ["win32-x64"], tsx = true, pg = true, dist = true } = opts;
    if (tsx) { mkdirSync(join(root, "node_modules", "tsx", "dist", "esm"), { recursive: true }); writeFileSync(join(root, "node_modules", "tsx", "dist", "esm", "index.mjs"), ""); }
    if (pg) mkdirSync(join(root, "node_modules", "pg"), { recursive: true });
    for (const e of esbuild) mkdirSync(join(root, "node_modules", "@esbuild", e), { recursive: true });
    if (dist) { mkdirSync(join(root, "frontend", "dist"), { recursive: true }); writeFileSync(join(root, "frontend", "dist", "index.html"), ""); }
  };
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), "inspect-")); });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const fresh = () => { rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true }); };

  it("a complete Windows installation has no problems", () => {
    fresh(); build();
    const r = M.inspectInstall(base());
    expect(levels(r)).not.toContain("fail"); expect(levels(r)).not.toContain("warn");
    expect(r.map((i) => i.text).join("\n")).toContain("match this computer (win32-x64)");
  });

  it("catches a Linux download opened on Windows — the libraries are for another kind of computer", () => {
    fresh(); build({ esbuild: ["linux-x64", "linux-arm64"] });
    const f = failing(M.inspectInstall(base())).join("\n");
    expect(f).toContain("linux-arm64 / linux-x64"); expect(f).toContain("win32-x64"); expect(f).toContain("npm ci --omit=dev");
  });

  it("knows an ARM Windows computer needs the arm64 library", () => {
    fresh(); build({ esbuild: ["win32-x64"] });
    expect(failing(M.inspectInstall({ ...base(), arch: "arm64" })).join("\n")).toContain("win32-arm64");
    fresh(); build({ esbuild: ["win32-x64", "win32-arm64"] });
    expect(failing(M.inspectInstall({ ...base(), arch: "arm64" }))).toEqual([]);
  });

  it("missing libraries, missing esbuild folder, missing web app", () => {
    fresh(); build({ tsx: false, pg: false, esbuild: [] });
    expect(failing(M.inspectInstall(base())).join("\n")).toContain("node_modules folder) are missing");
    fresh(); build({ esbuild: [] });
    expect(failing(M.inspectInstall(base())).join("\n")).toContain("no @esbuild folder");
    fresh(); build({ dist: false });
    expect(failing(M.inspectInstall(base())).join("\n")).toContain("frontend/dist/index.html");
  });

  it("Node versions: 22 and 24 pass, 20 and 21 only warn, older fail with where to get a new one", () => {
    fresh(); build();
    for (const v of ["v22.0.0", "v24.1.0"]) expect(levels(M.inspectInstall({ ...base(), nodeVersion: v })), v).not.toContain("warn");
    for (const v of ["v20.11.0", "v21.0.0", "v25.0.0"]) { const l = levels(M.inspectInstall({ ...base(), nodeVersion: v })); expect(l, v).toContain("warn"); expect(l, v).not.toContain("fail"); }
    expect(failing(M.inspectInstall({ ...base(), nodeVersion: "v18.20.0" })).join("\n")).toContain("nodejs.org");
  });

  it(".env: missing file, placeholders, and a missing encryption key (a warning, not a failure)", () => {
    fresh(); build();
    expect(failing(M.inspectInstall({ ...base(), envFileExists: false, settings: {} })).join("\n")).toContain("node scripts/init-env.mjs");
    expect(failing(M.inspectInstall({ ...base(), settings: { ...settings, POSTGRES_PASSWORD: "change-me" } })).join("\n")).toMatch(/POSTGRES_PASSWORD is still the placeholder/);
    const r = M.inspectInstall({ ...base(), settings: { ...settings, SECRET_ENCRYPTION_KEY: "" } });
    expect(r.filter((i) => i.level === "warn").map((i) => i.text).join()).toContain("SECRET_ENCRYPTION_KEY"); expect(levels(r)).not.toContain("fail");
  });
});

// --- the commands, with a pretend computer -----------------------------------------------------------------------------

describe("commands (pretend PostgreSQL and pretend programs)", () => {
  let dir: string, envFile: string;
  const SECRETS = { POSTGRES_PASSWORD: "P@ss:w/rd#1 x", APP_DB_PASSWORD: "app-pw-9f8e7d", JWT_SECRET: "jwt-secret-1a2b3c", SECRET_ENCRYPTION_KEY: "enc-key-4d5e6f" };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "launcher-cmd-"));
    mkdirSync(join(dir, "node_modules", "tsx", "dist", "esm"), { recursive: true }); writeFileSync(join(dir, "node_modules", "tsx", "dist", "esm", "index.mjs"), "");
    mkdirSync(join(dir, "node_modules", "pg"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "@esbuild", process.platform + "-" + process.arch), { recursive: true });
    mkdirSync(join(dir, "frontend", "dist"), { recursive: true }); writeFileSync(join(dir, "frontend", "dist", "index.html"), "");
    envFile = join(dir, ".env");
    writeFileSync(envFile, Object.entries(SECRETS).map(([k, v]) => `${k}="${v}"`).join("\r\n") + "\r\n");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  type PgScript = { failWith?: { code: string; message?: string; urlIncludes?: string }; dbExists?: boolean; roleExists?: boolean; hasUsers?: boolean };
  type Proc = { args: string[]; label?: string; env: Record<string, string | undefined>; cwd: string; stopped: boolean; exited: boolean; emit(line: string): void; exit(code: number): void; handle: Handle };
  const makeProc = (args: string[], o: LaunchOpts): Proc => {
    let finish!: (c: number) => void;
    const done = new Promise<number>((ok) => (finish = ok));
    const proc: Proc = {
      args, label: o.label, env: o.env, cwd: o.cwd, stopped: false, exited: false,
      emit: (line) => o.onLine?.(line),
      exit: (c) => { if (!proc.exited) { proc.exited = true; finish(c); } },
      handle: { done, stop: () => { proc.stopped = true; proc.exit(143); } },
    };
    return proc;
  };
  function pretend(script: PgScript = {}, over: Partial<Deps> = {}) {
    const urls: string[] = [], queries: string[] = [], runs: { args: string[]; env: Record<string, string | undefined>; cwd: string }[] = [];
    const procs: Proc[] = []; let interruptCb: (() => void) | undefined; const portsAsked: number[] = [];
    const out: string[] = [], err: string[] = [];
    const deps: Deps = {
      root: dir, platform: process.platform, arch: process.arch, nodeVersion: "v22.12.0", env: {},
      portIsFree: async (port) => { portsAsked.push(port); return true; },
      launch: (args, o) => { const proc = makeProc(args, o); procs.push(proc); return proc.handle; },
      onInterrupt: (cb) => { interruptCb = cb; return () => { interruptCb = undefined; }; },
      connectPg: async (url) => {
        urls.push(url);
        if (script.failWith && (!script.failWith.urlIncludes || url.includes(script.failWith.urlIncludes))) throw Object.assign(new Error(script.failWith.message ?? "failed"), { code: script.failWith.code });
        return {
          async query(sql: string) {
            queries.push(sql);
            if (/FROM pg_database/.test(sql)) return { rowCount: script.dbExists ? 1 : 0 };
            if (/FROM pg_roles/.test(sql)) return { rowCount: script.roleExists ? 1 : 0 };
            if (/FROM users/.test(sql)) return { rowCount: script.hasUsers ? 1 : 0 };
            return { rowCount: 0 };
          },
          async end() {},
        };
      },
      runNode: async (args, o) => { runs.push({ args, env: o.env, cwd: o.cwd }); return 0; },
      ...over,
    };
    const io = { log: (s: string) => out.push(s), error: (s: string) => err.push(s) };
    const all = () => out.join("\n") + "\n" + err.join("\n");
    return { deps, io, urls, queries, runs, out, err, all, procs, portsAsked, interrupt: () => interruptCb?.() };
  }
  const go = (argv: string[], p: ReturnType<typeof pretend>) => M.main([...argv, "--env", envFile], p.io, p.deps);
  const noSecrets = (text: string) => { for (const v of Object.values(SECRETS)) { expect(text).not.toContain(v); expect(text).not.toContain(encodeURIComponent(v)); } };

  it("prints the usage with no command, exits 2 for an unknown one or option, and needs a value for each option", async () => {
    const p = pretend();
    expect(await M.main([], p.io, p.deps)).toBe(0); expect(p.all()).toContain("node scripts/local.mjs check");
    const q = pretend(); expect(await M.main(["frobnicate"], q.io, q.deps)).toBe(2); expect(q.all()).toContain("Unknown command");
    const r = pretend(); expect(await M.main(["db", "--nope"], r.io, r.deps)).toBe(2);
    const s = pretend(); expect(await M.main(["admin", "--org"], s.io, s.deps)).toBe(2); expect(s.all()).toContain("needs a value");
  });

  describe("check", () => {
    it("reports success when everything is in place, and never prints a secret", async () => {
      const p = pretend({ dbExists: true, roleExists: true });
      expect(await go(["check"], p)).toBe(0);
      expect(p.all()).toContain('accepted the "postgres" login'); expect(p.all()).toContain("All good.");
      expect(p.urls).toHaveLength(1); expect(p.urls[0]).toContain("/postgres");   // looked at the server, not at a database that may not exist
      noSecrets(p.all());
    });
    it("says the database is not set up yet (a warning with the next step), not a failure", async () => {
      const p = pretend({ dbExists: false });
      expect(await go(["check"], p)).toBe(0);
      expect(p.all()).toContain("not set up yet"); expect(p.all()).toContain("node scripts/local.mjs db");
    });
    it("wrong PostgreSQL password → a failure that says where to change it, without printing it", async () => {
      const p = pretend({ failWith: { code: "28P01" } });
      expect(await go(["check"], p)).toBe(1);
      expect(p.all()).toContain("[FAIL]"); expect(p.all()).toContain("notepad .env"); noSecrets(p.all());
    });
    it("PostgreSQL not running → a failure that says how to start it", async () => {
      const p = pretend({ failWith: { code: "ECONNREFUSED" } });
      expect(await go(["check"], p)).toBe(1); expect(p.all()).toContain("Services");
    });
    it("ports in use are warnings that say what to do", async () => {
      const p = pretend({ dbExists: true, roleExists: true }, { portIsFree: async (port) => port !== 3000 });
      expect(await go(["check"], p)).toBe(0);
      expect(p.all()).toContain("Port 3000 is already in use"); expect(p.all()).toContain("Port 5173 is free");
    });
    it("a missing .env is a failure with the command that creates it, and PostgreSQL is not even tried", async () => {
      const p = pretend();
      expect(await M.main(["check", "--env", join(dir, "nope.env")], p.io, p.deps)).toBe(1);
      expect(p.all()).toContain("node scripts/init-env.mjs"); expect(p.urls).toHaveLength(0);
    });
    it("Linux libraries on a Windows computer are caught", async () => {
      const p = pretend({ dbExists: true, roleExists: true }, { platform: "win32", arch: "x64" });
      expect(await go(["check"], p)).toBe(1);
      expect(p.all()).toContain("packaged for"); expect(p.all()).toContain("win32-x64");
    });
  });

  describe("db", () => {
    it("creates the database when missing, then runs the migration and the control-list seed, in that order, as the PostgreSQL administrator", async () => {
      const p = pretend({ dbExists: false });
      expect(await go(["db"], p)).toBe(0);
      expect(p.queries.some((q) => /^CREATE DATABASE evidenceportal$/.test(q))).toBe(true);
      expect(p.runs).toHaveLength(2);
      // one process: node --import <tsx loader> <file> (tsx's own command wrapper would leave a second process behind)
      for (const r of p.runs) expect(r.args.slice(0, 2)).toEqual(["--import", pathToFileURL(join(dir, "node_modules", "tsx", "dist", "esm", "index.mjs")).href]);
      expect(p.runs.map((r) => r.args[2])).toEqual([join(dir, "src/db/migrate-cli.ts"), join(dir, "src/db/seed-cli.ts")]);
      for (const r of p.runs) {
        expect(r.cwd).toBe(dir);   // migrations are found relative to the project folder
        const u = parseConnectionString(r.env.DATABASE_URL!);
        expect(u.user).toBe("postgres"); expect(u.password).toBe(SECRETS.POSTGRES_PASSWORD); expect(u.database).toBe("evidenceportal"); expect(u.host).toBe("127.0.0.1"); expect(u.port).toBe("5432");
        expect(r.env.APP_DB_PASSWORD).toBe(SECRETS.APP_DB_PASSWORD);   // migrate-cli gives portal_app this password
      }
      expect(p.all()).toContain("The database is ready"); noSecrets(p.all());
    });
    it("is safe to repeat: an existing database is left alone", async () => {
      const p = pretend({ dbExists: true });
      expect(await go(["db"], p)).toBe(0);
      expect(p.queries.some((q) => /CREATE DATABASE/.test(q))).toBe(false); expect(p.all()).toContain("already exists");
    });
    it("stops at the first failing step and says which", async () => {
      const p = pretend({ dbExists: true }, { runNode: async (args) => (args[2].endsWith("migrate-cli.ts") ? 1 : 0) });
      expect(await go(["db"], p)).toBe(1);
      expect(p.all()).toContain("migrate-cli.ts failed"); expect(p.all()).not.toContain("The database is ready");
    });
    it("a wrong PostgreSQL password runs nothing and explains", async () => {
      const p = pretend({ failWith: { code: "28P01" } });
      expect(await go(["db"], p)).toBe(1);
      expect(p.runs).toHaveLength(0); expect(p.all()).toContain("notepad .env"); noSecrets(p.all());
    });
    it("honours POSTGRES_PORT and POSTGRES_USER from .env, and the real environment wins over .env", async () => {
      const f = join(dir, "port.env");
      writeFileSync(f, `POSTGRES_PASSWORD=pw\nAPP_DB_PASSWORD=ap\nPOSTGRES_PORT=5433\nPOSTGRES_USER=dba\n`);
      const p = pretend({ dbExists: true });
      expect(await M.main(["db", "--env", f], p.io, p.deps)).toBe(0);
      expect(p.runs[0].env.DATABASE_URL).toBe("postgres://dba:pw@127.0.0.1:5433/evidenceportal");
      const q = pretend({ dbExists: true }, { env: { POSTGRES_PORT: "6000", POSTGRES_PASSWORD: "from-environment" } });
      expect(await M.main(["db", "--env", f], q.io, q.deps)).toBe(0);
      expect(q.runs[0].env.DATABASE_URL).toBe("postgres://dba:from-environment@127.0.0.1:6000/evidenceportal");
    });
    it("tells you what to do when the libraries are missing", async () => {
      const bare = mkdtempSync(join(tmpdir(), "launcher-bare-"));
      try {
        const p = pretend({}, { root: bare });
        expect(await M.main(["db", "--env", envFile], p.io, p.deps)).toBe(1);
        expect(p.all()).toContain("node scripts/local.mjs check");
      } finally { rmSync(bare, { recursive: true, force: true }); }
    });
    it("refuses a .env that still has the placeholders", async () => {
      const f = join(dir, "placeholder.env");
      writeFileSync(f, "POSTGRES_PASSWORD=change-me\nAPP_DB_PASSWORD=change-me-too\n");
      const p = pretend();
      expect(await M.main(["db", "--env", f], p.io, p.deps)).toBe(1);
      expect(p.all()).toMatch(/POSTGRES_PASSWORD is still the placeholder/); expect(p.urls).toHaveLength(0);
    });
  });

  describe("admin", () => {
    const argv = ["admin", "--org", "Dublin Audit & Co. Ltd", "--domain", "dublinaudit.example", "--email", "arjun@dublinaudit.example"];
    it("passes the organisation name, with spaces and &, as one setting — no shell to mangle it — and connects as the PostgreSQL administrator", async () => {
      const p = pretend();
      expect(await go(argv, p)).toBe(0);
      expect(p.runs).toHaveLength(1);
      expect(p.runs[0].args[2]).toBe(join(dir, "src/db/bootstrap-admin-cli.ts"));
      expect(p.runs[0].env).toMatchObject({ ORG_NAME: "Dublin Audit & Co. Ltd", ORG_DOMAIN: "dublinaudit.example", ADMIN_EMAIL: "arjun@dublinaudit.example" });
      expect(parseConnectionString(p.runs[0].env.DATABASE_URL!).user).toBe("postgres");
    });
    it("passes the link address from .env so the printed link points at the right place", async () => {
      const f = join(dir, "url.env");
      writeFileSync(f, `POSTGRES_PASSWORD=pw\nAPP_BASE_URL=http://localhost:5173\n`);
      const p = pretend();
      expect(await M.main([...argv, "--env", f], p.io, p.deps)).toBe(0);
      expect(p.runs[0].env.APP_BASE_URL).toBe("http://localhost:5173");
    });
    it("hands back the program's own exit code", async () => {
      const p = pretend({}, { runNode: async () => 1 });
      expect(await go(argv, p)).toBe(1);
    });
    it("asks for what is missing, and rejects an email or domain that cannot be right, before touching anything", async () => {
      for (const [a, re] of [
        [["admin"], /--org, --domain, --email/],
        [["admin", "--org", "X"], /--domain, --email/],
        [["admin", "--org", "X", "--domain", "x.example", "--email", "not-an-email"], /--email must look like/],
        [["admin", "--org", "X", "--domain", "me@x.example", "--email", "me@x.example"], /--domain is the part after the @/],
        [["admin", "--org", "X", "--domain", "x.example", "--email", "a b@x.example"], /--email must look like/],
      ] as const) {
        const p = pretend();
        expect(await go([...a], p), a.join(" ")).toBe(2); expect(p.all()).toMatch(re); expect(p.urls).toHaveLength(0); expect(p.runs).toHaveLength(0);
      }
    });
    it("a wrong PostgreSQL password runs nothing", async () => {
      const p = pretend({ failWith: { code: "28P01" } });
      expect(await go(argv, p)).toBe(1); expect(p.runs).toHaveLength(0); noSecrets(p.all());
    });
  });

  describe("api", () => {
    it("starts the server as the restricted portal_app role, with the secrets from .env, after proving the role can sign in", async () => {
      const p = pretend();
      expect(await go(["api"], p)).toBe(0);
      expect(p.urls).toHaveLength(1);
      const probe = parseConnectionString(p.urls[0]);
      expect(probe.user).toBe("portal_app"); expect(probe.password).toBe(SECRETS.APP_DB_PASSWORD);
      expect(p.runs).toHaveLength(1);
      expect(p.runs[0].args[2]).toBe(join(dir, "src/server.ts"));
      const env = p.runs[0].env;
      expect(parseConnectionString(env.DATABASE_URL!).user).toBe("portal_app");
      expect(env.JWT_SECRET).toBe(SECRETS.JWT_SECRET); expect(env.SECRET_ENCRYPTION_KEY).toBe(SECRETS.SECRET_ENCRYPTION_KEY);
      noSecrets(p.all());
    });
    it("keeps settings from the real environment that .env doesn't mention (PORT, SMTP_*) and lets the environment win over .env", async () => {
      const p = pretend({}, { env: { PORT: "3100", SMTP_HOST: "mail.example", JWT_SECRET: "from-environment" } });
      await go(["api"], p);
      expect(p.runs[0].env).toMatchObject({ PORT: "3100", SMTP_HOST: "mail.example", JWT_SECRET: "from-environment" });
    });
    it("before the db step: says to run it, and does not start", async () => {
      const p = pretend({ failWith: { code: "28P01" } });
      expect(await go(["api"], p)).toBe(1);
      expect(p.runs).toHaveLength(0); expect(p.all()).toContain("node scripts/local.mjs db"); noSecrets(p.all());
    });
  });

  describe("where the evidence files go on this computer", () => {
    it("without a setting, a folder in the user's own profile — NOT inside the portal's folder, which is replaced by each new version", () => {
      const home = join(dir, "profile");
      const folder = M.evidenceFolder({}, { env: {}, home });
      expect(folder).toBe(join(home, "EvidencePortal", "files"));
    });
    it("a LOCAL_STORAGE_DIR line in .env decides; so does one in the real environment; .env comes first", () => {
      expect(M.evidenceFolder({ LOCAL_STORAGE_DIR: "D:/Evidence" }, { env: {}, home: "/h" })).toBe("D:/Evidence");
      expect(M.evidenceFolder({}, { env: { LOCAL_STORAGE_DIR: "E:/FromEnv" }, home: "/h" })).toBe("E:/FromEnv");
      expect(M.evidenceFolder({ LOCAL_STORAGE_DIR: "D:/Evidence" }, { env: { LOCAL_STORAGE_DIR: "E:/FromEnv" }, home: "/h" })).toBe("D:/Evidence");
    });
    it("the API is started with it (both by `api` and by `start`), and the banner says where the files are", async () => {
      const viaApi = pretend({}, { home: join(dir, "profile") });
      await go(["api"], viaApi);
      expect(viaApi.runs[0].env.LOCAL_STORAGE_DIR).toBe(join(dir, "profile", "EvidencePortal", "files"));

      const p = pretend({ dbExists: true, hasUsers: true }, { home: join(dir, "profile2") });
      const run = go(["start"], p);
      const until2 = async (cond: () => boolean) => { for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5)); expect(cond()).toBe(true); };
      await until2(() => p.procs.some((x) => x.label === "api") && p.procs.some((x) => x.label === "web"));
      const api = p.procs.find((x) => x.label === "api")!, web = p.procs.find((x) => x.label === "web")!;
      expect(api.env.LOCAL_STORAGE_DIR).toBe(join(dir, "profile2", "EvidencePortal", "files"));
      expect(web.env.LOCAL_STORAGE_DIR).toBeUndefined();
      api.emit("Evidence portal API listening on :3000"); web.emit("Web app: http://localhost:5173  (serving frontend/dist)");
      await until2(() => p.out.join("\n").includes("The portal is running"));
      expect(p.out.join("\n")).toContain(join(dir, "profile2", "EvidencePortal", "files"));
      p.interrupt(); await run;
    });
  });

  describe("start (the one command)", () => {
    const FLAGS = ["--org", "Dublin Audit & Co. Ltd", "--domain", "dublinaudit.example", "--email", "arjun@dublinaudit.example"];
    type P = ReturnType<typeof pretend>;
    const until = async (cond: () => boolean) => { for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5)); expect(cond()).toBe(true); };
    const proc = (p: P, label: string) => p.procs.find((x) => x.label === label)!;
    /** Waits for the API and the web app to be launched, and has them report that they are ready. */
    const bothUp = async (p: P) => {
      await until(() => !!proc(p, "api") && !!proc(p, "web"));
      proc(p, "api").emit("Evidence portal API listening on :3000");
      proc(p, "web").emit("Web app: http://localhost:5173  (serving frontend/dist)");
    };
    const banner = (p: P) => p.out.join("\n");

    it("first run: prepares the database, creates the administrator, starts the API as portal_app and the web app, and only then announces both — with the sign-in link", async () => {
      const p = pretend({ dbExists: false, hasUsers: false });
      const run = go(["start", ...FLAGS], p);
      await until(() => p.procs.length === 1);
      const boot = p.procs[0];
      expect(p.runs.map((r) => r.args[2])).toEqual([join(dir, "src/db/migrate-cli.ts"), join(dir, "src/db/seed-cli.ts")]);   // database first
      expect(boot.args[2]).toBe(join(dir, "src/db/bootstrap-admin-cli.ts"));
      expect(boot.env).toMatchObject({ ORG_NAME: "Dublin Audit & Co. Ltd", ORG_DOMAIN: "dublinaudit.example", ADMIN_EMAIL: "arjun@dublinaudit.example" });
      expect(parseConnectionString(boot.env.DATABASE_URL!).user).toBe("postgres");
      expect(p.procs.filter((x) => x.label)).toHaveLength(0);                        // the servers wait until the administrator exists
      boot.emit("Set their password at:"); boot.emit("http://localhost:5173/accept-invite?token=abc_DEF-123"); boot.exit(0);

      await until(() => !!proc(p, "api") && !!proc(p, "web"));
      const api = proc(p, "api"), web = proc(p, "web");
      expect(api.args[2]).toBe(join(dir, "src/server.ts")); expect(web.args).toEqual([join(dir, "scripts", "serve-web.mjs")]);
      expect(parseConnectionString(api.env.DATABASE_URL!).user).toBe("portal_app");
      expect(api.env.JWT_SECRET).toBe(SECRETS.JWT_SECRET);
      expect(web.env.JWT_SECRET).toBeUndefined(); expect(web.env.DATABASE_URL).toBeUndefined(); expect(web.env.APP_DB_PASSWORD).toBeUndefined();   // the static web server gets no secrets
      expect(api.cwd).toBe(dir); expect(web.cwd).toBe(dir);

      api.emit("Evidence portal API listening on :3000");
      await new Promise((r) => setTimeout(r, 30));
      expect(banner(p)).not.toContain("The portal is running");                       // only one of the two is up
      web.emit("Web app: http://localhost:5173  (serving frontend/dist)");
      await until(() => banner(p).includes("The portal is running"));
      expect(banner(p)).toContain("Open it here:  http://localhost:5173");
      expect(banner(p)).toContain("http://localhost:5173/accept-invite?token=abc_DEF-123");
      expect(banner(p)).toContain("Ctrl+C");
      noSecrets(p.all());

      p.interrupt();
      expect(await run).toBe(0);
      expect(api.stopped && web.stopped).toBe(true);
    });

    it("later runs need no details: an existing administrator is left alone and no sign-in link is shown", async () => {
      const p = pretend({ dbExists: true, hasUsers: true });
      const run = go(["start"], p);
      await bothUp(p);
      await until(() => banner(p).includes("The portal is running"));
      expect(p.procs.map((x) => x.label)).toEqual(["api", "web"]);                    // no administrator step
      expect(banner(p)).not.toContain("accept-invite"); expect(banner(p)).not.toContain("First sign-in");
      p.interrupt(); expect(await run).toBe(0);
    });

    it("details given although an administrator exists are not used, and it says so", async () => {
      const p = pretend({ dbExists: true, hasUsers: true });
      const run = go(["start", ...FLAGS], p);
      await bothUp(p);
      await until(() => banner(p).includes("The portal is running"));
      expect(p.procs.find((x) => x.args[2]?.endsWith("bootstrap-admin-cli.ts"))).toBeUndefined();
      expect(p.all()).toContain("An administrator already exists");
      p.interrupt(); expect(await run).toBe(0);
    });

    it("no administrator and no details: starts nothing and shows the exact command to run (exit 2)", async () => {
      const p = pretend({ dbExists: true, hasUsers: false });
      expect(await go(["start"], p)).toBe(2);
      expect(p.procs).toHaveLength(0);
      expect(p.all()).toContain("There is no administrator yet"); expect(p.all()).toContain('node scripts/local.mjs start --org "Your Firm" --domain yourfirm.example --email you@yourfirm.example');
    });

    it("incomplete or wrong administrator details are refused before anything is touched", async () => {
      for (const [args, re] of [
        [["--org", "X"], /--domain, --email/],
        [["--org", "X", "--domain", "x.example", "--email", "nope"], /--email must look like/],
        [["--org", "X", "--domain", "a@x.example", "--email", "a@x.example"], /--domain is the part after the @/],
      ] as const) {
        const p = pretend({ dbExists: true });
        expect(await go(["start", ...args], p)).toBe(2); expect(p.all()).toMatch(re);
        expect(p.urls).toHaveLength(0); expect(p.runs).toHaveLength(0); expect(p.procs).toHaveLength(0);
      }
    });

    it("refuses when a port is already in use — before it touches the database — and says what that usually means", async () => {
      for (const [busy, what] of [[3000, "API"], [5173, "web app"]] as const) {
        const p = pretend({ dbExists: true, hasUsers: true }, { portIsFree: async (port) => port !== busy });
        expect(await go(["start"], p)).toBe(1);
        expect(p.all()).toContain(`Port ${busy} (needed by the ${what}) is already in use`); expect(p.all()).toContain("earlier copy");
        expect(p.urls).toHaveLength(0); expect(p.runs).toHaveLength(0); expect(p.procs).toHaveLength(0);
      }
    });

    it("uses PORT and WEB_PORT from the environment, for the port check too, and refuses a value that is not a port", async () => {
      const p = pretend({ dbExists: true, hasUsers: true }, { env: { PORT: "3100", WEB_PORT: "5200" } });
      const run = go(["start"], p);
      await until(() => !!proc(p, "api") && !!proc(p, "web"));
      expect(p.portsAsked).toEqual([3100, 5200]);
      expect(proc(p, "api").env.PORT).toBe("3100"); expect(proc(p, "web").env.WEB_PORT).toBe("5200");
      p.interrupt(); await run;
      const q = pretend({ dbExists: true }, { env: { WEB_PORT: "http" } });
      expect(await go(["start"], q)).toBe(2); expect(q.all()).toContain("WEB_PORT must be a port number");
    });

    it("when one part stops, the other is stopped too and the first one's exit code is returned", async () => {
      for (const [dead, other, who] of [["api", "web", "API"], ["web", "api", "web app"]] as const) {
        const p = pretend({ dbExists: true, hasUsers: true });
        const run = go(["start"], p);
        await bothUp(p);
        await until(() => banner(p).includes("The portal is running"));
        proc(p, dead).exit(3);
        expect(await run).toBe(3);
        expect(proc(p, other).stopped).toBe(true);
        expect(p.all()).toContain(`The ${who} stopped unexpectedly (exit code 3)`);
      }
    });

    it("a part that stops before it was ready (a busy port, a bad setting) fails the whole start and stops the other part", async () => {
      const p = pretend({ dbExists: true, hasUsers: true });
      const run = go(["start"], p);
      await until(() => !!proc(p, "api") && !!proc(p, "web"));
      proc(p, "api").exit(7);
      expect(await run).toBe(7);                                                     // the failing part's own code, not a generic 1
      expect(proc(p, "web").stopped).toBe(true);
      expect(p.all()).toContain("The API stopped before it was ready (exit code 7)"); expect(p.all()).not.toContain("The portal is running");
    });

    it("Ctrl+C before they are ready stops both quietly (exit 0)", async () => {
      const p = pretend({ dbExists: true, hasUsers: true });
      const run = go(["start"], p);
      await until(() => !!proc(p, "api") && !!proc(p, "web"));
      p.interrupt();
      expect(await run).toBe(0);
      expect(proc(p, "api").stopped && proc(p, "web").stopped).toBe(true); expect(p.all()).not.toContain("stopped before it was ready");
    });

    it("stops there if the administrator could not be created, and starts neither server", async () => {
      const p = pretend({ dbExists: true, hasUsers: false });
      const run = go(["start", ...FLAGS], p);
      await until(() => p.procs.length === 1);
      p.procs[0].exit(1);
      expect(await run).toBe(1);
      expect(p.procs).toHaveLength(1); expect(p.all()).toContain("creating the administrator failed");
    });

    it("if portal_app cannot sign in, explains and starts neither server", async () => {
      const p = pretend({ dbExists: true, hasUsers: true, failWith: { code: "28P01", urlIncludes: "portal_app" } });
      expect(await go(["start"], p)).toBe(1);
      expect(p.procs).toHaveLength(0); expect(p.all()).toContain("node scripts/local.mjs db");
    });

    it("a wrong PostgreSQL password is explained before anything starts; secrets are never printed", async () => {
      const p = pretend({ failWith: { code: "28P01" } });
      expect(await go(["start"], p)).toBe(1);
      expect(p.procs).toHaveLength(0); expect(p.runs).toHaveLength(0); expect(p.all()).toContain("notepad .env"); noSecrets(p.all());
    });

    it("without the built web app it says so before doing anything else", async () => {
      const bare = mkdtempSync(join(tmpdir(), "launcher-start-"));
      try {
        mkdirSync(join(bare, "node_modules", "tsx", "dist", "esm"), { recursive: true }); writeFileSync(join(bare, "node_modules", "tsx", "dist", "esm", "index.mjs"), "");
        const p = pretend({}, { root: bare });
        expect(await go(["start"], p)).toBe(1);
        expect(p.all()).toContain("frontend/dist/index.html"); expect(p.urls).toHaveLength(0);
      } finally { rmSync(bare, { recursive: true, force: true }); }
    });
  });

  describe("web", () => {
    it("serves the built web app with plain node, and does not need .env", async () => {
      const p = pretend({}, { env: { WEB_PORT: "5199" } });
      expect(await M.main(["web"], p.io, p.deps)).toBe(0);
      expect(p.runs).toHaveLength(1); expect(p.runs[0].args).toEqual([join(dir, "scripts", "serve-web.mjs")]); expect(p.runs[0].env.WEB_PORT).toBe("5199");
    });
    it("says so when the web app is not built", async () => {
      const bare = mkdtempSync(join(tmpdir(), "launcher-web-"));
      try {
        const p = pretend({}, { root: bare });
        expect(await M.main(["web"], p.io, p.deps)).toBe(1); expect(p.all()).toContain("frontend/dist/index.html");
      } finally { rmSync(bare, { recursive: true, force: true }); }
    });
  });
});

// --- the instructions people follow ----------------------------------------------------------------------------------------

describe("the written instructions match the program", () => {
  const readme = readFileSync(resolve(REPO, "README.md"), "utf8");
  const section = readme.slice(readme.indexOf("## Windows (no Docker)"), readme.indexOf("## Server settings"));
  const codeLines = [...section.matchAll(/```\n([\s\S]*?)```/g)].flatMap((m) => m[1].split("\n")).map((l) => l.trim()).filter(Boolean);

  it("the Windows section exists and uses only commands that work the same in PowerShell and cmd (no export, no VAR=value prefix, no sudo, no bash, no npm run)", () => {
    expect(section.length).toBeGreaterThan(2000);
    expect(codeLines.length).toBeGreaterThanOrEqual(4);
    for (const l of codeLines) {
      expect(l, l).toMatch(/^(node scripts\/(init-env|local)\.mjs\b|notepad \.env$)/);
      expect(l, l).not.toMatch(/\bexport\b|\bsudo\b|\bbash\b|\bnpm\b|^[A-Z_]+=/);
    }
  });

  it("every command in it names a script that exists, and every launcher command is one the launcher knows", () => {
    for (const l of codeLines.filter((x) => x.startsWith("node "))) {
      const file = l.split(/\s+/)[1];
      expect(existsSync(resolve(REPO, file)), l).toBe(true);
    }
    for (const l of codeLines.filter((x) => x.startsWith("node scripts/local.mjs"))) expect(l, l).toMatch(/^node scripts\/local\.mjs (check|start|db|admin|api|web)\b/);
  });

  it("the order is the order things can work in: settings → password → check → start (one command does the rest)", () => {
    const order = codeLines.map((l) => l.replace(/^node scripts\/(local|init-env)\.mjs ?/, (_m, f) => (f === "init-env" ? "init-env" : "")).split(/\s+/)[0]);
    expect(order).toEqual(["init-env", "notepad", "check", "start"]);
  });

  it("the start command, exactly as written, carries the three administrator details, and the launcher accepts them", async () => {
    const startLine = codeLines.find((l) => l.startsWith("node scripts/local.mjs start"))!;
    const written = [...startLine.slice("node scripts/local.mjs ".length).matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
    expect(written.slice(0, 1)).toEqual(["start"]);
    expect(written.filter((a) => a.startsWith("--")).sort()).toEqual(["--domain", "--email", "--org"]);
    // the same details given to the one-step command must work too
    const args = ["admin", ...written.slice(1)];
    const dir = mkdtempSync(join(tmpdir(), "readme-admin-"));
    try {
      mkdirSync(join(dir, "node_modules", "tsx", "dist", "esm"), { recursive: true }); writeFileSync(join(dir, "node_modules", "tsx", "dist", "esm", "index.mjs"), "");
      const env = join(dir, ".env"); writeFileSync(env, "POSTGRES_PASSWORD=pw\nAPP_DB_PASSWORD=ap\n");
      const runs: { env: Record<string, string | undefined> }[] = []; const err: string[] = [];
      const code = await M.main([...args, "--env", env], { log: () => {}, error: (s) => err.push(s) }, {
        root: dir, platform: process.platform, arch: process.arch, nodeVersion: "v22.0.0", env: {},
        portIsFree: async () => true,
        connectPg: async () => ({ query: async () => ({ rowCount: 0 }), end: async () => {} }),
        runNode: async (_a, o) => { runs.push({ env: o.env }); return 0; },
      });
      expect(code, err.join("\n")).toBe(0);
      expect(runs[0].env).toMatchObject({ ORG_NAME: "Your Firm", ORG_DOMAIN: "yourfirm.example", ADMIN_EMAIL: "you@yourfirm.example" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("start-portal.cmd (the double-click file) goes to its own folder, runs the start command, keeps the window open, and has Windows line endings", () => {
    const raw = readFileSync(resolve(REPO, "start-portal.cmd"), "utf8");
    expect(raw).toContain('cd /d "%~dp0"'); expect(raw).toContain("node scripts\\local.mjs start"); expect(raw).toMatch(/pause/);
    expect(raw.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);                     // every line break is CRLF, none is a bare LF
    expect(raw.startsWith("@echo off")).toBe(true);
    expect(readFileSync(resolve(REPO, ".gitattributes"), "utf8")).toMatch(/^\*\.cmd text eol=crlf$/m);
    expect(section).toContain("start-portal.cmd");
  });

  it("init-env's closing message and .env.example both point at the launcher, and the optional PostgreSQL lines in .env.example are the ones the launcher reads", () => {
    const init = readFileSync(resolve(REPO, "scripts/init-env.mjs"), "utf8");
    expect(init).toContain("node scripts/local.mjs check"); expect(init).toContain("Windows (no Docker)"); expect(init).toContain("node scripts/local.mjs start --org");
    const example = readFileSync(resolve(REPO, ".env.example"), "utf8");
    const launcher = readFileSync(SCRIPT, "utf8");
    for (const name of ["POSTGRES_PORT", "POSTGRES_USER", "POSTGRES_HOST"]) {
      expect(example, name).toMatch(new RegExp(`^# ${name}=`, "m"));
      expect(launcher, name).toContain(name);
    }
  });
});

// --- starting programs for real -------------------------------------------------------------------------------------------

describe("starting programs (real child processes)", () => {
  it("passes the exit code and the environment through, with no shell in between", () => {
    const root = mkdtempSync(join(tmpdir(), "launcher spawn-"));   // a space in the folder name: a shell would split the path in two
    try {
      mkdirSync(join(root, "scripts"), { recursive: true });
      for (const f of ["frontend/dist"]) mkdirSync(join(root, f), { recursive: true });
      writeFileSync(join(root, "frontend", "dist", "index.html"), "");
      // a stand-in for the web server script: reports what it received, and exits with a chosen code
      writeFileSync(join(root, "scripts", "serve-web.mjs"), "console.log(JSON.stringify({ port: process.env.WEB_PORT, cwd: process.cwd() })); process.exit(Number(process.env.EXIT_WITH ?? 0));");
      writeFileSync(join(root, "scripts", "local.mjs"), readScript());
      const run = (exit: string) => spawnSync(process.execPath, [join(root, "scripts", "local.mjs"), "web"], { encoding: "utf8", env: { ...process.env, WEB_PORT: "5180", EXIT_WITH: exit } });
      const ok = run("0"); expect(ok.status).toBe(0);
      const seen = JSON.parse(ok.stdout.trim()); expect(seen.port).toBe("5180"); expect(seen.cwd).toBe(root);
      expect(run("7").status).toBe(7);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("runs when started through a link or a folder name with spaces (where a naive 'am I the main file' check silently does nothing)", () => {
    const outer = mkdtempSync(join(tmpdir(), "launcher link-"));
    try {
      const real = join(outer, "real folder"); mkdirSync(join(real, "scripts"), { recursive: true });
      writeFileSync(join(real, "scripts", "local.mjs"), readScript());
      const link = join(outer, "the link"); symlinkSync(real, link, "dir");
      for (const where of [real, link]) {
        const r = spawnSync(process.execPath, [join(where, "scripts", "local.mjs"), "--help"], { encoding: "utf8" });
        expect(r.status, where).toBe(0); expect(r.stdout, where).toContain("node scripts/local.mjs check");
      }
    } finally { rmSync(outer, { recursive: true, force: true }); }
  });
});
function readScript() { return readFileSync(SCRIPT, "utf8"); }

// --- the whole route, against a real PostgreSQL that asks for a password ----------------------------------------------------

describe("the whole route against a real PostgreSQL with a password (like the one the Windows installer makes)", () => {
  const PORT = 54330;
  const PG_PASSWORD = "P@ss:w/rd#1 x&y%";               // every kind of character that has to be encoded in an address
  const APP_PASSWORD = "app-" + "x".repeat(20);
  const PLATFORM = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  const EXE = process.platform === "win32" ? ".exe" : "";
  const BIN = resolve(REPO, `node_modules/@embedded-postgres/${PLATFORM}/native/bin`);
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  let tmp: string, data: string, envFile: string, badEnv: string, apiPort: number;
  let api: ChildProcess | undefined;

  const as = (cmd: string, args: string[]) => (isRoot ? execFileSync("runuser", ["-u", "pguser", "--", cmd, ...args], { stdio: "pipe" }) : execFileSync(cmd, args, { stdio: "pipe" }));
  const launcher = (args: string[], envFileOverride = envFile) =>
    spawnSync(process.execPath, [SCRIPT, ...args, "--env", envFileOverride], { cwd: tmp, encoding: "utf8", timeout: 90_000, env: { ...process.env, PORT: String(apiPort), DATABASE_URL: "", POSTGRES_PORT: "" } });
  const text = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr;
  const connect = async (user: string, password: string, database: string) => { const c = new Client({ host: "127.0.0.1", port: PORT, user, password, database }); await c.connect(); return c; };

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "launcher-e2e-"));
    if (isRoot) execFileSync("chown", ["pguser", tmp]);
    data = join(tmp, "pgdata");
    const pwfile = join(tmp, "pw.txt");
    writeFileSync(pwfile, PG_PASSWORD + "\n"); if (isRoot) execFileSync("chown", ["pguser", pwfile]);
    as(join(BIN, `initdb${EXE}`), ["-D", data, "-U", "postgres", "--auth=scram-sha-256", `--pwfile=${pwfile}`, "-E", "UTF8"]);
    as(join(BIN, `pg_ctl${EXE}`), ["-D", data, "-o", `-p ${PORT} -k ${tmp} -c fsync=off -c listen_addresses=127.0.0.1`, "-l", join(tmp, "pg.log"), "-w", "start"]);
    apiPort = 3300 + Math.floor(Math.random() * 500);
    const settings = (pw: string) => [`POSTGRES_PASSWORD="${pw}"`, `APP_DB_PASSWORD=${APP_PASSWORD}`, "JWT_SECRET=" + "j".repeat(40), "SECRET_ENCRYPTION_KEY=" + "ab".repeat(32), `POSTGRES_PORT=${PORT}`, "APP_BASE_URL=http://localhost:5173"].join("\r\n") + "\r\n";
    envFile = join(tmp, "good.env"); writeFileSync(envFile, "\uFEFF" + settings(PG_PASSWORD));   // as Notepad may save it
    badEnv = join(tmp, "bad.env"); writeFileSync(badEnv, settings("not-the-password"));
  }, 120_000);

  afterAll(async () => {
    api?.kill();
    try { as(join(BIN, `pg_ctl${EXE}`), ["-D", data, "-m", "immediate", "-w", "stop"]); } catch { /* already stopped */ }
    rmSync(tmp, { recursive: true, force: true });
  }, 60_000);

  it("check: says the password is wrong, says where to change it, and does not print either password", () => {
    const r = launcher(["check"], badEnv);
    expect(r.status).toBe(1);
    expect(text(r)).toMatch(/refused the password in \.env/); expect(text(r)).toContain("notepad .env");
    expect(text(r)).not.toContain("not-the-password"); expect(text(r)).not.toContain(PG_PASSWORD);
  });

  it("db with the wrong password stops before doing anything", () => {
    const r = launcher(["db"], badEnv);
    expect(r.status).toBe(1); expect(text(r)).toMatch(/refused the password/);
  });

  it("api before db: says to run the db step, and does not start", () => {
    const r = launcher(["api"]);
    expect(r.status).toBe(1); expect(text(r)).toContain("node scripts/local.mjs db");
  });

  it("check: with the right password, PostgreSQL is reachable and the database is not set up yet", () => {
    const r = launcher(["check"]);
    expect(text(r)).toContain('accepted the "postgres" login'); expect(text(r)).toContain("not set up yet");
    expect(text(r)).not.toContain(PG_PASSWORD);
  });

  it("db: creates the database, the tables, the restricted role and the control list — and can be repeated", async () => {
    const first = launcher(["db"]);
    expect(first.status, text(first)).toBe(0);
    expect(text(first)).toContain('Created database "evidenceportal"'); expect(text(first)).toContain("The database is ready");
    const again = launcher(["db"]);
    expect(again.status, text(again)).toBe(0);
    expect(text(again)).toContain("already exists"); expect(text(again)).toMatch(/already up to date/);

    const admin = await connect("postgres", PG_PASSWORD, "evidenceportal");
    try {
      expect(Number((await admin.query("SELECT count(*) FROM schema_migrations")).rows[0].count)).toBeGreaterThanOrEqual(14);
      expect(Number((await admin.query("SELECT count(*) FROM control_templates")).rows[0].count)).toBeGreaterThan(0);
    } finally { await admin.end(); }
    const app = await connect("portal_app", APP_PASSWORD, "evidenceportal");   // the restricted role exists with the password from .env
    try {
      const sup = await app.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
      expect(sup.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    } finally { await app.end(); }
  }, 120_000);

  it("check: afterwards everything shows as set up", () => {
    const r = launcher(["check"]);
    expect(text(r)).toContain('The database "evidenceportal" and the portal_app role exist');
  });

  it("admin: creates the first administrator, prints the invitation link, keeps the organisation name intact; a second run refuses", async () => {
    const r = launcher(["admin", "--org", "Dublin Audit & Co. Ltd", "--domain", "dublinaudit.example", "--email", "arjun@dublinaudit.example"]);
    expect(r.status, text(r)).toBe(0);
    expect(text(r)).toMatch(/http:\/\/localhost:5173\/accept-invite\?token=[A-Za-z0-9_-]+/);
    expect(text(r)).toContain("owner of this installation");
    const admin = await connect("postgres", PG_PASSWORD, "evidenceportal");
    try {
      const o = await admin.query("SELECT name, allowed_domains FROM orgs");
      expect(o.rows).toEqual([{ name: "Dublin Audit & Co. Ltd", allowed_domains: ["dublinaudit.example"] }]);
    } finally { await admin.end(); }
    const second = launcher(["admin", "--org", "Dublin Audit & Co. Ltd", "--domain", "dublinaudit.example", "--email", "arjun@dublinaudit.example"]);
    expect(second.status).not.toBe(0); expect(text(second)).toContain("already exists");
  }, 60_000);

  it("api: starts as portal_app, answers requests, and the database accepts its work (a sign-in attempt reaches the users table)", async () => {
    api = spawn(process.execPath, [SCRIPT, "api", "--env", envFile], { cwd: tmp, env: { ...process.env, PORT: String(apiPort), DATABASE_URL: "", POSTGRES_PORT: "" }, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    api.stdout!.on("data", (c) => (log += c)); api.stderr!.on("data", (c) => (log += c));
    const started = Date.now();
    while (!/listening on :\d+/.test(log) && Date.now() - started < 60_000) await new Promise((r) => setTimeout(r, 200));
    expect(log).toMatch(/Evidence portal API listening on :\d+/);
    const res = await fetch(`http://127.0.0.1:${apiPort}/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:5173" }, body: JSON.stringify({ email: "arjun@dublinaudit.example", password: "wrong-password-123" }) });
    expect(res.status).toBe(401);    // invited, no password yet → refused, but only after the database was consulted as portal_app
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");   // APP_BASE_URL from .env reached the server
    api.kill();
    await new Promise((r) => api!.on("exit", r));
    expect(log).not.toContain(PG_PASSWORD); expect(log).not.toContain(APP_PASSWORD);
  }, 120_000);
});

// --- launch: the labelled output of a real program ----------------------------------------------------------------------

describe("launch (what the one-window start does with each program's output)", () => {
  const sink = () => { const lines: string[] = []; return { lines, write: (t: string) => { lines.push(t); return true; } }; };

  it("puts a label in front of every line — also for CRLF line ends and lines that arrive in pieces — keeps normal output and errors apart, and reports the exit code", async () => {
    const o = sink(), e = sink(), seen: string[] = [];
    const script = 'process.stdout.write("one\\r\\ntw"); setTimeout(() => { process.stdout.write("o\\nthree"); process.stderr.write("oops\\n"); }, 60); setTimeout(() => process.exit(4), 160);';
    const h = M.launch(["-e", script], { cwd: tmpdir(), env: process.env, label: "api", onLine: (l) => seen.push(l), out: o, err: e });
    expect(await h.done).toBe(4);
    expect(o.lines).toEqual(["[api] one\n", "[api] two\n", "[api] three\n"]);
    expect(e.lines).toEqual(["[api] oops\n"]);
    expect(seen.sort()).toEqual(["one", "oops", "three", "two"]);
  });

  it("without a label the lines are shown exactly as they are", async () => {
    const o = sink();
    const h = M.launch(["-e", 'console.log("hello"); console.log("")'], { cwd: tmpdir(), env: process.env, out: o, err: sink() });
    expect(await h.done).toBe(0);
    expect(o.lines).toEqual(["hello\n", "\n"]);
  });

  it("stop() ends a program that would run forever, and done then resolves with a failure code", async () => {
    const h = M.launch(["-e", "setInterval(() => {}, 1000)"], { cwd: tmpdir(), env: process.env, out: sink(), err: sink() });
    setTimeout(() => h.stop(), 150);
    expect(await h.done).not.toBe(0);
  });

  it("gives the program no keyboard to wait on (it would hang a one-window start)", async () => {
    const o = sink();
    const h = M.launch(["-e", 'process.stdin.on("end", () => { console.log("stdin closed"); process.exit(0); }); process.stdin.resume();'], { cwd: tmpdir(), env: process.env, out: o, err: sink() });
    expect(await h.done).toBe(0);
    expect(o.lines).toEqual(["stdin closed\n"]);
  });

  it("a program that cannot be started is reported, not thrown", async () => {
    const e = sink();
    const h = M.launch(["-e", "1"], { cwd: join(tmpdir(), "does-not-exist-" + Date.now()), env: process.env, label: "web", out: sink(), err: e });
    expect(await h.done).toBe(1);
    expect(e.lines.join("")).toMatch(/\[web\] Could not start/);
  });
});

// --- start, for real ------------------------------------------------------------------------------------------------------

describe("start for real: PostgreSQL with a password, the real API and web servers, Ctrl+C", () => {
  const PORT = 54331;
  const PG_PASSWORD = "S#t@rt:pw/1 x";
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const PLATFORM = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  const EXE = process.platform === "win32" ? ".exe" : "";
  const BIN = resolve(REPO, `node_modules/@embedded-postgres/${PLATFORM}/native/bin`);
  let clusterDir: string, root: string, envFile: string, apiPort: number, webPort: number;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const as = (cmd: string, args: string[]) => (isRoot ? execFileSync("runuser", ["-u", "pguser", "--", cmd, ...args], { stdio: "pipe" }) : execFileSync(cmd, args, { stdio: "pipe" }));
  const freePort = () => new Promise<number>((ok) => { const s = createServer(); s.listen(0, () => { const { port } = s.address() as AddressInfo; s.close(() => ok(port)); }); });
  const baseEnv = () => ({ ...process.env, PORT: String(apiPort), WEB_PORT: String(webPort), DATABASE_URL: "", POSTGRES_PORT: "" });
  const FLAGS = ["--org", "Dublin Audit & Co. Ltd", "--domain", "dublinaudit.example", "--email", "arjun@dublinaudit.example"];

  /** Runs `start` as a real child; `waitFor` polls its combined output. */
  const startChild = (extra: string[]) => {
    const child = spawn(process.execPath, [join(root, "scripts", "local.mjs"), "start", ...extra, "--env", envFile], { cwd: root, env: baseEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout!.on("data", (d) => (out += d)); child.stderr!.on("data", (d) => (out += d));
    const exited = new Promise<number | null>((ok) => child.on("close", (code) => ok(code)));
    const waitFor = async (re: RegExp, ms = 90_000) => { const t0 = Date.now(); while (!re.test(out) && Date.now() - t0 < ms) await sleep(100); expect(out).toMatch(re); };
    return { child, exited, output: () => out, waitFor };
  };

  beforeAll(async () => {
    clusterDir = mkdtempSync(join(tmpdir(), "launcher-start-pg-"));
    if (isRoot) execFileSync("chown", ["pguser", clusterDir]);
    const pwfile = join(clusterDir, "pw.txt"); writeFileSync(pwfile, PG_PASSWORD + "\n"); if (isRoot) execFileSync("chown", ["pguser", pwfile]);
    as(join(BIN, `initdb${EXE}`), ["-D", join(clusterDir, "data"), "-U", "postgres", "--auth=scram-sha-256", `--pwfile=${pwfile}`, "-E", "UTF8"]);
    as(join(BIN, `pg_ctl${EXE}`), ["-D", join(clusterDir, "data"), "-o", `-p ${PORT} -k ${clusterDir} -c fsync=off -c listen_addresses=127.0.0.1`, "-l", join(clusterDir, "pg.log"), "-w", "start"]);

    // A small project folder with a space in its name (like C:\Users\Jane Doe\…): the launcher and web server are real copies,
    // the code and libraries are links to this project, and the web app is a stand-in page.
    root = mkdtempSync(join(tmpdir(), "launcher start e2e-"));
    mkdirSync(join(root, "scripts"), { recursive: true });
    copyFileSync(SCRIPT, join(root, "scripts", "local.mjs")); copyFileSync(resolve(REPO, "scripts/serve-web.mjs"), join(root, "scripts", "serve-web.mjs"));
    for (const d of ["node_modules", "src", "db"]) symlinkSync(join(REPO, d), join(root, d), "dir");
    mkdirSync(join(root, "frontend", "dist"), { recursive: true }); writeFileSync(join(root, "frontend", "dist", "index.html"), "<html>stub app</html>");

    apiPort = await freePort(); webPort = await freePort();
    envFile = join(root, ".env");
    writeFileSync(envFile, [`POSTGRES_PASSWORD="${PG_PASSWORD}"`, "APP_DB_PASSWORD=" + "z".repeat(24), "JWT_SECRET=" + "j".repeat(40), "SECRET_ENCRYPTION_KEY=" + "cd".repeat(32), `POSTGRES_PORT=${PORT}`, `APP_BASE_URL=http://localhost:${webPort}`].join("\r\n") + "\r\n");
  }, 120_000);

  afterAll(() => {
    try { as(join(BIN, `pg_ctl${EXE}`), ["-D", join(clusterDir, "data"), "-m", "immediate", "-w", "stop"]); } catch { /* already stopped */ }
    rmSync(clusterDir, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it("the first time, with no administrator and no details: prepares the database, then asks for the details and starts nothing", async () => {
    const r = startChild([]);
    expect(await r.exited).toBe(2);
    expect(r.output()).toContain("There is no administrator yet"); expect(r.output()).toContain("--org");
    expect(await M0.portIsFree(apiPort)).toBe(true); expect(await M0.portIsFree(webPort)).toBe(true);
  }, 120_000);

  it("with the details: creates the administrator, runs both servers in one window with labelled output, announces the link — and Ctrl+C stops everything", async () => {
    const r = startChild(FLAGS);
    await r.waitFor(/The portal is running/);
    const out = r.output();
    expect(out).toMatch(/^\[api\] .*listening on :\d+/m); expect(out).toMatch(/^\[web\] Web app: http/m);
    expect(out).toMatch(new RegExp(`http://localhost:${webPort}/accept-invite\\?token=[A-Za-z0-9_-]+`));
    expect(out).toContain(`Open it here:  http://localhost:${webPort}`);
    expect(out).not.toContain(PG_PASSWORD);

    expect((await fetch(`http://127.0.0.1:${webPort}/`)).status).toBe(200);
    const login = await fetch(`http://127.0.0.1:${apiPort}/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: `http://localhost:${webPort}` }, body: JSON.stringify({ email: "arjun@dublinaudit.example", password: "wrong-password-123" }) });
    expect(login.status).toBe(401);                                                  // the API works, as the restricted role
    expect(login.headers.get("access-control-allow-origin")).toBe(`http://localhost:${webPort}`);

    r.child.kill("SIGINT");                                                          // Ctrl+C
    expect(await r.exited).toBe(0);
    expect(r.output()).toContain("Stopping");
    expect(await M0.portIsFree(apiPort)).toBe(true); expect(await M0.portIsFree(webPort)).toBe(true);   // nothing left running
  }, 180_000);

  it("the next time, plain start is enough: no administrator step, no sign-in link, same clean stop", async () => {
    const r = startChild([]);
    await r.waitFor(/The portal is running/);
    expect(r.output()).not.toContain("accept-invite");
    expect((await fetch(`http://127.0.0.1:${webPort}/`)).status).toBe(200);
    r.child.kill("SIGINT");
    expect(await r.exited).toBe(0);
    expect(await M0.portIsFree(apiPort)).toBe(true); expect(await M0.portIsFree(webPort)).toBe(true);
  }, 180_000);

  it.skipIf(process.platform !== "linux")("if the API is killed, the web app is stopped as well and the command ends with a failure — nothing is left holding a port", async () => {
    const r = startChild([]);
    await r.waitFor(/The portal is running/);
    const kids = execFileSync("pgrep", ["-P", String(r.child.pid)]).toString().trim().split("\n");
    const api = kids.find((pid) => readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("server.ts"));
    expect(api, "the API process").toBeTruthy();
    process.kill(Number(api), "SIGKILL");
    expect(await r.exited).not.toBe(0);
    expect(r.output()).toMatch(/The API stopped unexpectedly/);
    expect(await M0.portIsFree(webPort)).toBe(true); expect(await M0.portIsFree(apiPort)).toBe(true);
  }, 180_000);

  it("a taken port is reported before anything starts", async () => {
    const holder = createServer(); await new Promise<void>((ok) => holder.listen(apiPort, ok));
    try {
      const r = startChild([]);
      expect(await r.exited).toBe(1);
      expect(r.output()).toContain(`Port ${apiPort} (needed by the API) is already in use`);
      expect(await M0.portIsFree(webPort)).toBe(true);
    } finally { holder.close(); }
  }, 60_000);
});
let M0: { portIsFree(p: number): Promise<boolean> };
beforeAll(async () => { M0 = (await import(pathToFileURL(SCRIPT).href)) as typeof M0; });

// --- "am I the main file?" ---------------------------------------------------------------------------------------------------

describe("isMainModule (decides whether `tsx src/server.ts` starts the server)", () => {
  let outer: string;
  beforeAll(() => { outer = mkdtempSync(join(tmpdir(), "is main-")); });   // a space, as in "C:\\Users\\Jane Doe\\…"
  afterAll(() => rmSync(outer, { recursive: true, force: true }));

  it("is true for the file that was run, including when its folder name has a space or sits behind a link", () => {
    const real = join(outer, "my folder"); mkdirSync(real, { recursive: true });
    const file = join(real, "entry.ts"); writeFileSync(file, "");
    const link = join(outer, "linked"); symlinkSync(real, link, "dir");
    expect(isMainModule(pathToFileURL(file).href, file)).toBe(true);
    expect(isMainModule(pathToFileURL(file).href, join(link, "entry.ts"))).toBe(true);
    expect(pathToFileURL(file).href).toContain("%20");   // exactly why `file://${argv[1]}` never matched
  });
  it("is false for a different file, for no argument, and for a path that does not exist", () => {
    const a = join(outer, "a.ts"), b = join(outer, "b.ts"); writeFileSync(a, ""); writeFileSync(b, "");
    expect(isMainModule(pathToFileURL(a).href, b)).toBe(false);
    expect(isMainModule(pathToFileURL(a).href, "")).toBe(false);          // no script path at all (an empty argument; undefined would just use the real one)
    expect(isMainModule(pathToFileURL(a).href, join(outer, "missing.ts"))).toBe(false);
  });
  it("the real server file starts up and reports its problem when run from a folder with a space in its name (it used to print nothing and exit 0)", () => {
    const spaced = join(outer, "project copy"); symlinkSync(REPO, spaced, "dir");
    const r = spawnSync(process.execPath, M.programArgs(spaced, "src/server.ts"), { cwd: REPO, encoding: "utf8", timeout: 60_000, env: { ...process.env, DATABASE_URL: "", JWT_SECRET: "" } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Missing required environment variable/);
  });
});

