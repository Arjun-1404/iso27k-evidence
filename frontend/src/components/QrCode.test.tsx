import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { scanQr as scan } from "../test/scanQr";
import { QrCode } from "./QrCode";

const URI = "otpauth://totp/Evidence%20Portal:priya%40harbor.test?secret=JBSWY3DPEHPK3PXP&issuer=Evidence%20Portal&algorithm=SHA1&digits=6&period=30";

/** Each call renders into its own container, so a test can draw several codes and compare them. */
const drawn = (value: string) => {
  const svg = render(<QrCode value={value} label="QR code" />).container.querySelector("svg");
  if (!svg) throw new Error("nothing was drawn");
  return svg;
};

describe("QrCode", () => {
  it("draws a code that a QR decoder reads back as exactly the text it was given", () => {
    expect(scan(drawn(URI))).toBe(URI);
  });

  it("works for short and long text alike (the codes get bigger, they still scan)", () => {
    for (const text of ["x", "otpauth://totp/a?secret=ABC", URI + "&extra=" + "y".repeat(120)]) expect(scan(drawn(text)), text).toBe(text);
  });

  it("different text gives a different picture", () => {
    expect(drawn(URI).querySelector("path")!.getAttribute("d")).not.toBe(drawn(URI.replace("JBSW", "ZZZZ")).querySelector("path")!.getAttribute("d"));
  });

  it("leaves the blank border a scanner needs, on a white background", () => {
    const svg = drawn(URI);
    const size = Number(svg.getAttribute("viewBox")!.split(" ")[2]);
    expect(svg.querySelector("rect")!.getAttribute("fill")).toBe("#ffffff");
    const coords = [...svg.querySelector("path")!.getAttribute("d")!.matchAll(/M(\d+),(\d+)h1v1h-1z/g)].map((m) => [Number(m[1]), Number(m[2])]);
    // The QR standard asks for four blank modules all round; written out here, not imported, so changing it is noticed.
    expect(Math.min(...coords.flat())).toBe(4);
    expect(Math.max(...coords.flat())).toBe(size - 4 - 1);
  });

  it("is labelled for screen readers", () => {
    expect(render(<QrCode value="hello" label="QR code for your authenticator app" />).getByRole("img", { name: "QR code for your authenticator app" })).toBeInTheDocument();
  });

  it("draws nothing — and does not crash the page — for text too long to encode", () => {
    const { container } = render(<QrCode value={"z".repeat(20000)} label="QR code" />);
    expect(container.querySelector("svg")).toBeNull();
  });
});
