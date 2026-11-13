import type { Config } from "./config.ts";
import type { EmailSender } from "./email/types.ts";
import { SmtpEmailSender } from "./email/smtp.ts";
import { ConsoleEmailSender } from "./email/console.ts";
import type { Scanner } from "./scan/types.ts";
import { NoScanner } from "./scan/types.ts";
import { ClamAvScanner } from "./scan/clamav.ts";

export interface StartupLog { log(line: string): void; warn(line: string): void }

/**
 * Picks the real email sender when SMTP is configured, otherwise the log-only fallback (with a loud
 * warning). When real, it also checks the mail server in the background: a problem is reported in the log
 * right at startup, but never stops the server — the portal is still useful while mail is being fixed, and
 * a failed send already tells the user (see services/emailDelivery.ts). `startupCheck` resolves when that
 * background check has finished; it never rejects.
 */
export function buildEmailSender(config: Pick<Config, "smtp">, out: StartupLog = console): { sender: EmailSender; startupCheck: Promise<void> } {
  if (!config.smtp) {
    out.warn("[startup] SMTP_HOST is not set and no mail server is saved under Server settings, so invitation and reminder emails are NOT sent: they are printed to this log instead. " +
      "Invite links work like passwords — do not run a real deployment this way. See .env.example.");
    return { sender: new ConsoleEmailSender(), startupCheck: Promise.resolve() };
  }
  const sender = new SmtpEmailSender(config.smtp);
  if (config.smtp.security === "none") {
    out.warn("[startup] SMTP_SECURITY=none: emails (which contain sign-in links) travel unencrypted. Fine for a local mail catcher, not for production.");
  }
  const startupCheck = sender.verify().then(
    () => { out.log(`[startup] mail server ${config.smtp!.host}:${config.smtp!.port} is reachable.`); },
    (e: Error) => { out.warn(`[startup] ${e.message} Emails will fail until this is fixed.`); },
  );
  return { sender, startupCheck };
}

/**
 * Picks the ClamAV scanner when CLAMD_HOST is set. Otherwise uploads are recorded as "skipped" — never as
 * "clean" — so nobody is told a file was checked when it wasn't.
 */
export function buildScanner(config: Pick<Config, "clamav">, out: StartupLog = console): { scanner: Scanner; startupCheck: Promise<void> } {
  if (!config.clamav) {
    out.warn("[startup] CLAMD_HOST is not set and no scanner is saved under Server settings, so uploaded files are NOT scanned for malware; they are recorded as \"skipped\". See .env.example.");
    return { scanner: new NoScanner(), startupCheck: Promise.resolve() };
  }
  const scanner = new ClamAvScanner(config.clamav);
  const startupCheck = scanner.ping().then(
    () => { out.log(`[startup] ClamAV at ${config.clamav!.host}:${config.clamav!.port} is reachable.`); },
    (e: Error) => { out.warn(`[startup] ${e.message} Uploads will be refused (503) until ClamAV is reachable.`); },
  );
  return { scanner, startupCheck };
}
