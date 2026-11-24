#!/usr/bin/env node
/**
 * Checks the two builds of the web app that `npm run build` and `npm run build:demo` make:
 *
 *   - the REAL app (frontend/dist) contains nothing of the live demo: no pretend server, no sample people, no demo
 *     password. Someone who runs this project for real must never be carrying the demo along.
 *   - the DEMO (frontend/dist-demo) does contain the demo, and works when put in any folder of a website (every file it
 *     refers to is found relative to the page, as GitHub Pages needs for https://<user>.github.io/<repo>/).
 *   - the DEMO has a share picture (og:image) that really is in the build, for when its link is pasted into LinkedIn or
 *     a chat; the real app has none, since it is not a public page.
 *
 *   node scripts/check-demo-build.mjs
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Text that only the demo contains. If any of it is in the real app, the demo has leaked into it. */
export const DEMO_MARKERS = ["demo.invalid", "Harbourview Assurance", "demo-password-123", "iso27k-demo-state"];

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else yield p;
  }
}

const readText = (p) => readFileSync(p, "utf8");

/** Returns a list of problems (empty when both builds are as they should be). */
export function checkDemoBuild({ normalDir, demoDir }) {
  const problems = [];

  if (!existsSync(join(normalDir, "index.html"))) {
    problems.push(`The real app has not been built (no ${join(normalDir, "index.html")}). Run "npm run build" first.`);
  } else {
    if (/property="og:image"/.test(readText(join(normalDir, "index.html")))) problems.push("The real app's page has a share picture (og:image); only the demo should.");
    for (const f of files(normalDir)) {
      if (!/\.(js|css|html|svg|json|map)$/.test(f)) continue;
      const text = readText(f);
      for (const marker of DEMO_MARKERS) if (text.includes(marker)) problems.push(`The real app contains demo text "${marker}" (in ${f}).`);
    }
  }

  const demoIndex = join(demoDir, "index.html");
  if (!existsSync(demoIndex)) {
    problems.push(`The demo has not been built (no ${demoIndex}). Run "npm run build:demo" first.`);
  } else {
    const html = readText(demoIndex);
    // Files the page loads must be found next to it ("./assets/x.js"), never from the site's root ("/assets/x.js"), or the
    // demo shows a blank page when it lives in a sub-folder such as /<repo>/.
    for (const m of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
      const target = m[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) continue; // other sites, anchors
      if (!target.startsWith("./")) problems.push(`The demo's page refers to "${target}", which is not relative to the page.`);
      else if (!existsSync(join(demoDir, target))) problems.push(`The demo's page refers to "${target}", which is missing.`);
    }
    // The picture a pasted link shows. Sites that read it want its full address, so the page names it in full; the file
    // itself must be in the build under that last part of the address.
    const shareImage = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/)?.[1];
    if (!shareImage) problems.push("The demo's page has no share picture (og:image).");
    else if (!existsSync(join(demoDir, shareImage.split("/").pop() ?? ""))) problems.push(`The demo's share picture "${shareImage}" is not in the build.`);
    const alltext = [...files(demoDir)].filter((f) => /\.js$/.test(f)).map(readText).join("\n");
    for (const marker of DEMO_MARKERS) if (!alltext.includes(marker)) problems.push(`The demo does not contain "${marker}": it is not the demo build.`);
    // A hash-based address keeps every page inside index.html, so a static host needs no "not found" page for it.
    if (existsSync(join(demoDir, "404.html"))) problems.push("The demo has a 404.html, which it does not need.");
  }
  return problems;
}

export function main(argv = process.argv.slice(2), log = console.log) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "frontend");
  const problems = checkDemoBuild({ normalDir: resolve(root, "dist"), demoDir: resolve(root, "dist-demo") });
  if (problems.length === 0) {
    log("ok: the real app has none of the demo in it, and the demo is complete and can be put in any folder.");
    return 0;
  }
  for (const p of problems) log(`PROBLEM: ${p}`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main());
