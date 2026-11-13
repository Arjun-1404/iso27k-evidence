import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The check that keeps the live demo and the real web app apart. It must fail when the demo has leaked into the real
 * app, when the "demo" is really the ordinary app, and when the demo would show a blank page in a sub-folder.
 */

type Mod = { checkDemoBuild(d: { normalDir: string; demoDir: string }): string[]; DEMO_MARKERS: string[] };
const load = async () => (await import(pathToFileURL(resolve(__dirname, "../scripts/check-demo-build.mjs")).href)) as Mod;

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function build(opts: { normalJs?: string; demoJs?: string; demoHtml?: string; extraDemoFiles?: Record<string, string>; skipDemo?: boolean; skipNormal?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "demo-check-")); roots.push(root);
  const normalDir = join(root, "dist"); const demoDir = join(root, "dist-demo");
  if (!opts.skipNormal) {
    mkdirSync(join(normalDir, "assets"), { recursive: true });
    writeFileSync(join(normalDir, "index.html"), `<script src="/assets/a.js"></script>`);
    writeFileSync(join(normalDir, "assets", "a.js"), opts.normalJs ?? "console.log('the real app')");
  }
  if (!opts.skipDemo) {
    mkdirSync(join(demoDir, "assets"), { recursive: true });
    writeFileSync(join(demoDir, "index.html"), opts.demoHtml ?? `<link rel="icon" href="./favicon.svg"><script type="module" src="./assets/a.js"></script><a href="https://github.com/x/y">x</a>`);
    writeFileSync(join(demoDir, "favicon.svg"), "<svg/>");
    writeFileSync(join(demoDir, "assets", "a.js"), opts.demoJs ?? "const a='demo.invalid',b='Harbourview Assurance',c='demo-password-123',d='iso27k-demo-state'");
    for (const [name, text] of Object.entries(opts.extraDemoFiles ?? {})) writeFileSync(join(demoDir, name), text);
  }
  return { normalDir, demoDir };
}

describe("check-demo-build", () => {
  it("passes for a clean real app and a complete, relocatable demo", async () => {
    const { checkDemoBuild } = await load();
    expect(checkDemoBuild(build())).toEqual([]);
  });

  it("fails if any demo text is in the real app", async () => {
    const { checkDemoBuild, DEMO_MARKERS } = await load();
    for (const marker of DEMO_MARKERS) {
      const problems = checkDemoBuild(build({ normalJs: `x('${marker}')` }));
      expect(problems.join("\n")).toContain(`"${marker}"`);
    }
  });

  it("fails if the 'demo' lacks the demo (it is just the ordinary app)", async () => {
    const { checkDemoBuild } = await load();
    const problems = checkDemoBuild(build({ demoJs: "console.log('ordinary')" }));
    expect(problems.some((p) => p.includes("not the demo build"))).toBe(true);
  });

  it("fails if the demo's page loads files from the site's root, or refers to a file that is not there", async () => {
    const { checkDemoBuild } = await load();
    expect(checkDemoBuild(build({ demoHtml: `<script src="/assets/a.js"></script>` })).join("\n")).toContain("not relative");
    expect(checkDemoBuild(build({ demoHtml: `<script src="./assets/missing.js"></script>` })).join("\n")).toContain("missing");
  });

  it("says so when either build has not been made yet", async () => {
    const { checkDemoBuild } = await load();
    expect(checkDemoBuild(build({ skipDemo: true })).join("\n")).toContain("npm run build:demo");
    expect(checkDemoBuild(build({ skipNormal: true })).join("\n")).toContain("npm run build");
  });
});
