import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * README.html is the README made readable on a person's own computer (Notepad and code editors show README.md as raw
 * text). It is built from README.md by `npm run docs` and committed, so these checks keep the two from drifting apart and
 * keep the page working with no internet: every link inside it must lead somewhere, and nothing may be fetched.
 */

type Mod = {
  build(readme: string): string;
  sha256(text: string): string;
  mermaidSource(readme: string): string | null;
  slugger(): (text: string) => string;
};
const ROOT = resolve(__dirname, "..");
const load = async () => (await import(pathToFileURL(resolve(ROOT, "scripts/build-readme-html.mjs")).href)) as Mod;
const readme = readFileSync(resolve(ROOT, "README.md"), "utf8");
const html = readFileSync(resolve(ROOT, "README.html"), "utf8");

describe("README.html", () => {
  it("is up to date with README.md (if this fails, run: npm run docs)", async () => {
    const m = await load();
    expect(/<!-- readme-sha256: ([0-9a-f]{64}) -->/.exec(html)?.[1]).toBe(m.sha256(readme));
    expect(html).toBe(m.build(readme)); // and is exactly what the build makes, not a hand-edited copy
  });

  it("has an address for every in-page link written in README.md, and no dead links of its own", async () => {
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const wanted = [...readme.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
    expect(wanted.length).toBeGreaterThan(5);
    for (const w of wanted) expect(ids.has(w), `README.md links to #${w}`).toBe(true);
    for (const m of html.matchAll(/href="#([^"]+)"/g)) expect(ids.has(m[1]), `README.html links to #${m[1]}`).toBe(true);
  });

  it("turns headings into the same addresses GitHub does (so a link copied from GitHub works)", async () => {
    const { slugger } = await load();
    const slug = slugger();
    expect(slug("Windows (no Docker)")).toBe("windows-no-docker");
    expect(slug("Where evidence is kept: Google Drive, this server's disk, or S3")).toBe("where-evidence-is-kept-google-drive-this-servers-disk-or-s3");
    expect(slug("Windows (no Docker)")).toBe("windows-no-docker-1"); // a repeated heading gets -1, as on GitHub
  });

  it("needs no internet: no scripts, styles, fonts or pictures are fetched", () => {
    expect(html).not.toMatch(/<script[^>]*\ssrc=/i);
    expect(html).not.toMatch(/<link[^>]*rel=["']?stylesheet/i);
    expect(html).not.toMatch(/@import|url\(\s*["']?https?:/i);
    expect(html).not.toMatch(/<img[^>]*\ssrc=["']https?:/i);
    expect(html).not.toMatch(/<iframe|<object|<embed/i);
  });

  it("shows the pictures the README uses, from files that exist, and draws the diagram instead of its source", () => {
    const srcs = [...html.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
    expect(srcs.length).toBeGreaterThan(0);
    for (const s of srcs) expect(existsSync(resolve(ROOT, s)), s).toBe(true);
    expect(html).toContain('<figure class="diagram"');
    expect(html).not.toMatch(/flowchart LR/); // the Mermaid text itself must not appear
  });

  it("keeps the diagram picture in step with the diagram in README.md (if this fails, run: npm run docs -- --render-diagram)", async () => {
    const m = await load();
    const svg = readFileSync(resolve(ROOT, "docs/architecture.svg"), "utf8");
    expect(/^<!-- mermaid-source-sha256: ([0-9a-f]{64}) -->/.exec(svg)?.[1]).toBe(m.sha256(m.mermaidSource(readme)!));
  });

  it("leaves out the note that README.md carries about README.html, and keeps everything else", () => {
    expect(readme).toContain("readme-html:skip-start");
    expect(html).not.toContain("Reading this on your own computer");
    expect(html).toContain("Before you start: what to install");
    for (const h of ["1. Quick installation", "2. Windows (with Docker)", "3. Windows (without Docker)", "4. Linux (with Docker)", "5. Linux (without Docker)"]) expect(html, h).toContain(h);
    expect(html.match(/class="copy"/g)!.length).toBeGreaterThan(20); // every command has a Copy button
  });

  it("groups every way of installing under one Installation heading, in a fixed order, after what to install first (and the contents list shows them)", () => {
    const heads = [...readme.matchAll(/^(#{2,3}) (.+)$/gm)].map((m) => [m[1].length, m[2]] as const);
    const at = heads.findIndex(([, t]) => t === "Installation");
    expect(at, "an '## Installation' heading").toBeGreaterThan(-1);
    expect(heads.slice(at, at + 7)).toEqual([
      [2, "Installation"],
      [3, "Before you start: what to install"],
      [3, "1. Quick installation (Windows or Linux, no Docker)"],
      [3, "2. Windows (with Docker)"],
      [3, "3. Windows (without Docker)"],
      [3, "4. Linux (with Docker)"],
      [3, "5. Linux (without Docker)"],
    ]);
    expect(heads[at + 7]).toEqual([2, "Your first client, end to end"]); // the installation block holds nothing but installation
    // the contents list on the left of README.html shows each of them
    const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const [, t] of heads.slice(at, at + 7)) expect(html, t).toMatch(new RegExp(`<li class="d[23]"><a href="#[^"]+">${esc(t)}</a></li>`));
  });

  it("says what to install before any route, for each program a route needs, with a way to check it", () => {
    const start = readme.indexOf("### Before you start: what to install");
    const section = readme.slice(start, readme.indexOf("### 1. Quick installation"));
    for (const word of ["Node.js 22 or newer", "npm", "PostgreSQL 16", "Docker", "Compose v2", "git", "unzip"]) expect(section, word).toContain(word);
    for (const check of ["node -v", "npm -v", "psql --version", "docker --version", "docker compose version"]) expect(section, check).toContain(check);
    expect(section).toMatch(/\*Windows:\*/); expect(section).toMatch(/\*Linux:\*/);
  });

  it("keeps characters that look like replacement patterns exactly as written", () => {
    // The README has "$(...)" and "$API" in commands; a string replace would have eaten or doubled them.
    expect(html).toContain("$(grep");
    expect(html).not.toContain("{{BODY}}");
  });
});
