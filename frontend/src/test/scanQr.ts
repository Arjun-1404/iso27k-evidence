import jsQR from "jsqr";

/** Reads a drawn QR code back the way a phone camera would: turns the SVG into pixels and runs a real QR decoder
 *  on them. Returns the text it holds, or null if it can't be read. Strict about colour: dark on light only, since
 *  many phone cameras can't read an inverted code. */
export function scanQr(svg: Element, pixelsPerModule = 6): string | null {
  const size = Number(svg.getAttribute("viewBox")!.split(" ")[2]);
  const px = size * pixelsPerModule;
  const rgba = new Uint8ClampedArray(px * px * 4).fill(255); // white, opaque
  const d = svg.querySelector("path")!.getAttribute("d")!;
  for (const m of d.matchAll(/M(\d+),(\d+)h1v1h-1z/g)) {
    const [x, y] = [Number(m[1]), Number(m[2])];
    for (let dy = 0; dy < pixelsPerModule; dy++) for (let dx = 0; dx < pixelsPerModule; dx++) {
      const i = ((y * pixelsPerModule + dy) * px + x * pixelsPerModule + dx) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = 0;
    }
  }
  return jsQR(rgba, px, px, { inversionAttempts: "dontInvert" })?.data ?? null;
}
