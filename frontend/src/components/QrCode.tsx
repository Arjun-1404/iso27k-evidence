import { useMemo } from "react";
import qrcode from "qrcode-generator";

/** The empty border a scanner needs around a QR code, in modules (the standard asks for four). */
export const QUIET_ZONE = 4;

/** A QR code drawn as one SVG path: sharp at any size, no image file, nothing sent anywhere. Renders nothing if
 *  the text is too long to encode — the caller always offers the secret as text too. */
export function QrCode({ value, label, className }: { value: string; label: string; className?: string }) {
  const drawing = useMemo(() => {
    try {
      const qr = qrcode(0, "M");
      qr.addData(value);
      qr.make();
      const n = qr.getModuleCount();
      let d = "";
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + QUIET_ZONE},${r + QUIET_ZONE}h1v1h-1z`;
      return { d, size: n + QUIET_ZONE * 2 };
    } catch {
      return null;
    }
  }, [value]);
  if (!drawing) return null;
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${drawing.size} ${drawing.size}`} shapeRendering="crispEdges" className={className}>
      <rect width={drawing.size} height={drawing.size} fill="#ffffff" />
      <path d={drawing.d} fill="#000000" />
    </svg>
  );
}
