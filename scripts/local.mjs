#!/usr/bin/env node
/**
 * Runs the portal on this computer without Docker — and without any shell syntax, so the very same commands work in
 * Windows PowerShell, Windows cmd, and Linux/macOS terminals.
 *
 *   node scripts/local.mjs check      look at this computer and say what is missing or wrong (changes nothing)
 *   node scripts/local.mjs start      ONE command: prepares the database, runs the API and the web app together in this window
 *                                     (the first time, add --org "Your Firm" --domain yourfirm.example --email you@yourfirm.example
 *                                     to create the first administrator too). Ctrl+C stops both.
 * and, one step at a time, if you prefer:
 *   node scripts/local.mjs db         create the database, the tables, the restricted portal_app role and the ISO 27001 controls
 *   node scripts/local.mjs admin --org "Your Firm" --domain yourfirm.example --email you@yourfirm.example
 *   node scripts/local.mjs api        start the API (leave the window open)
 *   node scripts/local.mjs web        start the web app (a second window, leave it open)
 *
 * Why it exists: the Linux instructions use `set -a; . ./.env`, `export`, `sudo -u postgres` and `VAR=value command`,
 * none of which exist in Windows. This reads .env itself, builds the database addresses (including passwords that
 * contain characters like @ or #), and starts the existing programs with the right settings.
 *
 * Settings come from .env (made by `node scripts/init-env.mjs`). Values already present in the environment win over
 * .env, as with most tools. Optional extra lines for .env:
 *   POSTGRES_USER=postgres     the PostgreSQL administrator (default postgres)
 *   POSTGRES_HOST=127.0.0.1    where PostgreSQL runs (default this computer)
 *   POSTGRES_PORT=5432         its port (the Windows installer offers 5432, or 5433 if 5432 is taken)
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DATABASE_NAME = "evidenceportal";

const USAGE = `Runs the portal on this computer without Docker (same commands in PowerShell, cmd and Linux/macOS terminals).

  node scripts/local.mjs check     look at this computer and say what is missing or wrong (changes nothing)
  node scripts/local.mjs start     the one command: prepares the database, then runs the API and the web app together in
                                   this window; Ctrl+C stops both. The first time, also give the first administrator:
  node scripts/local.mjs start --org "Your Firm" --domain yourfirm.example --email you@yourfirm.example

One step at a time instead:
  node scripts/local.mjs db        create the database, tables and ISO 27001 control list (safe to repeat)
  node scripts/local.mjs admin --org "Your Firm" --domain yourfirm.example --email you@yourfirm.example
                                   create the first administrator; prints the link where they set a password
  node scripts/local.mjs api       start the API only (leave this window open)
  node scripts/local.mjs web       start the web app only (use a second window, leave it open)

  --env <file>   read the settings from another file than .env in the project folder`;

class UsageError extends Error {}

// --- .env ----------------------------------------------------------------------------------------------------------

/**
 * Reads the text of a .env file. Understands what Windows editors produce (a byte-order mark at the start, CRLF line
 * ends), `export NAME=value`, comments, and values in single or double quotes. Anything after the closing quote is ignored;
 * in an unquoted value, a space followed by # starts a comment.
 */
export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();   // trim() also removes the byte-order mark Notepad can put at the very start of a file
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      const end = value.indexOf(quote, 1);
      value = end === -1 ? value.slice(1) : value.slice(1, end);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    out[m[1]] = value;
  }
  return out;
}

/** postgres://user:password@host:port/database, with every part encoded so a password like p@ss:w/rd#1 still works. */
export function databaseUrl({ user, password, host, port, database }) {
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
}

const isPlaceholder = (v) => /^change-me/i.test(v);

/** Names of settings that are missing or still the placeholder from .env.example. */
export function problemsWith(settings, names) {
  const out = [];
  for (const n of names) {
    const v = settings[n];
    if (v === undefined || v === "") out.push(`${n} has no value`);
    else if (isPlaceholder(v)) out.push(`${n} is still the placeholder "${v}"`);
  }
  return out;
}

/** The PostgreSQL connection details the portal uses, from the merged settings. */
export function postgresConfig(settings) {
  const port = Number(settings.POSTGRES_PORT || 5432);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError(`POSTGRES_PORT must be a port number such as 5432 (found "${settings.POSTGRES_PORT}").`);
  return {
    host: settings.POSTGRES_HOST || "127.0.0.1",
    port,
    adminUser: settings.POSTGRES_USER || "postgres",
    adminPassword: settings.POSTGRES_PASSWORD ?? "",
    appPassword: settings.APP_DB_PASSWORD ?? "",
  };
}

const adminUrl = (pg, database = DATABASE_NAME) => databaseUrl({ user: pg.adminUser, password: pg.adminPassword, host: pg.host, port: pg.port, database });
const appUrl = (pg) => databaseUrl({ user: "portal_app", password: pg.appPassword, host: pg.host, port: pg.port, database: DATABASE_NAME });

// --- Explaining errors in plain words --------------------------------------------------------------------------------

/** Turns a PostgreSQL connection error into what the person should do about it. `who` is "admin" or "app". */
export function explainPgError(e, pg, who) {
  const code = e?.code ?? e?.errors?.[0]?.code;
  const at = `${pg.host}:${pg.port}`;
  if (code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "EHOSTUNREACH" || code === "ENOTFOUND") {
    return `Cannot reach PostgreSQL at ${at} (${code}). Is it running? On Windows: press the Windows key, type "Services", open it, find "postgresql-x64-…", and choose Start. ` +
      `If PostgreSQL uses another port (the Windows installer shows it), add a line POSTGRES_PORT=<that number> to .env.`;
  }
  if (code === "28P01" || code === "28000") {
    return who === "admin"
      ? `PostgreSQL refused the password in .env (POSTGRES_PASSWORD) for the user "${pg.adminUser}". POSTGRES_PASSWORD must be the password you typed in the PostgreSQL installer. ` +
        `Open .env (type: notepad .env), change that line, save, and run this again.`
      : `PostgreSQL refused the portal_app login. Run  node scripts/local.mjs db  first (it creates that role), and do not change APP_DB_PASSWORD in .env afterwards.`;
  }
  if (code === "3D000") return `The database "${DATABASE_NAME}" does not exist yet. Run  node scripts/local.mjs db  first.`;
  if (code === "42501") return `PostgreSQL says the user lacks permission (${e.message}). POSTGRES_USER in .env must be a PostgreSQL administrator, normally "postgres".`;
  return `Could not use PostgreSQL at ${at}: ${e?.message ?? e}`;
}

// --- Looking at the installation (no network, no changes) --------------------------------------------------------------

/**
 * What is wrong with the files here: Node's version, the libraries (including the one that must match this computer's
 * kind of processor), the built web app, and .env. Pure — the caller says which computer this is, so tests can pretend.
 * Returns [{ level: "ok"|"warn"|"fail", text, hint? }].
 */
export function inspectInstall({ root, platform, arch, nodeVersion, settings, envFileExists, envPath }) {
  const out = [];
  const add = (level, text, hint) => out.push({ level, text, ...(hint ? { hint } : {}) });

  const major = Number(String(nodeVersion).replace(/^v/, "").split(".")[0]);
  if (major === 22 || major === 24) add("ok", `Node.js ${nodeVersion} (22 and 24 are the tested versions)`);
  else if (major >= 20) add("warn", `Node.js ${nodeVersion} — only 22 and 24 were tested; if something odd happens, install 22 or 24`);
  else add("fail", `Node.js ${nodeVersion} is too old`, "Install Node.js 22 or 24 from https://nodejs.org (the LTS button), then open a new terminal.");

  const modules = join(root, "node_modules");
  if (!existsSync(tsxLoader(root)) || !existsSync(join(modules, "pg"))) {
    add("fail", "The libraries (the node_modules folder) are missing", "This download normally includes them. If you got the code from GitHub, run:  npm ci --omit=dev   (needs internet access to npm).");
  } else {
    const want = `${platform}-${arch}`;
    const have = existsSync(join(modules, "@esbuild")) ? readdirSync(join(modules, "@esbuild")).sort() : [];
    if (have.includes(want)) add("ok", `The libraries are here and match this computer (${want})`);
    else if (have.length) add("fail", `The libraries were packaged for ${have.join(" / ")}, but this computer is ${want}`, `Use the download made for ${platform}, or run:  npm ci --omit=dev   (this deletes node_modules and needs internet access to npm).`);
    else add("fail", "The libraries are incomplete (no @esbuild folder)", "Run:  npm ci --omit=dev");
  }

  if (existsSync(join(root, "frontend", "dist", "index.html"))) add("ok", "The web app is built (frontend/dist)");
  else add("fail", "The built web app is missing (frontend/dist/index.html)", "This download normally includes it. Otherwise build it once:  cd frontend  then  npm ci  then  npm run build");

  if (!envFileExists) {
    add("fail", `The settings file is missing (${envPath})`, "Create it, with fresh secrets:  node scripts/init-env.mjs");
  } else {
    const bad = problemsWith(settings, ["POSTGRES_PASSWORD", "APP_DB_PASSWORD", "JWT_SECRET"]);
    if (bad.length) add("fail", `.env is not ready: ${bad.join("; ")}`, "For a new .env with fresh secrets, move this one away and run:  node scripts/init-env.mjs");
    else add("ok", ".env has the passwords and secrets");
    if (!settings.SECRET_ENCRYPTION_KEY) add("warn", "SECRET_ENCRYPTION_KEY is not set in .env — Google Drive, mail passwords and two-step sign-in cannot be stored without it", "Add a line  SECRET_ENCRYPTION_KEY=<64 hex characters>  (node scripts/init-env.mjs writes one into a new .env).");
  }
  return out;
}

// --- Things that touch this computer (replaceable in tests) --------------------------------------------------------

function tryListen(port, host) {
  return new Promise((ok) => {
    const s = net.createServer();
    s.once("error", () => ok(false));
    s.listen(port, host, () => s.close(() => ok(true)));
  });
}
/** True when nothing is using the port (checked the way the API and the web app would take it). */
export async function portIsFree(port) {
  return (await tryListen(port, "127.0.0.1")) && (await tryListen(port, undefined));
}

async function connectPg(url) {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await client.connect();
  return client;
}

/** Runs `node <args>` here, passing the keyboard and screen straight through, and resolves with its exit code. */
function runNode(args, { cwd, env }) {
  return new Promise((ok) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: "inherit", windowsHide: false });
    const forward = (sig) => () => { try { child.kill(sig); } catch { /* already gone */ } };
    const onInt = forward("SIGINT"), onTerm = forward("SIGTERM");
    process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
    const done = (code) => { process.off("SIGINT", onInt); process.off("SIGTERM", onTerm); ok(code); };
    child.on("error", (e) => { console.error(`Could not start: ${e.message}`); done(1); });
    child.on("exit", (code) => done(code ?? 1));
  });
}

/**
 * Starts `node <args>` with its output captured: every line is shown with a label in front ("[api] …") and also handed to
 * `onLine`, so the caller can tell when it is ready. Returns { done, stop }: `done` resolves with the exit code once the
 * program has ended and all its output was shown; `stop()` ends it. One process only (no wrapper), so stopping it really
 * stops it — on Windows a forced stop of a wrapper would leave the server running behind it.
 */
export function launch(args, { cwd, env, label, onLine, out = process.stdout, err = process.stderr }) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const tag = label ? `[${label}] ` : "";
  const pump = (stream, out) => {
    let buffer = "";
    const emit = (line) => { out.write(`${tag}${line}\n`); onLine?.(line); };
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf("\n")) !== -1) { emit(buffer.slice(0, i).replace(/\r$/, "")); buffer = buffer.slice(i + 1); }
    });
    stream.on("end", () => { if (buffer) emit(buffer.replace(/\r$/, "")); buffer = ""; });
  };
  pump(child.stdout, out);
  pump(child.stderr, err);
  const done = new Promise((ok) => {
    child.on("error", (e) => { err.write(`${tag}Could not start: ${e.message}\n`); ok(1); });
    child.on("close", (code) => ok(code ?? 1));
  });
  return { done, stop: () => { try { child.kill(); } catch { /* already gone */ } } };
}

/** Calls `callback` when the person presses Ctrl+C (or the system asks the program to stop). Returns a function that stops listening. */
export function onInterrupt(callback) {
  const handler = () => callback();
  process.on("SIGINT", handler); process.on("SIGTERM", handler);
  return () => { process.off("SIGINT", handler); process.off("SIGTERM", handler); };
}

export const realDeps = () => ({
  root: ROOT,
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  env: process.env,
  home: os.homedir(),
  portIsFree,
  connectPg,
  runNode,
  launch,
  onInterrupt,
});

// --- Commands ------------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  const names = { "--env": "env", "--org": "org", "--domain": "domain", "--email": "email" };
  for (let i = 0; i < rest.length; i++) {
    const name = names[rest[i]];
    if (!name) throw new UsageError(`Unknown option: ${rest[i]}`);
    const value = rest[++i];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${rest[i - 1]} needs a value.`);
    flags[name] = value;
  }
  return { command, flags };
}

function mergedSettings(deps, envPath) {
  const exists = existsSync(envPath);
  const fromFile = exists ? parseEnv(readFileSync(envPath, "utf8")) : {};
  // What is already set in the environment wins, like with other tools that read .env.
  const settings = { ...fromFile };
  for (const [k, v] of Object.entries(deps.env)) if (v !== undefined && v !== "" && k in fromFile) settings[k] = v;
  for (const k of ["POSTGRES_USER", "POSTGRES_HOST", "POSTGRES_PORT"]) if (deps.env[k]) settings[k] = deps.env[k];
  return { settings, exists };
}

const LEVEL = { ok: "[ ok ]", warn: "[warn]", fail: "[FAIL]" };

async function check(deps, io, envPath) {
  const { settings, exists } = mergedSettings(deps, envPath);
  const results = inspectInstall({ root: deps.root, platform: deps.platform, arch: deps.arch, nodeVersion: deps.nodeVersion, settings, envFileExists: exists, envPath });

  for (const port of [3000, 5173]) {
    if (await deps.portIsFree(port)) results.push({ level: "ok", text: `Port ${port} is free` });
    else results.push({ level: "warn", text: `Port ${port} is already in use`, hint: port === 3000 ? "The API needs it: stop the other program, or an earlier copy of the portal (Ctrl+C in its window)." : "The web app needs it: stop the other program, or an earlier copy of the web app." });
  }

  if (exists && !problemsWith(settings, ["POSTGRES_PASSWORD"]).length) {
    const pg = postgresConfig(settings);
    let admin;
    try {
      admin = await deps.connectPg(adminUrl(pg, "postgres"));
      results.push({ level: "ok", text: `PostgreSQL at ${pg.host}:${pg.port} accepted the "${pg.adminUser}" login` });
      const db = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [DATABASE_NAME]);
      const role = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'portal_app'");
      if (db.rowCount && role.rowCount) results.push({ level: "ok", text: `The database "${DATABASE_NAME}" and the portal_app role exist` });
      else results.push({ level: "warn", text: `The database "${DATABASE_NAME}" is not set up yet`, hint: "Next step:  node scripts/local.mjs db" });
    } catch (e) {
      results.push({ level: "fail", text: explainPgError(e, pg, "admin") });
    } finally {
      await admin?.end().catch(() => {});
    }
  }

  io.log("");
  let fails = 0, warns = 0;
  for (const r of results) {
    io.log(`  ${LEVEL[r.level]} ${r.text}`);
    if (r.hint) io.log(`         ${r.hint}`);
    if (r.level === "fail") fails++; else if (r.level === "warn") warns++;
  }
  io.log("");
  if (fails) io.log(`  ${fails} problem(s), ${warns} warning(s). Fix the [FAIL] lines first.`);
  else io.log(warns ? `  No blocking problems, ${warns} warning(s).` : "  All good.");
  return fails ? 1 : 0;
}

function needSettings(deps, envPath, names, io) {
  const { settings, exists } = mergedSettings(deps, envPath);
  if (!exists) { io.error(`The settings file ${envPath} does not exist. Create it first, with fresh secrets:  node scripts/init-env.mjs`); return null; }
  const bad = problemsWith(settings, names);
  if (bad.length) { io.error(`.env is not ready: ${bad.join("; ")}. For a new .env with fresh secrets, move this one away and run:  node scripts/init-env.mjs`); return null; }
  return settings;
}

/**
 * Where "keep the evidence on this computer's disk" puts the files. A line LOCAL_STORAGE_DIR=… in .env decides; without
 * one, a folder in the user's own profile (EvidencePortal/files), NOT inside the portal's folder: a newer version of the
 * portal is usually unpacked into a new folder, and evidence files must not stay behind in the old one.
 */
export function evidenceFolder(settings, deps) {
  const chosen = settings.LOCAL_STORAGE_DIR || deps.env.LOCAL_STORAGE_DIR;
  return chosen || join(deps.home ?? os.homedir(), "EvidencePortal", "files");
}

/** tsx's loader. Loading it with `node --import` runs the TypeScript file in ONE process (its command-line wrapper would add a second). */
export const tsxLoader = (root) => join(root, "node_modules", "tsx", "dist", "esm", "index.mjs");
/** The arguments that run one of the portal's own TypeScript files. */
export const programArgs = (root, file) => ["--import", pathToFileURL(tsxLoader(root)).href, join(root, file)];

function needTsx(deps, io) {
  if (existsSync(tsxLoader(deps.root))) return true;
  io.error("The libraries (node_modules) are missing, so nothing can start. Run  node scripts/local.mjs check  to see what to do.");
  return false;
}

/** Runs one of the portal's own programs (a TypeScript file) with the settings it needs. */
const runProgram = (deps, file, extraEnv) =>
  deps.runNode(programArgs(deps.root, file), { cwd: deps.root, env: { ...deps.env, ...extraEnv } });

async function ensureDatabase(deps, pg, io) {
  let admin;
  try {
    admin = await deps.connectPg(adminUrl(pg, "postgres"));
    const found = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [DATABASE_NAME]);
    if (found.rowCount) { io.log(`Database "${DATABASE_NAME}" already exists.`); return true; }
    await admin.query(`CREATE DATABASE ${DATABASE_NAME}`);   // a constant, never user input
    io.log(`Created database "${DATABASE_NAME}".`);
    return true;
  } catch (e) {
    io.error(explainPgError(e, pg, "admin"));
    return false;
  } finally {
    await admin?.end().catch(() => {});
  }
}

/** Creates the database if needed, then applies the migrations and loads the control list. Returns an exit code (0 = ready). */
async function prepareDatabase(deps, io, pg, settings) {
  if (!(await ensureDatabase(deps, pg, io))) return 1;
  const env = { ...settings, DATABASE_URL: adminUrl(pg) };
  for (const file of ["src/db/migrate-cli.ts", "src/db/seed-cli.ts"]) {
    const code = await runProgram(deps, file, env);
    if (code !== 0) { io.error(`Stopped: ${file} failed (exit code ${code}).`); return code || 1; }
  }
  return 0;
}

async function dbCommand(deps, io, envPath) {
  const settings = needSettings(deps, envPath, ["POSTGRES_PASSWORD", "APP_DB_PASSWORD"], io); if (!settings) return 1;
  if (!needTsx(deps, io)) return 1;
  const pg = postgresConfig(settings);
  const code = await prepareDatabase(deps, io, pg, settings);
  if (code) return code;
  io.log("\nThe database is ready. Next:  node scripts/local.mjs admin --org \"Your Firm\" --domain yourfirm.example --email you@yourfirm.example");
  return 0;
}

function checkAdminFlags(flags) {
  const missing = ["org", "domain", "email"].filter((k) => !flags[k]);
  if (missing.length) throw new UsageError(`The first administrator needs ${missing.map((k) => "--" + k).join(", ")}.\nExample: --org "Your Firm" --domain yourfirm.example --email you@yourfirm.example`);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(flags.email)) throw new UsageError(`--email must look like you@yourfirm.example (got "${flags.email}").`);
  if (/[\s@/]/.test(flags.domain)) throw new UsageError(`--domain is the part after the @, like yourfirm.example (got "${flags.domain}").`);
}

async function adminCommand(deps, io, envPath, flags) {
  checkAdminFlags(flags);
  const settings = needSettings(deps, envPath, ["POSTGRES_PASSWORD"], io); if (!settings) return 1;
  if (!needTsx(deps, io)) return 1;
  const pg = postgresConfig(settings);
  let probe;
  try { probe = await deps.connectPg(adminUrl(pg)); }
  catch (e) { io.error(explainPgError(e, pg, "admin")); return 1; }
  finally { await probe?.end().catch(() => {}); }
  return runProgram(deps, "src/db/bootstrap-admin-cli.ts", { ...settings, DATABASE_URL: adminUrl(pg), ORG_NAME: flags.org, ORG_DOMAIN: flags.domain, ADMIN_EMAIL: flags.email });
}

async function apiCommand(deps, io, envPath) {
  const settings = needSettings(deps, envPath, ["APP_DB_PASSWORD", "JWT_SECRET"], io); if (!settings) return 1;
  if (!needTsx(deps, io)) return 1;
  const pg = postgresConfig(settings);
  let probe;
  try { probe = await deps.connectPg(appUrl(pg)); }
  catch (e) { io.error(explainPgError(e, pg, "app")); return 1; }
  finally { await probe?.end().catch(() => {}); }
  io.log("Starting the API as the restricted portal_app database role. Leave this window open; stop it with Ctrl+C.");
  return runProgram(deps, "src/server.ts", { ...settings, LOCAL_STORAGE_DIR: evidenceFolder(settings, deps), DATABASE_URL: appUrl(pg) });
}

async function webCommand(deps, io) {
  if (!existsSync(join(deps.root, "frontend", "dist", "index.html"))) { io.error("The built web app is missing (frontend/dist/index.html). Run  node scripts/local.mjs check  to see what to do."); return 1; }
  return deps.runNode([join(deps.root, "scripts", "serve-web.mjs")], { cwd: deps.root, env: { ...deps.env } });
}

/** A setting that may come from .env or from the real environment, as a port number. */
function portSetting(deps, settings, name, fallback) {
  const raw = settings[name] || deps.env[name] || String(fallback);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new UsageError(`${name} must be a port number such as ${fallback} (found "${raw}").`);
  return n;
}

const INVITE_LINK = /https?:\/\/\S*\/accept-invite\?token=[A-Za-z0-9_-]+/;

/**
 * The one command: checks the ports, prepares the database (safe to repeat), creates the first administrator when there is
 * none yet, then runs the API and the web app together in this window until Ctrl+C — or until either of them stops, in
 * which case the other is stopped too, so nothing is left running by accident.
 */
async function startCommand(deps, io, envPath, flags) {
  const wantsAdmin = ["org", "domain", "email"].some((k) => flags[k]);
  if (wantsAdmin) checkAdminFlags(flags);
  const settings = needSettings(deps, envPath, ["POSTGRES_PASSWORD", "APP_DB_PASSWORD", "JWT_SECRET"], io); if (!settings) return 1;
  if (!needTsx(deps, io)) return 1;
  if (!existsSync(join(deps.root, "frontend", "dist", "index.html"))) { io.error("The built web app is missing (frontend/dist/index.html). Run  node scripts/local.mjs check  to see what to do."); return 1; }

  const apiPort = portSetting(deps, settings, "PORT", 3000), webPort = portSetting(deps, settings, "WEB_PORT", 5173);
  for (const [port, what] of [[apiPort, "API"], [webPort, "web app"]]) {
    if (!(await deps.portIsFree(port))) {
      io.error(`Port ${port} (needed by the ${what}) is already in use — most likely an earlier copy of the portal is still running in another window. Close that window (or press Ctrl+C in it) and try again; if it was closed by mistake, restarting the computer clears it.`);
      return 1;
    }
  }

  const pg = postgresConfig(settings);
  io.log("Preparing the database…");
  const prepared = await prepareDatabase(deps, io, pg, settings);
  if (prepared) return prepared;

  // Is there an administrator yet? (The PostgreSQL administrator is not held back by the row-level rules.)
  let hasUsers;
  let admin;
  try { admin = await deps.connectPg(adminUrl(pg)); hasUsers = (await admin.query("SELECT 1 FROM users LIMIT 1")).rowCount > 0; }
  catch (e) { io.error(explainPgError(e, pg, "admin")); return 1; }
  finally { await admin?.end().catch(() => {}); }

  let inviteLink;
  if (!hasUsers) {
    if (!wantsAdmin) {
      io.error('There is no administrator yet. The first time, give the first administrator\'s details in the same command:\n\n  node scripts/local.mjs start --org "Your Firm" --domain yourfirm.example --email you@yourfirm.example\n\nThey become the owner of this installation. After that, plain  node scripts/local.mjs start  is enough.');
      return 2;
    }
    io.log("Creating the first administrator…");
    const created = await deps.launch(programArgs(deps.root, "src/db/bootstrap-admin-cli.ts"), {
      cwd: deps.root,
      env: { ...deps.env, ...settings, DATABASE_URL: adminUrl(pg), ORG_NAME: flags.org, ORG_DOMAIN: flags.domain, ADMIN_EMAIL: flags.email },
      onLine: (line) => { inviteLink ??= line.match(INVITE_LINK)?.[0]; },
    }).done;
    if (created !== 0) { io.error(`Stopped: creating the administrator failed (exit code ${created}).`); return created || 1; }
  } else if (wantsAdmin) {
    io.log("An administrator already exists, so --org, --domain and --email were not used.");
  }

  // The API must be able to sign in as the restricted role before anything is started.
  let probe;
  try { probe = await deps.connectPg(appUrl(pg)); }
  catch (e) { io.error(explainPgError(e, pg, "app")); return 1; }
  finally { await probe?.end().catch(() => {}); }

  let apiReady = false, webReady = false, announce = () => {};
  const bothReady = new Promise((ok) => { announce = () => { if (apiReady && webReady) ok(); }; });
  const pick = (names) => Object.fromEntries(names.filter((n) => settings[n]).map((n) => [n, settings[n]]));
  const api = deps.launch(programArgs(deps.root, "src/server.ts"), {
    cwd: deps.root, label: "api",
    env: { ...deps.env, ...settings, LOCAL_STORAGE_DIR: evidenceFolder(settings, deps), DATABASE_URL: appUrl(pg) },
    onLine: (line) => { if (/listening on :\d+/.test(line)) { apiReady = true; announce(); } },
  });
  const web = deps.launch([join(deps.root, "scripts", "serve-web.mjs")], {
    cwd: deps.root, label: "web",
    env: { ...deps.env, ...pick(["WEB_PORT", "WEB_HOST"]) },
    onLine: (line) => { if (/^Web app: http/.test(line)) { webReady = true; announce(); } },
  });

  let interrupted = false, stopped = false;
  const stopAll = () => { if (stopped) return; stopped = true; api.stop(); web.stop(); };
  const unsubscribe = deps.onInterrupt(() => { if (!interrupted) io.log("\nStopping…"); interrupted = true; stopAll(); });
  const firstExit = Promise.race([api.done.then((code) => ({ who: "API", code })), web.done.then((code) => ({ who: "web app", code }))]);
  try {
    const outcome = await Promise.race([firstExit, bothReady.then(() => null)]);
    if (outcome) {   // one of them ended before both were ready
      stopAll(); await Promise.all([api.done, web.done]);
      if (interrupted) return 0;
      io.error(`The ${outcome.who} stopped before it was ready (exit code ${outcome.code}) — its own messages are above.`);
      return outcome.code || 1;
    }
    const base = (settings.APP_BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
    io.log("");
    io.log("  ───────────────────────────────────────────────────────────────");
    io.log("  The portal is running.");
    io.log(`    Open it here:  ${base}`);
    if (inviteLink) io.log(`    First sign-in (choose the administrator's password):\n      ${inviteLink}`);
    io.log(`    Files kept on this computer (if an organisation chooses "this server's disk"):\n      ${evidenceFolder(settings, deps)}`);
    io.log("    Stop it:       press Ctrl+C in this window");
    io.log("  ───────────────────────────────────────────────────────────────");
    io.log("");
    const ended = await firstExit;
    if (!interrupted) { io.error(`The ${ended.who} stopped unexpectedly (exit code ${ended.code}); stopping the other part too.`); stopAll(); }
    await Promise.all([api.done, web.done]);
    return interrupted ? 0 : (ended.code || 1);
  } finally {
    unsubscribe();
  }
}

/** Runs the launcher. `deps` is injectable for tests. Returns the exit code. */
export async function main(argv, io = { log: console.log, error: console.error }, deps = realDeps()) {
  try {
    if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") { io.log(USAGE); return 0; }
    const { command, flags } = parseArgs(argv);
    const envPath = resolve(flags.env ?? join(deps.root, ".env"));
    switch (command) {
      case "check": return await check(deps, io, envPath);
      case "start": return await startCommand(deps, io, envPath, flags);
      case "db": return await dbCommand(deps, io, envPath);
      case "admin": return await adminCommand(deps, io, envPath, flags);
      case "api": return await apiCommand(deps, io, envPath);
      case "web": return await webCommand(deps, io);
      default: throw new UsageError(`Unknown command: ${command}`);
    }
  } catch (e) {
    if (e instanceof UsageError) { io.error(`${e.message}\n\n${USAGE}`); return 2; }
    io.error(`Failed: ${e?.message ?? e}`);
    return 1;
  }
}

/** True when this file is the one being run (not imported). Resolves links first, as Node does for the module's own address. */
function isMain() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
}
if (isMain()) {
  process.exitCode = await main(process.argv.slice(2));
}
