/**
 * The Content-Disposition header that makes a browser SAVE a download under its own name instead of showing it.
 * File names are whatever people uploaded, so nothing is passed through as typed: the plain `filename` is cut down to
 * safe ASCII (for old clients), and the real name goes in `filename*` (RFC 5987), percent-encoded, which cannot carry a
 * quote, a line break or a path.
 */
export function attachmentHeader(fileName: string): string {
  const ascii = fileName.normalize("NFKD").replace(/[^A-Za-z0-9._ -]/g, "_").replace(/^\.+/, "_").slice(0, 150) || "download";
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
