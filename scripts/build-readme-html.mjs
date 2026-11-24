#!/usr/bin/env node
// Makes README.html from README.md: the same guide, laid out for reading on your own computer.
//
// Why: README.md is written for GitHub, which draws its tables, diagram and headings. Opened in Notepad or a code editor
// it shows raw text and looks broken. README.html is one self-contained file (no internet, no scripts to download) that any
// browser shows properly: a contents list at the side, a Copy button on every command, tables that scroll instead of
// breaking the page, and light and dark colours that follow the computer's setting.
//
//   npm run docs                    rebuild README.html (do this after every change to README.md)
//   npm run docs -- --render-diagram   also redraw docs/architecture.svg from the diagram in README.md
//                                   (needs the Mermaid command-line tool: npm install -g @mermaid-js/mermaid-cli)
//
// The test tests/69-readme-html.test.ts fails when README.html no longer matches README.md.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Marked } from "marked";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const README = join(ROOT, "README.md");
const OUT = join(ROOT, "README.html");
const DIAGRAM = join(ROOT, "docs", "architecture.svg");

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const MERMAID_RE = /```mermaid\n([\s\S]*?)\n```/;
/** The text of the diagram, exactly as it is hashed (also used by the test). */
export const mermaidSource = (readme) => { const m = MERMAID_RE.exec(readme); return m ? m[1].trim() + "\n" : null; };

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** GitHub's way of turning a heading into an address, so the links written for GitHub work here too. */
export function slugger() {
  const seen = new Map();
  return (text) => {
    const base = text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s/g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };
}

function renderDiagramFromSource(readme) {
  const src = mermaidSource(readme);
  if (!src) return;
  const dir = mkdtempSync(join(tmpdir(), "readme-diagram-"));
  try {
    writeFileSync(join(dir, "diagram.mmd"), src);
    const config = join(dir, "puppeteer.json");
    writeFileSync(config, JSON.stringify({ args: ["--no-sandbox"] }));
    execFileSync("mmdc", ["-p", config, "-i", join(dir, "diagram.mmd"), "-o", join(dir, "diagram.svg"), "-b", "white"], { stdio: "inherit", shell: process.platform === "win32" });
    writeFileSync(DIAGRAM, `<!-- mermaid-source-sha256: ${sha256(src)} -->\n` + readFileSync(join(dir, "diagram.svg"), "utf8"));
    console.log("docs/architecture.svg redrawn.");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function loadDiagram(readme) {
  const want = sha256(mermaidSource(readme) ?? "");
  if (!existsSync(DIAGRAM)) return null;
  const file = readFileSync(DIAGRAM, "utf8");
  const stamp = /^<!-- mermaid-source-sha256: ([0-9a-f]{64}) -->\n/.exec(file);
  if (!stamp || stamp[1] !== want) {
    throw new Error("The diagram in README.md has changed since docs/architecture.svg was drawn. Run: npm run docs -- --render-diagram");
  }
  return file.slice(stamp[0].length).trim();
}

export function build(readme) {
  const slug = slugger();
  const headings = [];
  const diagram = mermaidSource(readme) ? loadDiagram(readme) : null;

  // Text that is only for people reading README.md itself (it points at this very page) is left out here.
  const body = readme.replace(/<!-- readme-html:skip-start -->[\s\S]*?<!-- readme-html:skip-end -->\n?/g, "");

  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        const plain = decode(inner.replace(/<[^>]+>/g, ""));
        const id = slug(plain);
        if (depth === 2 || depth === 3) headings.push({ depth, id, text: plain });
        return `<h${depth} id="${id}">${inner}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${depth}>\n`;
      },
      code({ text, lang }) {
        const language = (lang ?? "").trim().split(/\s+/)[0];
        if (language === "mermaid") {
          return diagram
            ? `<figure class="diagram" role="img" aria-label="Diagram: how the people, the portal, the database and your storage connect">${diagram}</figure>\n`
            : `<pre><code>${escapeHtml(text)}</code></pre>\n`;
        }
        const label = language || "text";
        return `<div class="code"><div class="codebar"><span>${escapeHtml(label)}</span><button type="button" class="copy" aria-label="Copy this code">Copy</button></div><pre><code>${escapeHtml(text)}</code></pre></div>\n`;
      },
      link({ href, title, tokens }) {
        const inner = this.parser.parseInline(tokens);
        const external = /^https?:\/\//i.test(href);
        const t = title ? ` title="${escapeHtml(title)}"` : "";
        return `<a href="${escapeHtml(href)}"${t}${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${inner}</a>`;
      },
      image({ href, title, text }) {
        // A picture that lives on the internet (the build-status badge) would be a broken box when you are offline.
        if (/^https?:\/\//i.test(href)) return "";
        const t = title ? ` title="${escapeHtml(title)}"` : "";
        return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"${t} loading="lazy">`;
      },
    },
  });

  let html = marked.parse(body);
  html = html.replace(/<a [^>]*>\s*<\/a>/g, ""); // the link around the removed badge
  html = html.replace(/<p>\s*<\/p>\n?/g, "");
  html = html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, "</table></div>");

  const title = decode((/^# (.+)$/m.exec(readme)?.[1] ?? "README").replace(/[`*_]/g, ""));
  const toc = headings.map((h) => `<li class="d${h.depth}"><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`).join("\n");

  // Functions, not strings, as the replacement: the text contains "$" characters that a string would treat as patterns.
  return PAGE
    .replace("{{TITLE}}", () => escapeHtml(title))
    .replace("{{STAMP}}", () => sha256(readme))
    .replace("{{TOC}}", () => toc)
    .replace("{{BODY}}", () => html);
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{TITLE}}</title>
<meta name="generator" content="scripts/build-readme-html.mjs">
<!-- readme-sha256: {{STAMP}} -->
<style>
:root {
  color-scheme: light dark;
  --bg: #ffffff; --surface: #f6f8fa; --ink: #1f2328; --muted: #59636e; --line: #d1d9e0;
  --accent: #0b7a75; --accent-ink: #ffffff; --code-bg: #f3f5f7; --mark: #fff8c5; --quote: #0b7a75;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1419; --surface: #161c23; --ink: #e6edf3; --muted: #9aa6b2; --line: #2d3641;
    --accent: #3fc1b9; --accent-ink: #0f1419; --code-bg: #1b222b; --mark: #3b3a1a; --quote: #3fc1b9;
  }
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; scroll-padding-top: 1rem; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16.5px/1.65 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; -webkit-text-size-adjust: 100%; }
.layout { display: grid; grid-template-columns: minmax(0, 1fr); max-width: 76rem; margin: 0 auto; }
nav.toc { padding: 1rem 1.25rem; border-bottom: 1px solid var(--line); background: var(--surface); }
nav.toc details { border: 0; padding: 0; margin: 0; background: none; }
nav.toc summary { cursor: pointer; font-weight: 600; }
nav.toc ul { list-style: none; margin: .5rem 0 0; padding: 0; font-size: .92rem; }
nav.toc li { margin: 0; }
nav.toc li.d3 { padding-left: 1rem; font-size: .88rem; }
nav.toc a { display: block; padding: .18rem .5rem; border-radius: 6px; color: var(--ink); text-decoration: none; }
nav.toc a:hover { background: var(--code-bg); }
nav.toc a.current { color: var(--accent); font-weight: 600; background: var(--code-bg); }
main { padding: 1.25rem 1.25rem 4rem; min-width: 0; overflow-wrap: break-word; }
.note { background: var(--surface); border: 1px solid var(--line); border-left: 4px solid var(--accent); border-radius: 8px; padding: .65rem 1rem; margin: 0 0 1.5rem; color: var(--muted); font-size: .93rem; }
@media (min-width: 64rem) {
  .layout { grid-template-columns: 19rem minmax(0, 1fr); }
  nav.toc { position: sticky; top: 0; align-self: start; height: 100vh; overflow-y: auto; border-bottom: 0; border-right: 1px solid var(--line); padding: 1.25rem 1rem; }
  nav.toc details > summary { display: none; }
  main { padding: 2rem 2.5rem 6rem; max-width: 56rem; }
}
h1, h2, h3, h4 { line-height: 1.25; margin: 2.2rem 0 .7rem; font-weight: 650; position: relative; }
h1 { font-size: 2rem; margin-top: 0; letter-spacing: -.01em; }
h2 { font-size: 1.5rem; padding-bottom: .3rem; border-bottom: 1px solid var(--line); }
h3 { font-size: 1.2rem; }
h4 { font-size: 1.02rem; }
.anchor { margin-left: .4rem; color: var(--muted); text-decoration: none; opacity: 0; font-weight: 400; }
h1:hover .anchor, h2:hover .anchor, h3:hover .anchor, h4:hover .anchor, .anchor:focus { opacity: 1; }
p, ul, ol, blockquote, .code, .table-wrap, figure, details { margin: 0 0 1rem; }
ul, ol { padding-left: 1.5rem; }
li { margin: .25rem 0; }
li > p { margin: .25rem 0; }
a { color: var(--accent); text-underline-offset: 2px; overflow-wrap: anywhere; }
hr { border: 0; border-top: 1px solid var(--line); margin: 2rem 0; }
img { max-width: 100%; height: auto; border-radius: 8px; border: 1px solid var(--line); }
blockquote { padding: .1rem 1rem; color: var(--muted); border-left: 4px solid var(--quote); background: var(--surface); border-radius: 0 8px 8px 0; }
code { font: .88em ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace; background: var(--code-bg); padding: .1em .3em; border-radius: 5px; overflow-wrap: anywhere; }
.code { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: var(--code-bg); }
.codebar { display: flex; justify-content: space-between; align-items: center; padding: .25rem .5rem .25rem .8rem; background: var(--surface); border-bottom: 1px solid var(--line); font-size: .78rem; color: var(--muted); text-transform: lowercase; }
.copy { font: inherit; font-size: .78rem; color: var(--ink); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: .18rem .65rem; cursor: pointer; }
.copy:hover { border-color: var(--accent); color: var(--accent); }
.copy.done { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.code pre { margin: 0; padding: .85rem 1rem; overflow-x: auto; }
.code pre code { background: none; padding: 0; font-size: .86rem; line-height: 1.55; overflow-wrap: normal; white-space: pre; }
pre:not(.code pre) { overflow-x: auto; padding: .85rem 1rem; background: var(--code-bg); border: 1px solid var(--line); border-radius: 8px; }
pre:not(.code pre) code { background: none; padding: 0; }
.table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; font-size: .93rem; }
th, td { text-align: left; vertical-align: top; padding: .5rem .75rem; border-bottom: 1px solid var(--line); min-width: 7rem; }
th { background: var(--surface); font-weight: 650; position: sticky; top: 0; }
tr:last-child td { border-bottom: 0; }
tbody tr:nth-child(even) td { background: color-mix(in srgb, var(--surface) 55%, transparent); }
figure.diagram { padding: 1rem; background: #fff; border: 1px solid var(--line); border-radius: 10px; overflow-x: auto; }
figure.diagram svg { display: block; margin: 0 auto; max-width: 100%; height: auto; }
details { border: 1px solid var(--line); border-radius: 8px; padding: .5rem 1rem; background: var(--surface); }
details > summary { cursor: pointer; font-weight: 600; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
footer { margin-top: 4rem; padding-top: 1rem; border-top: 1px solid var(--line); color: var(--muted); font-size: .82rem; }
@media print {
  nav.toc, .copy, .anchor, .note { display: none; }
  .layout { display: block; } main { max-width: none; padding: 0; }
  a { color: inherit; } .code pre { white-space: pre-wrap; }
  h2, h3 { break-after: avoid; } .table-wrap, .code, figure { break-inside: avoid; }
}
</style>
</head>
<body>
<div class="layout">
<nav class="toc" aria-label="Contents">
<details open>
<summary>Contents</summary>
<ul>
{{TOC}}
</ul>
</details>
</nav>
<main>
<p class="note">This page is the same guide as <strong>README.md</strong>, laid out for reading on your own computer. It works without an internet connection. Every command has a <strong>Copy</strong> button.</p>
{{BODY}}
<footer>Made from README.md by <code>npm run docs</code>. If this page and README.md ever disagree, README.md is the one to trust.</footer>
</main>
</div>
<script>
(function () {
  // Copy buttons.
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("button.copy");
    if (!b) return;
    var code = b.closest(".code").querySelector("code");
    var text = code ? code.textContent : "";
    function done(ok) { b.textContent = ok ? "Copied" : "Press Ctrl+C"; b.classList.toggle("done", ok); setTimeout(function () { b.textContent = "Copy"; b.classList.remove("done"); }, 1600); }
    function fallback() {
      var t = document.createElement("textarea"); t.value = text; t.setAttribute("readonly", ""); t.style.position = "fixed"; t.style.opacity = "0";
      document.body.appendChild(t); t.select(); var ok = false; try { ok = document.execCommand("copy"); } catch (x) {} document.body.removeChild(t);
      if (!ok && window.getSelection) { var r = document.createRange(); r.selectNodeContents(code); var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); }
      done(ok);
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(function () { done(true); }, fallback); else fallback();
  });
  // On a narrow screen the contents list starts closed.
  if (window.matchMedia && !window.matchMedia("(min-width: 64rem)").matches) { var d = document.querySelector("nav.toc details"); if (d) d.removeAttribute("open"); }
  // Highlight the section being read.
  if ("IntersectionObserver" in window) {
    var links = {}; document.querySelectorAll("nav.toc a").forEach(function (a) { links[a.getAttribute("href").slice(1)] = a; });
    var current = null;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting && links[en.target.id]) { if (current) current.classList.remove("current"); current = links[en.target.id]; current.classList.add("current"); } });
    }, { rootMargin: "0px 0px -75% 0px" });
    document.querySelectorAll("main h2[id], main h3[id]").forEach(function (h) { io.observe(h); });
  }
})();
</script>
</body>
</html>
`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const readme = readFileSync(README, "utf8");
  if (process.argv.includes("--render-diagram")) renderDiagramFromSource(readme);
  writeFileSync(OUT, build(readme));
  console.log(`README.html written (${Math.round(readFileSync(OUT).length / 1024)} KB).`);
}
