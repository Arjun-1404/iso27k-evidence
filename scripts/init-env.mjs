#!/usr/bin/env node
/**
 * Creates the .env file for a new installation, with its secrets already generated.
 *
 *   node scripts/init-env.mjs                       # writes .env next to package.json
 *   node scripts/init-env.mjs --app-url https://portal.yourfirm.example --api-url https://portal-api.yourfirm.example
 *
 * It starts from .env.example, so the explanations stay in the file, and fills in only what must be random: the two
 * database passwords, the session-signing secret and the key that encrypts secrets stored in the database. It never
 * overwrites an existing file (losing the encryption key by accident would make every stored secret unreadable), and
 * the new file is readable only by you.
 *
 * Mail, malware scanning and Google Drive are NOT asked for here: the first administrator enters them in the web app,
 * under Server settings, after signing in.
 *
 * No Node on this machine? Run it with Docker instead:
 *   docker run --rm -v "$PWD":/app -w /app node:22-slim node scripts/init-env.mjs
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `Usage: node scripts/init-env.mjs [--out <file>] [--app-url <address>] [--api-url <address>]

  --out <file>       where to write the settings (default: .env in the project folder)
  --app-url <url>    the address people open in a browser (default http://localhost:5173)
  --api-url <url>    the address the browser uses to reach the API (default http://localhost:3000)
  --help             show this text

Existing files are never overwritten.`;

class UsageError extends Error {}

const hex = (bytes) => randomBytes(bytes).toString("hex");

function cleanUrl(value, flag) {
  let url;
  try { url = new URL(value); } catch { throw new UsageError(`${flag} must be a full web address, like https://portal.yourfirm.example`); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UsageError(`${flag} must start with https:// (or http:// for a test on your own machine).`);
  if (url.username || url.password || url.search || url.hash) throw new UsageError(`${flag} can't contain a login, a ? query or a # fragment.`);
  return url.href.replace(/\/+$/, "");
}

/** Replaces exactly one line; fails loudly if .env.example changed shape, rather than quietly leaving a placeholder behind. */
function replaceLine(text, pattern, replacement, what) {
  const matches = text.match(new RegExp(pattern.source, pattern.flags.includes("m") ? pattern.flags : pattern.flags + "m"));
  if (!matches) throw new Error(`.env.example no longer has the line for ${what}; update scripts/init-env.mjs to match.`);
  return text.replace(pattern, replacement);
}

/**
 * The text of a new .env, made from the template. `random` is injectable so tests can see that distinct secrets are used.
 */
export function buildEnv(template, opts = {}) {
  const random = opts.random ?? hex;
  let out = template;
  out = replaceLine(out, /^POSTGRES_PASSWORD=.*$/m, `POSTGRES_PASSWORD=${random(24)}`, "POSTGRES_PASSWORD");
  out = replaceLine(out, /^APP_DB_PASSWORD=.*$/m, `APP_DB_PASSWORD=${random(24)}`, "APP_DB_PASSWORD");
  out = replaceLine(out, /^JWT_SECRET=.*$/m, `JWT_SECRET=${random(32)}`, "JWT_SECRET");
  out = replaceLine(out, /^# SECRET_ENCRYPTION_KEY=.*$/m, `SECRET_ENCRYPTION_KEY=${random(32)}`, "SECRET_ENCRYPTION_KEY");
  if (opts.appUrl !== undefined) out = replaceLine(out, /^APP_BASE_URL=.*$/m, `APP_BASE_URL=${cleanUrl(opts.appUrl, "--app-url")}`, "APP_BASE_URL");
  if (opts.apiUrl !== undefined) out = replaceLine(out, /^API_PUBLIC_URL=.*$/m, `API_PUBLIC_URL=${cleanUrl(opts.apiUrl, "--api-url")}`, "API_PUBLIC_URL");
  return out;
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") { opts.help = true; continue; }
    const name = { "--out": "out", "--app-url": "appUrl", "--api-url": "apiUrl" }[arg];
    if (!name) throw new UsageError(`Unknown option: ${arg}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${arg} needs a value.`);
    opts[name] = value;
  }
  return opts;
}

/** Runs the script. `io` is injectable for tests. Returns the exit code. */
export function main(argv, io = { log: console.log, error: console.error }) {
  try {
    const opts = parseArgs(argv);
    if (opts.help) { io.log(USAGE); return 0; }
    const target = resolve(opts.out ?? resolve(ROOT, ".env"));
    if (existsSync(target)) {
      io.error(`${target} already exists, so it was left alone. If you really want a new one, move or delete the old file first — but keep a copy: it holds the key that unlocks everything the portal has encrypted.`);
      return 1;
    }
    const template = readFileSync(resolve(ROOT, ".env.example"), "utf8");
    const text = buildEnv(template, opts);
    // "wx": create it, and fail rather than overwrite if something appeared in the meantime. 0600: only you can read it.
    writeFileSync(target, text, { flag: "wx", mode: 0o600 });
    io.log(`Created ${target}\n`);
    io.log("It holds freshly generated secrets — never share it or put it in a public repository, and keep a copy somewhere safe");
    io.log("(a password manager). Without SECRET_ENCRYPTION_KEY, everything the portal has encrypted becomes unreadable.\n");
    io.log("Next:");
    io.log("  1. Build and start, one command at a time:");
    io.log("       docker compose build api");
    io.log("       docker compose build frontend");
    io.log("       docker compose up -d");
    io.log("  2. Create the first administrator (they become the owner of this installation):");
    io.log("       docker compose run --rm -e ORG_NAME=\"Your Firm\" -e ORG_DOMAIN=yourfirm.example -e ADMIN_EMAIL=you@yourfirm.example migrate npm run db:bootstrap-admin");
    io.log("  3. Open the link it prints to choose a password, sign in, and open Server settings to set up email,");
    io.log("     malware scanning and Google Drive. No restart is needed after that.");
    io.log("\nNot using Docker? On Windows, follow \"Windows (no Docker)\" in README.md; on Linux, \"Manual setup (no Docker)\".");
    io.log("Either way, this command looks at the computer and says what is missing:  node scripts/local.mjs check");
    io.log("and once that is clean, one command starts everything:  node scripts/local.mjs start --org \"Your Firm\" --domain yourfirm.example --email you@yourfirm.example");
    return 0;
  } catch (e) {
    if (e instanceof UsageError) { io.error(`${e.message}\n\n${USAGE}`); return 2; }
    io.error(`Failed: ${e.message}`);
    return 1;
  }
}

/** True when this file is the one being run (not imported). Resolves links first, as Node does for the module's own address. */
function isMain() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
}
if (isMain()) {
  process.exitCode = main(process.argv.slice(2));
}
