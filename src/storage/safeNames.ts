/**
 * Names that are safe to use as a folder or file name on a real disk — including a Windows one.
 *
 * Evidence kept on the server's own disk ends up as ordinary folders and files, named after things people typed (a
 * client's name, an audit cycle's name, an uploaded file's name). Without care, such a name could climb out of the
 * evidence folder ("../../x"), name a Windows device ("CON", "NUL"), hide itself (leading dot), or simply be refused by
 * the operating system (":", "?", a trailing dot or space). Two functions, used together:
 *
 *   safeSegment(raw)  turns any text into a name that is always acceptable (what is written to disk);
 *   isSafeSegment(s)  decides whether a name read BACK from the database or a link is acceptable (what is trusted).
 *
 * isSafeSegment accepts everything safeSegment produces and nothing that could escape or be refused.
 */

const FORBIDDEN_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/;
const FORBIDDEN_CHARS_GLOBAL = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** Longest name kept for a folder, and for a file. Windows refuses whole paths over 260 characters unless long paths are
 *  switched on, and a path here is made of several of these, so they are kept well short. */
export const MAX_FOLDER_NAME = 80;
export const MAX_FILE_NAME = 100;

/** "Audit [1a2b3c4d]": the short code at the end is what keeps two audit cycles apart, so cutting a long name must never cut it. */
const TAIL_CODE = /^(.*?)(\s?\[[0-9a-f]{8}\])$/s;

function truncate(s: string, max: number): string {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  const tail = s.match(TAIL_CODE);
  if (tail) {
    const keep = Array.from(tail[2]).length;
    return Array.from(tail[1]).slice(0, Math.max(1, max - keep)).join("").replace(/[. ]+$/, "") + tail[2];
  }
  return chars.slice(0, max).join("").replace(/[. ]+$/, "");
}

/** Any text → a name that is always acceptable as a single folder name. Never empty, never "." or "..", never hidden. */
export function safeSegment(raw: string, fallback = "Untitled", max = MAX_FOLDER_NAME): string {
  let s = raw.normalize("NFC").replace(FORBIDDEN_CHARS_GLOBAL, "-").replace(/\s+/g, " ").trim();
  s = s.replace(/^\.+/, (dots) => "_".repeat(dots.length));      // no hidden names, and "." / ".." can't survive
  s = s.replace(/[. ]+$/, "");                                     // Windows refuses a trailing dot or space
  s = truncate(s, max);
  if (!s) s = fallback;
  if (WINDOWS_DEVICE.test(s)) s = `_${s}`;
  return s;
}

/** Like safeSegment, for an uploaded file: the extension (".pdf") is kept intact when the name has to be shortened. */
export function safeFileName(raw: string): string {
  const base = raw.normalize("NFC");
  const dot = base.lastIndexOf(".");
  // The ending (".pdf") is cleaned on its own, without safeSegment's rule against a leading dot, then put back.
  const endingBody = dot > 0 && base.length - dot <= 10 ? safeSegment(base.slice(dot + 1), "", 9) : "";
  if (!endingBody) return safeSegment(raw, "file", MAX_FILE_NAME);
  const ext = `.${endingBody}`;
  const stem = safeSegment(base.slice(0, dot), "file", Math.max(1, MAX_FILE_NAME - Array.from(ext).length));
  const joined = stem + ext;
  return WINDOWS_DEVICE.test(joined) ? `_${joined}` : joined;
}

/** Is this, exactly as given, acceptable as a single folder or file name? (For names that come back from outside.) */
export function isSafeSegment(s: unknown): s is string {
  return typeof s === "string"
    && s.length > 0 && Array.from(s).length <= 255
    && s !== "." && s !== ".."
    && !s.startsWith(".")
    && !FORBIDDEN_CHARS.test(s)
    && !/[. ]$/.test(s)
    && !WINDOWS_DEVICE.test(s)
    && s === s.normalize("NFC");
}

/**
 * A stored location ("Evidence Portal – Acme/Audit [1a2b3c4d]/A.8.5/report.pdf") → its names, or null if any part of it
 * is not acceptable. Always forward slashes, whatever the operating system: it is a stored value, not a disk path.
 */
export function splitStoredPath(id: unknown): string[] | null {
  if (typeof id !== "string" || id.length === 0 || id.length > 1024) return null;
  const parts = id.split("/");
  return parts.every((p) => isSafeSegment(p)) ? parts : null;
}
