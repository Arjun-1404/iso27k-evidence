import { afterEach, describe, expect, it } from "vitest";
import { browserCanShowColours, NEWER_BROWSER_NOTICE_ID, showNewerBrowserNotice } from "./browserSupport";

/**
 * A real report: on Firefox older than 113 the portal showed a white page with one grey box, because every colour in the
 * stylesheet is written as oklch(), which that browser ignores. These checks keep the warning that replaces the guesswork.
 */
afterEach(() => { document.body.innerHTML = ""; });

describe("browserCanShowColours", () => {
  it("is true when the browser reads oklch colours, and asks about exactly the notation the stylesheet uses", () => {
    const asked: string[] = [];
    expect(browserCanShowColours({ supports: (p, v) => { asked.push(`${p}: ${v}`); return true; } })).toBe(true);
    expect(asked).toEqual(["color: oklch(50% 0.1 200)"]);
  });

  it("is false when the browser says it cannot read them (Firefox before 113)", () => {
    expect(browserCanShowColours({ supports: () => false })).toBe(false);
  });

  it("is false for a browser too old to answer, or one that throws while answering", () => {
    expect(browserCanShowColours(null)).toBe(false);
    expect(browserCanShowColours({})).toBe(false);
    expect(browserCanShowColours({ supports: () => { throw new Error("nope"); } })).toBe(false);
  });
});

describe("showNewerBrowserNotice", () => {
  it("puts a visible alert above everything else, naming the versions that work", () => {
    document.body.innerHTML = '<div id="root">the app</div>';
    showNewerBrowserNotice(document);
    const bar = document.getElementById(NEWER_BROWSER_NOTICE_ID)!;
    expect(document.body.firstElementChild).toBe(bar);
    expect(bar.getAttribute("role")).toBe("alert");
    expect(bar.textContent).toMatch(/too old/);
    expect(bar.textContent).toContain("Firefox 128");
    expect(bar.textContent).toContain("Chrome or Edge 111");
    expect(document.getElementById("root")!.textContent).toBe("the app"); // the app underneath is left alone
  });

  it("does not depend on the stylesheet: plain colours any browser reads (hex or rgb), no oklch, no variables, no classes", () => {
    showNewerBrowserNotice(document);
    const bar = document.getElementById(NEWER_BROWSER_NOTICE_ID)!;
    expect(bar.className).toBe("");
    expect(bar.getAttribute("style")).toMatch(/background:\s*(#[0-9a-f]{6}|rgb\()/i); // jsdom writes hex back as rgb()
    expect(bar.getAttribute("style")).not.toMatch(/oklch|var\(/);
  });

  it("shows only one, however many times it is asked", () => {
    showNewerBrowserNotice(document); showNewerBrowserNotice(document);
    expect(document.querySelectorAll(`#${NEWER_BROWSER_NOTICE_ID}`)).toHaveLength(1);
  });
});
