#!/usr/bin/env node
/**
 * Serves the built web app (frontend/dist) on your own machine — the no-Docker counterpart of the nginx container.
 *
 *   node scripts/serve-web.mjs
 *
 * Why it exists: running the web app in development mode (`cd frontend && npm run dev`) needs about 240 packages
 * (400 MB, mostly testing and build tools). This only needs Node itself, so a machine that cannot download that much
 * can still run the portal. It is a plain static file server with the one trick a single-page app needs: a path that is
 * not a file (for example the invitation link, /accept-invite) is answered with index.html, so the app's own router
 * can handle it, including after a browser refresh.
 *
 * The built app talks to the API at http://localhost:3000 (the address it was built with). To use another address,
 * rebuild it:  cd frontend && npm ci && VITE_API_BASE_URL=<address> npm run build
 *
 * Settings (environment variables): WEB_PORT (default 5173), WEB_HOST (default 127.0.0.1 — this machine only;
 * use 0.0.0.0 to let other computers connect).
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { resolve, join, extname, dirname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".map": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json",
};

/**
 * Paths that mean something special to Windows rather than naming a file: a colon (a drive, `file.txt:stream`), or a
 * device name such as con, nul, aux, prn, com1, lpt1 — with or without an extension. The web app has no such files, so
 * these are always "not found"; refusing them here keeps the file system from being asked at all.
 */
export function isWindowsSpecialPath(path) {
  return path.split(/[\\/]/).some((part) => part.includes(":") || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(part) || /[. ]$/.test(part) && part !== "." && part !== "..");
}

/** An http.Server that serves the folder `root`. Nothing outside that folder can ever be read. */
export function createWebServer(root) {
  const base = resolve(root);
  const reply = (res, status, headers = {}, body) => {
    res.writeHead(status, { "X-Content-Type-Options": "nosniff", ...headers });
    res.end(body);
  };
  return createServer(async (req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") return reply(res, 405, { Allow: "GET, HEAD" });
      let path;
      try { path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname); }
      catch { return reply(res, 400); }
      if (path.includes("\0")) return reply(res, 400);
      if (isWindowsSpecialPath(path)) return reply(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found");

      let file = resolve(join(base, path));
      if (file !== base && !file.startsWith(base + sep)) return reply(res, 403);

      let info = await stat(file).catch(() => null);
      if (info?.isDirectory()) { file = join(file, "index.html"); info = await stat(file).catch(() => null); }
      if (!info) {
        // A path with a file extension that does not exist is a missing file. Anything else is a page of the app.
        if (extname(path)) return reply(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found");
        file = join(base, "index.html");
        info = await stat(file).catch(() => null);
        if (!info) return reply(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found");
      }
      const body = await readFile(file);
      const hashed = file.startsWith(join(base, "assets") + sep); // the build gives these files content-based names
      reply(res, 200, {
        "Content-Type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
        "Content-Length": String(body.length),
        "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
      }, req.method === "HEAD" ? undefined : body);
    } catch {
      reply(res, 500, { "Content-Type": "text/plain; charset=utf-8" }, "Server error");
    }
  });
}

/** True when this file is the one being run (not imported). Resolves links first, as Node does for the module's own address. */
function isMain() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
}
if (isMain()) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../frontend/dist");
  if (!existsSync(join(root, "index.html"))) {
    console.error("The built web app is missing (frontend/dist/index.html).\nBuild it once with:  cd frontend && npm ci && npm run build");
    process.exit(1);
  }
  const port = Number(process.env.WEB_PORT ?? 5173);
  const host = process.env.WEB_HOST ?? "127.0.0.1";
  const server = createWebServer(root);
  server.on("error", (e) => {
    console.error(e.code === "EADDRINUSE"
      ? `Port ${port} is already in use — stop whatever is using it (another copy of the web app, or Docker's frontend), or set WEB_PORT.`
      : `Could not start: ${e.message}`);
    process.exit(1);
  });
  server.listen(port, host, () => {
    console.log(`Web app: http://localhost:${port}  (serving frontend/dist; it talks to the API at the address it was built with, http://localhost:3000 by default)`);
  });
}
