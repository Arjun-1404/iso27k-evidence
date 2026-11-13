/** "skipped" means no scan was attempted at all (no scanner is configured) — deliberately a different word
 *  from "clean", so an instance without ClamAV never tells a reviewer a file was checked when it wasn't. */
export type ScanResult = "clean" | "infected" | "unscannable" | "skipped";

/**
 * Thrown when a scanner could not give an answer at all (the scanning service is down, timed out, or sent
 * something unintelligible). This is deliberately NOT a ScanResult: "I couldn't check" must never be
 * mistaken for "it's clean", and callers have to handle it explicitly. The message never contains file
 * names or file content.
 */
export class ScannerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScannerUnavailableError";
  }
}

/** Swappable malware scanner (a ClamAV worker in production) behind one interface. */
export interface Scanner {
  scan(fileName: string, bytes: ArrayLike<number>): Promise<ScanResult>;
}

/** The standard antivirus test string: harmless, and every real scanner reports it as a virus. Used by the fake scanner
 *  below and by the settings page's "check the scanner" button. */
export const EICAR_TEST_STRING = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

/**
 * A fake scanner for tests: flags any file whose name contains "infected" or whose bytes match the
 * standard EICAR antivirus test string, so both trigger paths (name-based and content-based) can be tested.
 */
export class FakeScanner implements Scanner {
  async scan(fileName: string, bytes: ArrayLike<number>): Promise<ScanResult> {
    if (fileName.toLowerCase().includes("unscannable")) return "unscannable";
    const text = Buffer.from(bytes as Uint8Array).toString("utf8");
    if (fileName.toLowerCase().includes("infected") || text.includes(EICAR_TEST_STRING)) return "infected";
    return "clean";
  }
}

/** Used when no real scanner is configured: records every file as "skipped" instead of pretending to check. */
export class NoScanner implements Scanner {
  async scan(): Promise<ScanResult> {
    return "skipped";
  }
}
