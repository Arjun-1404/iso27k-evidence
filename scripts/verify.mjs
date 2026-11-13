#!/usr/bin/env node
/**
 * One command that checks the whole project: types, every automated test, the web app builds, and known security
 * problems in the libraries it uses.
 *
 *   npm run verify                  # everything below, about 5-6 minutes
 *   npm run verify -- --mutation    # also the "deliberate breakage" checks (about an hour)
 *   npm run verify -- --skip-audit  # leave out the library security check (e.g. when you're offline)
 *   npm run verify -- --list        # just show the steps
 *
 * Each step prints one line: ok, FAILED (with the end of its output) or skipped (with why). A failing step doesn't stop
 * the rest, so one run shows everything that's wrong. The exit code is 0 only if nothing failed.
 */
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `Usage: npm run verify -- [--mutation] [--skip-audit] [--list] [--help]

  --mutation     also run the deliberate-breakage checks (slow: about an hour)
  --skip-audit   skip the library security check (it needs an internet connection)
  --list         show the steps without running them
  --help         show this text`;

/** What a failing library audit looks like when the cause is "no internet", not "a vulnerable library". */
const OFFLINE = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|audit endpoint returned an error|network request .* failed/i;

export class UsageError extends Error {}

export function parseArgs(argv) {
  const opts = { mutation: false, audit: true, list: false, help: false };
  for (const a of argv) {
    if (a === "--mutation") opts.mutation = true;
    else if (a === "--skip-audit") opts.audit = false;
    else if (a === "--list") opts.list = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new UsageError(`Unknown option "${a}".\n\n${USAGE}`);
  }
  return opts;
}

/**
 * The steps, in order. `needs` says which folder must have its libraries installed first; `audit` marks the steps
 * whose failure may just mean "no internet".
 */
export function buildSteps(opts = {}) {
  const front = (title, cmd, extra = {}) => ({ title: `Web app: ${title}`, cwd: "frontend", cmd, needs: "frontend", ...extra });
  const steps = [
    { title: "Server: type check", cwd: ".", cmd: "npx tsc --noEmit", needs: "." },
    { title: "Server: automated tests", cwd: ".", cmd: "npx vitest run", needs: "." },
    front("type check", "npx tsc -b"),
    front("code checks", "npm run lint"),
    front("automated tests", "npx vitest run"),
    front("production build", "npm run build"),
    front("live demo build", "npm run build:demo && node ../scripts/check-demo-build.mjs"),
  ];
  if (opts.audit !== false) {
    steps.push(
      { title: "Server: known security problems in libraries", cwd: ".", cmd: "npm audit --omit=dev --audit-level=high", needs: ".", audit: true },
      front("known security problems in libraries", "npm audit --omit=dev --audit-level=high", { audit: true }),
    );
  }
  if (opts.mutation) {
    steps.push(
      { title: "Server: deliberate-breakage checks", cwd: ".", cmd: "python3 scripts/mutation-check.py", needs: "." },
      { title: "Web app: deliberate-breakage checks", cwd: ".", cmd: "python3 scripts/frontend-mutation-check.py", needs: "frontend" },
    );
  }
  return steps;
}

/** Runs a shell command, collecting its output (stdout and stderr together, in order). */
export function runCommand(cmd, cwd) {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, { cwd, shell: true, env: { ...process.env, CI: "1", FORCE_COLOR: "0" } });
    let output = "";
    child.stdout.on("data", (d) => { output += d; });
    child.stderr.on("data", (d) => { output += d; });
    child.on("error", (e) => resolveRun({ code: 1, output: output + String(e) }));
    child.on("close", (code) => resolveRun({ code: code ?? 1, output }));
  });
}

const tail = (text, lines) => text.trimEnd().split(/\r?\n/).slice(-lines).map((l) => `      ${l}`).join("\n");
const seconds = (ms) => `${Math.max(0, Math.round(ms / 1000))}s`;

/**
 * Runs the steps and reports. `io` is injectable for tests: run(cmd, cwd), log(text), installed(folder), now().
 * Returns { results, failed } where each result is { title, status: "ok" | "failed" | "skipped", note? }.
 */
export async function runSteps(steps, io) {
  const results = [];
  const total = steps.length;
  const installs = new Map(); // folder -> null (fine) or the failed install

  // Libraries are installed once per folder, only when missing, and only if some step needs them. If that fails, every
  // step that needs that folder fails with it, rather than running against a half-installed folder.
  async function ensureInstalled(folder) {
    if (installs.has(folder)) return installs.get(folder);
    let failure = null;
    if (!io.installed(folder)) {
      io.log(`      Installing the libraries in ${folder === "." ? "the project folder" : folder} first (this is a one-off)…`);
      const r = await io.run("npm ci --no-audit --no-fund", folder);
      if (r.code !== 0) failure = r;
    }
    installs.set(folder, failure);
    return failure;
  }

  for (const [i, step] of steps.entries()) {
    const label = `[${i + 1}/${total}] ${step.title}`;
    const started = io.now();
    const missing = step.needs ? await ensureInstalled(step.needs) : null;
    if (missing) {
      io.log(`${label} … FAILED (could not install the libraries)\n${tail(missing.output, 25)}`);
      results.push({ title: step.title, status: "failed", note: "could not install the libraries" });
      continue;
    }
    const r = await io.run(step.cmd, step.cwd);
    const took = seconds(io.now() - started);
    if (r.code === 0) {
      io.log(`${label} … ok (${took})`);
      results.push({ title: step.title, status: "ok" });
    } else if (step.audit && OFFLINE.test(r.output)) {
      io.log(`${label} … skipped: couldn't reach the npm registry (no internet?). Run it again when you're online.`);
      results.push({ title: step.title, status: "skipped", note: "no internet connection to the npm registry" });
    } else {
      io.log(`${label} … FAILED (${took})\n${tail(r.output, 40)}`);
      results.push({ title: step.title, status: "failed" });
    }
  }
  const failed = results.filter((r) => r.status === "failed");
  const skipped = results.filter((r) => r.status === "skipped");
  io.log("");
  if (failed.length === 0) {
    io.log(`All ${results.length - skipped.length} checks passed${skipped.length ? `; ${skipped.length} skipped (see above)` : ""}.`);
  } else {
    io.log(`${failed.length} of ${results.length} checks FAILED:`);
    for (const f of failed) io.log(`  - ${f.title}${f.note ? ` (${f.note})` : ""}`);
  }
  return { results, failed };
}

export async function main(argv, ioOverride = {}) {
  const log = ioOverride.log ?? ((t) => console.log(t));
  let opts;
  try { opts = parseArgs(argv); } catch (e) {
    if (e instanceof UsageError) { (ioOverride.error ?? ((t) => console.error(t)))(e.message); return 2; }
    throw e;
  }
  if (opts.help) { log(USAGE); return 0; }
  const steps = buildSteps(opts);
  if (opts.list) {
    steps.forEach((s, i) => log(`${i + 1}. ${s.title}   (${s.cmd})`));
    return 0;
  }
  const root = ioOverride.root ?? ROOT;
  const io = {
    log,
    now: ioOverride.now ?? (() => Date.now()),
    installed: ioOverride.installed ?? ((folder) => existsSync(resolve(root, folder, "node_modules"))),
    run: ioOverride.run ?? ((cmd, cwd) => runCommand(cmd, resolve(root, cwd))),
  };
  const { failed } = await runSteps(steps, io);
  return failed.length === 0 ? 0 : 1;
}

/** True when this file is the one being run (not imported). Resolves links first, as Node does for the module's own address. */
function isMain() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
}
if (isMain()) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
