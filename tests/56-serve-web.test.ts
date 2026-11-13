import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { request, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, copyFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";

/**
 * `node scripts/serve-web.mjs` is how the built web app is served without Docker or the 400 MB development install.
 * What matters: the app's own pages (like the invitation link) load, files are served with the right type, a missing
 * file is a clear 404 rather than a blank page, and nothing outside the web app's folder can be read.
 */

const SCRIPT = resolve(__dirname, "../scripts/serve-web.mjs");
type Mod = { createWebServer(root: string): Server; isWindowsSpecialPath(path: string): boolean };

let dir: string, secretDir: string, server: Server, port: number;

/** Raw request — fetch() would tidy up `..` in the path before sending, which is exactly what must be tested. */
const get = (path: string, method = "GET") => new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((ok, fail) => {
  const r = request({ host: "127.0.0.1", port, path, method }, (res) => {
    let body = ""; res.on("data", (c) => (body += c)); res.on("end", () => ok({ status: res.statusCode ?? 0, headers: res.headers, body }));
  });
  r.on("error", fail); r.end();
});

beforeAll(async () => {
  const outer = mkdtempSync(join(tmpdir(), "serve-web-"));
  dir = join(outer, "dist"); secretDir = outer;
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<html><body>the app</body></html>");
  writeFileSync(join(dir, "assets", "index-abc123.js"), "console.log('hi')");
  writeFileSync(join(dir, "assets", "index-abc123.css"), "body{}");
  writeFileSync(join(dir, "favicon.svg"), "<svg/>");
  writeFileSync(join(outer, "secret.txt"), "TOP SECRET");   // next to dist, not inside it
  const { createWebServer } = (await import(pathToFileURL(SCRIPT).href)) as Mod;
  server = createWebServer(dir);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => { server.close(); rmSync(secretDir, { recursive: true, force: true }); });

describe("serve-web", () => {
  it("serves the app at / and gives each file its right type", async () => {
    const home = await get("/");
    expect(home.status).toBe(200); expect(home.body).toContain("the app");
    expect(home.headers["content-type"]).toMatch(/text\/html/);
    expect((await get("/assets/index-abc123.js")).headers["content-type"]).toMatch(/javascript/);
    expect((await get("/assets/index-abc123.css")).headers["content-type"]).toMatch(/text\/css/);
    expect((await get("/favicon.svg")).headers["content-type"]).toBe("image/svg+xml");
  });

  it("answers the app's own routes with index.html, so the invitation link and a browser refresh work", async () => {
    for (const p of ["/accept-invite?token=abc", "/controls", "/settings/server", "/login?accepted=1"]) {
      const r = await get(p);
      expect(r.status, p).toBe(200); expect(r.body, p).toContain("the app");
    }
  });

  it("a missing file is a plain 404, not a blank page that looks like the app", async () => {
    const r = await get("/assets/does-not-exist.js");
    expect(r.status).toBe(404); expect(r.body).not.toContain("the app");
  });

  it("caches the content-named build files for a year, and everything else not at all", async () => {
    expect((await get("/assets/index-abc123.js")).headers["cache-control"]).toMatch(/immutable/);
    expect((await get("/")).headers["cache-control"]).toBe("no-cache");
  });

  it("cannot be used to read files outside the web app's folder", async () => {
    for (const p of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/../../secret.txt", "/..%2fsecret.txt", "/%2e%2e%2fsecret.txt", "/assets/%2e%2e/%2e%2e/secret.txt"]) {
      const r = await get(p);
      expect(r.body, p).not.toContain("TOP SECRET");
    }
    expect((await get("/bad%00name")).status).toBe(400);
    expect((await get("/%E0%A4%A")).status).toBe(400);   // malformed percent-encoding
  });

  it("only reads: other methods are refused, HEAD returns headers without a body", async () => {
    expect((await get("/", "POST")).status).toBe(405);
    expect((await get("/", "DELETE")).status).toBe(405);
    const h = await get("/", "HEAD");
    expect(h.status).toBe(200); expect(h.body).toBe(""); expect(Number(h.headers["content-length"])).toBeGreaterThan(0);
  });

  it("says nosniff on every answer", async () => {
    for (const p of ["/", "/assets/index-abc123.js", "/nope.js", "/controls"]) expect((await get(p)).headers["x-content-type-options"], p).toBe("nosniff");
  });

  it("answers Windows-special paths (drive letters, streams, device names like con and nul) with a plain 404, never the app", async () => {
    // On Windows these would be handed to the file system as devices or alternate streams. The web app has no such files.
    for (const p of ["/con", "/CON.txt", "/assets/nul", "/x:y", "/C:/Windows/win.ini", "/index.html::$DATA", "/index.html:stream", "/lpt1", "/com1.js", "/aux", "/prn.css", "/trailing.", "/trailing%20"]) {
      const r = await get(p);
      expect(r.status, p).toBe(404); expect(r.body, p).not.toContain("the app");
    }
    // names that merely look similar are ordinary pages of the app
    for (const p of ["/console", "/auxiliary", "/comet", "/null-result", "/com10"]) expect((await get(p)).status, p).toBe(200);
  });

  it("isWindowsSpecialPath is exact about what it refuses", async () => {
    const { isWindowsSpecialPath } = (await import(pathToFileURL(SCRIPT).href)) as Mod;
    for (const p of ["/", "/assets/index-abc123.js", "/accept-invite", "/settings/server", "/a/./b", "/console", "/com10"]) expect(isWindowsSpecialPath(p), p).toBe(false);
    for (const p of ["/con", "/NUL", "/a/Aux.html", "/COM1", "/lpt9.txt", "/C:", "/a:b", "/dot.", "/space "]) expect(isWindowsSpecialPath(p), p).toBe(true);
  });
});

describe("serve-web as a command", () => {
  it("starts (and prints its address) even when run through a link to the folder — Windows junctions and drive mappings act like this", async () => {
    // Node gives a module its real path but process.argv[1] the path as typed. If the script compares them naively it
    // silently does nothing, which is exactly what a person at a Windows prompt would see: no output, no web app.
    const outer = mkdtempSync(join(tmpdir(), "serve-web-link-"));
    try {
      const real = join(outer, "real"); mkdirSync(join(real, "scripts"), { recursive: true }); mkdirSync(join(real, "frontend", "dist"), { recursive: true });
      writeFileSync(join(real, "frontend", "dist", "index.html"), "<html>linked</html>");
      copyFileSync(SCRIPT, join(real, "scripts", "serve-web.mjs"));
      const link = join(outer, "link"); symlinkSync(real, link, "dir");
      const child = spawn(process.execPath, [join(link, "scripts", "serve-web.mjs")], { env: { ...process.env, WEB_PORT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
      const out = await new Promise<string>((ok) => {
        let text = ""; const timer = setTimeout(() => ok(text), 8000);
        child.stdout.on("data", (c) => { text += c; if (/Web app:/.test(text)) { clearTimeout(timer); ok(text); } });
        child.on("exit", () => { clearTimeout(timer); ok(text); });
      });
      child.kill();
      expect(out).toContain("Web app: http://localhost:");
    } finally { rmSync(outer, { recursive: true, force: true }); }
  });

  it("says plainly when the built web app is missing", () => {
    const outer = mkdtempSync(join(tmpdir(), "serve-web-missing-"));
    try {
      mkdirSync(join(outer, "scripts"), { recursive: true });
      copyFileSync(SCRIPT, join(outer, "scripts", "serve-web.mjs"));
      const r = spawnSync(process.execPath, [join(outer, "scripts", "serve-web.mjs")], { encoding: "utf8", timeout: 8000 });
      expect(r.status).toBe(1); expect(r.stderr).toContain("The built web app is missing");
    } finally { rmSync(outer, { recursive: true, force: true }); }
  });
});
