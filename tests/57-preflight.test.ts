import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * `bash scripts/preflight.sh` is what a new installer runs before anything else. It has to recognise the real-world
 * network problems that stopped the first Docker builds (npm's download server blocked, broken IPv6, only a mirror
 * reachable) and say the right thing for each. A pretend curl and docker stand in for the network, so this never
 * depends on the machine or network the tests run on.
 */

const SCRIPT = resolve(__dirname, "../scripts/preflight.sh");
const SSL = "curl: (35) TLS connect error: error:0A00010B:SSL routines::wrong version number";
let shim: string;

beforeAll(() => {
  shim = mkdtempSync(join(tmpdir(), "preflight-"));
  // Pretend curl. SCEN picks what each host answers; "-4" means IPv4 only.
  writeFileSync(join(shim, "curl"), `#!/usr/bin/env bash
host=""; v4=0
for a in "$@"; do case "$a" in -4) v4=1;; https://*) h=\${a#https://}; host=\${h%%/*};; esac; done
bad() { printf '%s000' "${SSL}"; }
case "$SCEN:$host:$v4" in
  ok:*) printf 200;;
  ipv6broken:registry.npmjs.org:0) bad;;
  ipv6broken:*) printf 200;;
  npmblocked:registry.npmjs.org:*) bad;;
  npmblocked:registry.yarnpkg.com:*) printf 200;;
  npmblocked:registry.npmmirror.com:*) printf 200;;
  npmblocked:*) printf 200;;
  onlynpmmirror:registry.npmmirror.com:*) printf 200;;
  onlynpmmirror:registry-1.docker.io:*) printf 200;;
  onlynpmmirror:*) bad;;
  allblocked:registry-1.docker.io:*) printf 200;;
  allblocked:*) bad;;
esac
`);
  // Pretend docker that is not usable, so the test never touches a real Docker.
  writeFileSync(join(shim, "docker"), `#!/usr/bin/env bash
echo "permission denied while trying to connect to the Docker daemon socket" >&2; exit 1
`);
  chmodSync(join(shim, "curl"), 0o755); chmodSync(join(shim, "docker"), 0o755);
});
afterAll(() => rmSync(shim, { recursive: true, force: true }));

const run = (scen: string) => {
  const r = spawnSync("bash", [SCRIPT], { encoding: "utf8", env: { ...process.env, SCEN: scen, PATH: `${shim}:${process.env.PATH}` } });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
};

describe("preflight.sh", () => {
  it("says everything is fine when npm's server is reachable", () => {
    const { out } = run("ok");
    expect(out).toContain("registry.npmjs.org is reachable");
    expect(out).not.toContain("[FAIL]");
  });

  it("recognises broken IPv6 (works only with -4) and gives the IPv4 fixes, without failing", () => {
    const { out } = run("ipv6broken");
    expect(out).toMatch(/works only over IPv4/);
    expect(out).toContain("NODE_OPTIONS=--dns-result-order=ipv4first");
    expect(out).toContain("net.ipv6.conf.all.disable_ipv6=1");
    expect(out).not.toContain("[FAIL]");
  });

  it("when npm's server is blocked but a mirror works, fails and gives the exact mirror setting for both routes", () => {
    const { code, out } = run("npmblocked");
    expect(code).toBe(1);
    expect(out).toMatch(/\[FAIL\] registry\.npmjs\.org cannot be reached: .*wrong version number/);
    expect(out).not.toMatch(/wrong version number 000|number000/);     // curl's own 000 is not shown to people
    expect(out).toContain("NPM_REGISTRY=https://registry.yarnpkg.com");
    expect(out).toContain("npm ci --omit=dev --registry=https://registry.yarnpkg.com");
  });

  it("falls back to the second mirror when only that one works", () => {
    const { code, out } = run("onlynpmmirror");
    expect(code).toBe(1);
    expect(out).toContain("NPM_REGISTRY=https://registry.npmmirror.com");
  });

  it("when nothing is reachable, says to change network instead of suggesting a mirror that cannot work", () => {
    const { code, out } = run("allblocked");
    expect(code).toBe(1);
    expect(out).toMatch(/No mirror works either/);
    expect(out).not.toContain("NPM_REGISTRY=");
  });

  it("explains a Docker permission problem in plain words", () => {
    const { out } = run("ok");
    // the pretend docker always answers "permission denied" — but only when a docker command exists on the PATH, which the shim guarantees
    expect(out).toMatch(/Docker is installed but you are not allowed to use it yet/);
    expect(out).toContain("sudo usermod -aG docker");
  });

  describe("in the offline download (libraries already included)", () => {
    /** A project folder as the offline download unpacks: runtime libraries and the built web app, no testing tools. */
    const project = (withTestTools: boolean) => {
      const dir = mkdtempSync(join(tmpdir(), "preflight-offline-"));
      mkdirSync(join(dir, "scripts"), { recursive: true });
      mkdirSync(join(dir, "node_modules", "tsx"), { recursive: true });
      if (withTestTools) mkdirSync(join(dir, "node_modules", "vitest"), { recursive: true });
      mkdirSync(join(dir, "frontend", "dist"), { recursive: true });
      writeFileSync(join(dir, "frontend", "dist", "index.html"), "<html></html>");
      writeFileSync(join(dir, "scripts", "preflight.sh"), readFileSync(SCRIPT, "utf8"));
      return dir;
    };
    const runIn = (dir: string, scen: string) => {
      const r = spawnSync("bash", [join(dir, "scripts", "preflight.sh")], { encoding: "utf8", env: { ...process.env, SCEN: scen, PATH: `${shim}:${process.env.PATH}` } });
      return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
    };

    it("a blocked npm server is only a warning, because nothing needs downloading — and says how to use the offline options", () => {
      const dir = project(false);
      try {
        const { code, out } = runIn(dir, "allblocked");
        expect(code).toBe(0);
        expect(out).not.toContain("[FAIL]");
        expect(out).toContain("already included in this download");
        expect(out).toMatch(/you do not need it: this download already contains the libraries/);
        expect(out).toContain("COMPOSE_FILE=docker-compose.yml:docker-compose.prebuilt-frontend.yml:docker-compose.offline.yml");
        expect(out).not.toMatch(/NPM_REGISTRY=|Try another network/);   // no mirror or hotspot advice for something not needed
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it("but a folder that has the testing tools (a development copy) is not the offline download: a blocked npm server still fails", () => {
      const dir = project(true);
      try {
        const { code, out } = runIn(dir, "allblocked");
        expect(code).toBe(1);
        expect(out).toContain("[FAIL] registry.npmjs.org cannot be reached");
        expect(out).not.toContain("already included in this download");
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  });

  it("only reads: it leaves the project folder exactly as it was", () => {
    const before = readFileSync(SCRIPT, "utf8");
    run("ok");
    expect(readFileSync(SCRIPT, "utf8")).toBe(before);
    expect(run("ok").out).not.toMatch(/Created|Wrote|Installing/);
  });
});
