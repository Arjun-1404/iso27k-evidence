import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

/**
 * `npm run verify` is what a person runs before trusting a copy of the project, and what the CI workflow runs on every
 * change. What matters: it lists and runs the right checks, a failure is shown with its output and the run goes on,
 * "no internet" is not reported as a vulnerable library (nor a real finding hidden as "no internet"), and the exit code
 * is non-zero exactly when something failed.
 */

const SCRIPT = resolve(__dirname, "../scripts/verify.mjs");
type Step = { title: string; cwd: string; cmd: string; needs?: string; audit?: boolean };
type Result = { title: string; status: "ok" | "failed" | "skipped"; note?: string };
type Mod = {
  parseArgs(argv: string[]): { mutation: boolean; audit: boolean; list: boolean; help: boolean };
  buildSteps(opts?: { mutation?: boolean; audit?: boolean }): Step[];
  runSteps(steps: Step[], io: { run(cmd: string, cwd: string): Promise<{ code: number; output: string }>; log(t: string): void; installed(f: string): boolean; now(): number }): Promise<{ results: Result[]; failed: Result[] }>;
  main(argv: string[], io?: Record<string, unknown>): Promise<number>;
};
const load = async () => (await import(pathToFileURL(SCRIPT).href)) as Mod;

function fakeIo(responses: Record<string, { code: number; output?: string }> = {}, installed = (_f: string) => true) {
  const log: string[] = []; const ran: { cmd: string; cwd: string }[] = [];
  let t = 0;
  return {
    log, ran,
    io: {
      log: (x: string) => { log.push(x); },
      now: () => (t += 2000),
      installed,
      run: async (cmd: string, cwd: string) => { ran.push({ cmd, cwd }); const r = responses[cmd] ?? { code: 0 }; return { code: r.code, output: r.output ?? "" }; },
    },
  };
}

describe("the steps", () => {
  it("cover types, tests, lint, the production build and the library audit, for the server and the web app", async () => {
    const { buildSteps } = await load();
    const steps = buildSteps();
    expect(steps.map((s) => s.title)).toEqual([
      "Server: type check", "Server: automated tests",
      "Web app: type check", "Web app: code checks", "Web app: automated tests", "Web app: production build", "Web app: live demo build",
      "Server: known security problems in libraries", "Web app: known security problems in libraries",
    ]);
    expect(steps.map((s) => [s.cmd, s.cwd])).toEqual([
      ["npx tsc --noEmit", "."], ["npx vitest run", "."],
      ["npx tsc -b", "frontend"], ["npm run lint", "frontend"], ["npx vitest run", "frontend"], ["npm run build", "frontend"],
      ["npm run build:demo && node ../scripts/check-demo-build.mjs", "frontend"],
      ["npm audit --omit=dev --audit-level=high", "."], ["npm audit --omit=dev --audit-level=high", "frontend"],
    ]);
  });

  it("only audit the libraries that ship (not the test tools), and only for high-severity problems and worse", async () => {
    const { buildSteps } = await load();
    for (const s of buildSteps().filter((x) => x.audit)) {
      expect(s.cmd).toContain("--omit=dev");
      expect(s.cmd).toContain("--audit-level=high");
    }
  });

  it("leave out the audit on request, and add the deliberate-breakage checks only on request", async () => {
    const { buildSteps } = await load();
    expect(buildSteps({ audit: false }).some((s) => s.audit)).toBe(false);
    expect(buildSteps({ audit: false })).toHaveLength(7);
    expect(buildSteps().some((s) => s.cmd.includes("mutation-check"))).toBe(false);
    const withMutation = buildSteps({ mutation: true });
    expect(withMutation.map((s) => s.cmd).filter((c) => c.includes("mutation-check"))).toEqual([
      "python3 scripts/mutation-check.py", "python3 scripts/frontend-mutation-check.py",
    ]);
  });
});

describe("options", () => {
  it("are read as given", async () => {
    const { parseArgs } = await load();
    expect(parseArgs([])).toEqual({ mutation: false, audit: true, list: false, help: false });
    expect(parseArgs(["--mutation", "--skip-audit"])).toEqual({ mutation: true, audit: false, list: false, help: false });
    expect(parseArgs(["--list"]).list).toBe(true);
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("refuse an option that isn't known, instead of silently ignoring a typo", async () => {
    const { parseArgs } = await load();
    expect(() => parseArgs(["--mutations"])).toThrow(/Unknown option "--mutations"/);
  });
});

describe("running the steps", () => {
  it("reports each step as ok and exits 0 when everything passes", async () => {
    const { main } = await load();
    const f = fakeIo();
    expect(await main([], f.io)).toBe(0);
    expect(f.log.filter((l) => l.includes("… ok"))).toHaveLength(9);
    expect(f.log.join("\n")).toMatch(/All 9 checks passed\./);
    expect(f.log.join("\n")).toContain("[1/9] Server: type check … ok (2s)");
    expect(f.ran.map((r) => r.cmd)).toEqual(["npx tsc --noEmit", "npx vitest run", "npx tsc -b", "npm run lint", "npx vitest run", "npm run build", "npm run build:demo && node ../scripts/check-demo-build.mjs", "npm audit --omit=dev --audit-level=high", "npm audit --omit=dev --audit-level=high"]);
  });

  it("shows the end of a failing step's output, carries on with the others, and exits 1", async () => {
    const { main } = await load();
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
    const f = fakeIo({ "npm run lint": { code: 1, output: `${lines}\nthe real problem is here` } });
    expect(await main([], f.io)).toBe(1);
    const out = f.log.join("\n");
    expect(out).toContain("[4/9] Web app: code checks … FAILED");
    expect(out).toContain("the real problem is here");
    expect(out).toContain("line 60");
    expect(out).not.toContain("line 10\n"); // only the end is shown, not 60 lines
    expect(out).toMatch(/1 of 9 checks FAILED:\n  - Web app: code checks/);
    expect(f.ran).toHaveLength(9); // later steps still ran
  });

  it("lists every failure at the end", async () => {
    const { main } = await load();
    const f = fakeIo({ "npx tsc --noEmit": { code: 2, output: "type error" }, "npm run build": { code: 1, output: "build error" } });
    expect(await main([], f.io)).toBe(1);
    expect(f.log.join("\n")).toMatch(/2 of 9 checks FAILED:\n  - Server: type check\n  - Web app: production build/);
  });

  it("treats a library audit that can't reach the registry as skipped, not failed, and says so", async () => {
    const { main } = await load();
    const f = fakeIo({ "npm audit --omit=dev --audit-level=high": { code: 1, output: "npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org/-/npm/v1/security/audits/quick failed" } });
    expect(await main([], f.io)).toBe(0);
    const out = f.log.join("\n");
    expect(out).toContain("skipped: couldn't reach the npm registry");
    expect(out).toMatch(/All 7 checks passed; 2 skipped/);
  });

  it("does NOT treat a real vulnerability finding as 'no internet'", async () => {
    const { main } = await load();
    const f = fakeIo({ "npm audit --omit=dev --audit-level=high": { code: 1, output: "express  <4.0.0\nSeverity: high\n1 high severity vulnerability\nTo address all issues, run: npm audit fix" } });
    expect(await main([], f.io)).toBe(1);
    expect(f.log.join("\n")).toContain("known security problems in libraries … FAILED");
  });

  it("does not hide an ordinary failure just because the output mentions a network word", async () => {
    const { main } = await load();
    const f = fakeIo({ "npx vitest run": { code: 1, output: "Error: connect ECONNREFUSED 127.0.0.1:5432" } });
    expect(await main([], f.io)).toBe(1); // only the audit steps may be skipped for being offline
    expect(f.log.join("\n")).toContain("Server: automated tests … FAILED");
  });

  it("leaves the audit out entirely with --skip-audit", async () => {
    const { main } = await load();
    const f = fakeIo();
    expect(await main(["--skip-audit"], f.io)).toBe(0);
    expect(f.ran.some((r) => r.cmd.includes("audit"))).toBe(false);
    expect(f.log.join("\n")).toMatch(/All 7 checks passed\./);
  });

  it("installs missing libraries once per folder before the steps that need them, and not when they are there", async () => {
    const { main } = await load();
    const f = fakeIo({}, (folder) => folder === ".");
    expect(await main(["--skip-audit"], f.io)).toBe(0);
    const installs = f.ran.filter((r) => r.cmd.startsWith("npm ci"));
    expect(installs).toEqual([{ cmd: "npm ci --no-audit --no-fund", cwd: "frontend" }]);
    expect(f.ran.indexOf(installs[0])).toBeLessThan(f.ran.findIndex((r) => r.cmd === "npx tsc -b"));

    const g = fakeIo();
    await main(["--skip-audit"], g.io);
    expect(g.ran.some((r) => r.cmd.startsWith("npm ci"))).toBe(false);
  });

  it("reports a step as failed when its libraries can't be installed, without running it", async () => {
    const { main } = await load();
    const f = fakeIo({ "npm ci --no-audit --no-fund": { code: 1, output: "npm error network down" } }, () => false);
    expect(await main(["--skip-audit"], f.io)).toBe(1);
    expect(f.log.join("\n")).toContain("FAILED (could not install the libraries)");
    expect(f.ran.some((r) => r.cmd === "npx vitest run")).toBe(false);
  });

  it("--list shows the steps and runs nothing; --help shows the usage", async () => {
    const { main } = await load();
    const f = fakeIo();
    expect(await main(["--list"], f.io)).toBe(0);
    expect(f.log[0]).toBe("1. Server: type check   (npx tsc --noEmit)");
    expect(f.ran).toEqual([]);
    const h = fakeIo();
    expect(await main(["--help"], h.io)).toBe(0);
    expect(h.log.join("\n")).toMatch(/Usage: npm run verify/);
  });

  it("exits 2 with the usage for an unknown option, running nothing", async () => {
    const { main } = await load();
    const errors: string[] = []; const f = fakeIo();
    expect(await main(["--nope"], { ...f.io, error: (t: string) => errors.push(t) })).toBe(2);
    expect(errors.join("\n")).toMatch(/Unknown option "--nope"/);
    expect(f.ran).toEqual([]);
  });
});

describe("as a command", () => {
  it("`node scripts/verify.mjs --list` prints the steps; an unknown option exits 2", () => {
    const ok = spawnSync("node", [SCRIPT, "--list"], { encoding: "utf8" });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("Server: automated tests");
    const bad = spawnSync("node", [SCRIPT, "--bogus"], { encoding: "utf8" });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/Unknown option/);
  });

  it("is reachable as `npm run verify`", () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8"));
    expect(pkg.scripts.verify).toBe("node scripts/verify.mjs");
  });
});

describe("the CI workflow and dependency updates", () => {
  const yaml = (f: string) => parseYaml(readFileSync(resolve(__dirname, "..", f), "utf8")) as Record<string, any>;

  it("run the verify command on every pull request and on pushes to main, with read-only access", () => {
    const ci = yaml(".github/workflows/ci.yml");
    expect(Object.keys(ci.on).sort()).toEqual(["pull_request", "push"]);
    expect(ci.on.push.branches).toEqual(["main"]);
    expect(ci.permissions).toEqual({ contents: "read" });
    const steps = ci.jobs.verify.steps as { run?: string; uses?: string; with?: Record<string, unknown> }[];
    expect(steps.some((s) => s.run === "npm run verify")).toBe(true);
    const install = steps.find((s) => s.run?.includes("npm ci"))!;
    expect(install.run).toContain("--prefix frontend");
    const node = steps.find((s) => s.uses?.startsWith("actions/setup-node"))!;
    expect(node.with?.["node-version"]).toBe(22);
  });

  it("uses the same Node version as the Docker image", () => {
    const dockerfile = readFileSync(resolve(__dirname, "../Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/FROM node:22-/);
  });

  it("run the slow deliberate-breakage checks weekly and on request, for both the server and the web app", () => {
    const m = yaml(".github/workflows/mutation.yml");
    expect(Object.keys(m.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    const runs = (m.jobs.mutation.steps as { run?: string }[]).map((s) => s.run ?? "");
    expect(runs.some((r) => r.includes("scripts/mutation-check.py"))).toBe(true);
    expect(runs.some((r) => r.includes("scripts/frontend-mutation-check.py"))).toBe(true);
  });

  it("the live-demo workflow tests, builds and checks the demo, then publishes only the demo's own build folder", () => {
    const w = yaml(".github/workflows/pages.yml");
    expect(w.on.push.branches).toEqual(["main"]);
    expect(Object.keys(w.on).sort()).toEqual(["push", "workflow_dispatch"]);
    // The least GitHub Pages needs: read the code, write the Pages site, and the identity token the deploy step presents.
    expect(w.permissions).toEqual({ contents: "read", pages: "write", "id-token": "write" });
    const build = w.jobs.build.steps as { run?: string; uses?: string; with?: Record<string, unknown> }[];
    const runs = build.map((s) => s.run ?? "").join("\n");
    expect(runs).toContain("npm test --prefix frontend -- src/demo");
    expect(runs).toContain("npm run build:demo --prefix frontend");
    expect(runs).toContain("node scripts/check-demo-build.mjs");
    expect(build.find((s) => s.uses?.startsWith("actions/setup-node"))!.with?.["node-version"]).toBe(22);
    // What goes live is the demo build, never the real app's dist/.
    const upload = build.find((s) => s.uses?.startsWith("actions/upload-pages-artifact"))!;
    expect(upload.with?.path).toBe("frontend/dist-demo");
    // The demo's folder is where the build writes it, and it never gets committed.
    expect(readFileSync(resolve(__dirname, "../frontend/vite.config.ts"), "utf8")).toContain("dist-demo");
    expect(readFileSync(resolve(__dirname, "../.gitignore"), "utf8")).toMatch(/^dist-demo\/$/m);
    // Publishing waits for the build, and only one publish runs at a time.
    expect(w.jobs.deploy.needs).toBe("build");
    expect(w.jobs.deploy.steps.some((x: { uses?: string }) => x.uses?.startsWith("actions/deploy-pages"))).toBe(true);
    expect(w.concurrency["cancel-in-progress"]).toBe(false);
  });

  it("dependabot watches both sets of libraries, the Actions and both Docker images", () => {
    const d = yaml(".github/dependabot.yml");
    const watched = (d.updates as { "package-ecosystem": string; directory: string }[]).map((u) => `${u["package-ecosystem"]} ${u.directory}`).sort();
    expect(watched).toEqual(["docker /", "docker /frontend", "github-actions /", "npm /", "npm /frontend"]);
  });
});
