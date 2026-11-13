import { createHash } from "node:crypto";
import { AppError } from "../errors.ts";
import { EmailDeliveryError, type EmailMessage, type EmailSender } from "../email/types.ts";
import { ScannerUnavailableError, type ScanResult, type Scanner } from "../scan/types.ts";
import { GoogleOAuthClient, type ExchangedTokens, type GoogleOAuth, type RefreshedAccessToken } from "../storage/googleOAuth.ts";
import type { Fetcher } from "../storage/googleDrive.ts";
import { buildEmailSender, buildScanner, type StartupLog } from "../wiring.ts";
import type { RuntimeSettings } from "./runtime.ts";

/**
 * The mail sender, the malware scanner and the Google OAuth client, as the rest of the app already uses them — but
 * each one looks at the settings in force at the moment it is used. That is what lets the owner change them in the web
 * app with no restart. When the settings change, the next call builds a fresh connection (and logs what it found);
 * when they don't, the same one is reused.
 *
 * What happens when the settings themselves can't be loaded (the database is unreachable and nothing was ever loaded)
 * is deliberately NOT "treat it as not configured": that would quietly print sign-in links to a log, or record
 * files as unscanned. Mail fails as undelivered, scanning fails as unavailable, Google fails as unavailable.
 */

const fingerprint = (v: unknown) => createHash("sha256").update(JSON.stringify(v ?? null)).digest("hex");

/**
 * After startup, the same log lines say [settings] instead of [startup], because they describe a change, not a boot.
 * Decided when the connection is built, not when a line is written: the reachability check reports a moment later, and
 * by then another change may already have happened.
 */
function relabelled(out: StartupLog, startup: boolean): StartupLog {
  if (startup) return out;
  const tag = (line: string) => line.replace(/^\[startup\]/, "[settings]");
  return { log: (l) => out.log(tag(l)), warn: (l) => out.warn(tag(l)) };
}

export class LiveEmailSender implements EmailSender {
  private built?: { key: string; sender: EmailSender };
  private first = true;

  constructor(private readonly runtime: RuntimeSettings, private readonly out: StartupLog = console) {}

  private async sender(): Promise<EmailSender> {
    const smtp = (await this.runtime.current()).email.settings;
    const key = smtp ? fingerprint(smtp) : "none";
    if (this.built?.key !== key) {
      this.built = { key, sender: buildEmailSender({ smtp }, relabelled(this.out, this.first)).sender };
      this.first = false;
    }
    return this.built.sender;
  }

  /** Called once at startup so the log says right away whether mail is set up and reachable. Never rejects. */
  async prepare(): Promise<void> {
    try { await this.sender(); } catch { this.out.warn("[startup] The server settings could not be read from the database, so mail is not ready yet."); }
  }

  async send(message: EmailMessage): Promise<void> {
    let sender: EmailSender;
    try { sender = await this.sender(); } catch {
      throw new EmailDeliveryError("Email not delivered: the server's email settings could not be loaded.", "other");
    }
    return sender.send(message);
  }
}

export class LiveScanner implements Scanner {
  private built?: { key: string; scanner: Scanner };
  private first = true;

  constructor(private readonly runtime: RuntimeSettings, private readonly out: StartupLog = console) {}

  private async scanner(): Promise<Scanner> {
    const clamav = (await this.runtime.current()).scanner.settings;
    const key = clamav ? fingerprint(clamav) : "none";
    if (this.built?.key !== key) {
      this.built = { key, scanner: buildScanner({ clamav }, relabelled(this.out, this.first)).scanner };
      this.first = false;
    }
    return this.built.scanner;
  }

  async prepare(): Promise<void> {
    try { await this.scanner(); } catch { this.out.warn("[startup] The server settings could not be read from the database, so the malware scanner is not ready yet."); }
  }

  async scan(fileName: string, bytes: ArrayLike<number>): Promise<ScanResult> {
    let scanner: Scanner;
    try { scanner = await this.scanner(); } catch {
      throw new ScannerUnavailableError("The malware scanner's settings could not be loaded just now.");
    }
    return scanner.scan(fileName, bytes);
  }
}

export class LiveGoogleOAuth implements GoogleOAuth {
  private built?: { key: string; client: GoogleOAuthClient };

  constructor(private readonly runtime: RuntimeSettings, private readonly fetcher?: Fetcher) {}

  private async client(): Promise<GoogleOAuthClient> {
    let google;
    try { google = (await this.runtime.current()).google.settings; } catch {
      throw new AppError("The server's Google settings could not be loaded just now. Please try again in a moment.", 503, "OAUTH_UNAVAILABLE");
    }
    if (!google) {
      throw new AppError(
        "Google Drive isn't set up on this server yet. The owner of this installation can enter the Google app details under Server settings.",
        503, "OAUTH_NOT_CONFIGURED");
    }
    const key = fingerprint(google);
    if (this.built?.key !== key) this.built = { key, client: new GoogleOAuthClient(google, this.fetcher) };
    return this.built.client;
  }

  async buildAuthUrl(state: string): Promise<string> { return (await this.client()).buildAuthUrl(state); }
  async exchangeCode(code: string): Promise<ExchangedTokens> { return (await this.client()).exchangeCode(code); }
  async refreshAccessToken(refreshToken: string): Promise<RefreshedAccessToken> { return (await this.client()).refreshAccessToken(refreshToken); }
}
