/**
 * The stylesheet writes every colour as oklch(), a notation that browsers have only understood since Firefox 113, Chrome 111
 * and Safari 15.4. A browser older than that does not fail loudly: it ignores each colour it cannot read, so the dark sidebar
 * disappears while its white menu text stays, and the page looks half blank. This notices that case, so the person is told
 * to update the browser instead of being left to guess.
 */
type CssLike = { supports?: (property: string, value?: string) => boolean } | null;

/** True when this browser can read the colours the portal uses. If it cannot even answer the question, it is too old. */
export function browserCanShowColours(css: CssLike = typeof CSS === "undefined" ? null : CSS): boolean {
  if (!css || typeof css.supports !== "function") return false;
  try { return css.supports("color", "oklch(50% 0.1 200)"); } catch { return false; }
}

export const NEWER_BROWSER_NOTICE_ID = "newer-browser-notice";

/**
 * A bar across the top of the page. It uses plain hex colours and no stylesheet classes, because the stylesheet is exactly what
 * this browser cannot read; it would otherwise be as invisible as the sidebar. Shown at most once.
 */
export function showNewerBrowserNotice(doc: Document = document): void {
  if (doc.getElementById(NEWER_BROWSER_NOTICE_ID)) return;
  const bar = doc.createElement("div");
  bar.id = NEWER_BROWSER_NOTICE_ID;
  bar.setAttribute("role", "alert");
  bar.style.cssText = "background:#fef3c7;color:#451a03;border-bottom:2px solid #d97706;padding:12px 16px;font:15px/1.45 system-ui,Arial,sans-serif;";
  bar.textContent =
    "This browser is too old to show the portal properly: colours and parts of the layout will be missing. " +
    "Please update it (Firefox 128 or newer, Chrome or Edge 111 or newer, or Safari 16.4 or newer) or open the portal in another browser.";
  doc.body.insertBefore(bar, doc.body.firstChild);
}
