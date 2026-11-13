import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type { ConnectionOptions } from "node:tls";
import { EmailDeliveryError, type EmailMessage, type EmailSender, type EmailFailureKind } from "./types.ts";

/**
 * How the connection to the mail server is protected.
 *  - "starttls": connect in the clear, then REQUIRE an upgrade to TLS before anything sensitive is sent
 *                (typically port 587). If the server doesn't offer it, sending fails rather than falling
 *                back to plain text.
 *  - "tls":      TLS from the first byte (typically port 465).
 *  - "none":     no encryption at all. Only for a mail catcher on your own machine (MailHog, Mailpit, ...).
 */
export type SmtpSecurity = "starttls" | "tls" | "none";

export interface SmtpSettings {
  host: string;
  port: number;
  security: SmtpSecurity;
  /** Both or neither. */
  user?: string;
  password?: string;
  /** The From: address, e.g. "Evidence Portal <noreply@yourfirm.example>". */
  from: string;
  /** How long to wait on the mail server before giving up, in milliseconds. Default 10 seconds. */
  timeoutMs?: number;
}

const MAX_RECIPIENTS = 50;
const MAX_SUBJECT = 200;
// Deliberately plain: one @, no spaces, no characters that have meaning in an address header. Anything
// fancier (quoted local parts, comments, display names) is rejected rather than interpreted — we only ever
// send to addresses that were already validated as simple email addresses when the user was invited.
const SIMPLE_ADDRESS = /^[^\s@<>(),;:"\\[\]]+@[^\s@<>(),;:"\\[\]]+\.[^\s@<>(),;:"\\[\]]+$/;
const CTRL = /[\r\n\0]/;

/** Throws if the message could be used to smuggle extra headers or recipients. Exported for testing. */
export function assertSafeMessage(m: EmailMessage): void {
  const bad = (why: string) => { throw new EmailDeliveryError(`Message refused: ${why}`, "invalid_message"); };
  if (!Array.isArray(m.to) || m.to.length === 0) bad("no recipients");
  if (m.to.length > MAX_RECIPIENTS) bad(`more than ${MAX_RECIPIENTS} recipients`);
  for (const a of m.to) {
    if (typeof a !== "string" || CTRL.test(a) || !SIMPLE_ADDRESS.test(a)) bad("a recipient is not a plain email address");
  }
  if (typeof m.subject !== "string" || m.subject.trim() === "") bad("empty subject");
  if (CTRL.test(m.subject)) bad("subject contains a line break");
  if (m.subject.length > MAX_SUBJECT) bad("subject too long");
  if (typeof m.text !== "string" || m.text === "") bad("empty body");
}

function classify(e: unknown): EmailFailureKind {
  const code = (e as { code?: string }).code ?? "";
  if (["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS", "ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "EHOSTUNREACH", "ETLS"].includes(code)) return "unreachable";
  if (code === "EAUTH") return "auth";
  if (["EENVELOPE", "EMESSAGE"].includes(code)) return "rejected";
  const rc = (e as { responseCode?: number }).responseCode;
  if (typeof rc === "number" && rc >= 500) return "rejected";
  return "other";
}

const KIND_TEXT: Record<EmailFailureKind, string> = {
  invalid_message: "the message was refused before sending",
  unreachable: "could not reach the mail server",
  auth: "the mail server rejected the portal's login",
  rejected: "the mail server refused the message",
  other: "an unexpected error occurred",
};

/**
 * Sends mail through any SMTP server — which covers almost every provider (Microsoft 365, Google
 * Workspace, Amazon SES, Postmark, SendGrid, Mailgun, a self-hosted Postfix, ...). Plain text only: the
 * portal's emails are short notifications with a link, and no HTML means nothing to escape or spoof.
 */
export class SmtpEmailSender implements EmailSender {
  private readonly transport: Transporter;
  private readonly from: string;

  /** `tlsOptions` is for tests and unusual setups (e.g. a private CA); it isn't exposed as an env setting. */
  constructor(settings: SmtpSettings, tlsOptions?: ConnectionOptions) {
    if (CTRL.test(settings.from) || settings.from.trim() === "") throw new Error("SMTP from-address is empty or contains a line break.");
    if ((settings.user === undefined) !== (settings.password === undefined)) throw new Error("SMTP user and password must be set together.");
    this.from = settings.from;
    this.transport = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.security === "tls",
      requireTLS: settings.security === "starttls",
      ignoreTLS: settings.security === "none",
      auth: settings.user !== undefined ? { user: settings.user, pass: settings.password! } : undefined,
      // Bounded waits: a mail server that hangs must not hang the HTTP request behind it.
      connectionTimeout: settings.timeoutMs ?? 10_000,
      greetingTimeout: settings.timeoutMs ?? 10_000,
      socketTimeout: (settings.timeoutMs ?? 10_000) * 2,
      // Messages are plain text built by us; nothing should ever make the mailer read files or fetch URLs.
      disableFileAccess: true,
      disableUrlAccess: true,
      tls: tlsOptions,
    });
  }

  async send(message: EmailMessage): Promise<void> {
    assertSafeMessage(message);
    try {
      const info = await this.transport.sendMail({ from: this.from, to: message.to, subject: message.subject, text: message.text });
      const accepted = Array.isArray(info.accepted) ? info.accepted.length : 0;
      if (accepted === 0) throw new EmailDeliveryError(`Email not delivered: ${KIND_TEXT.rejected}.`, "rejected");
      const rejected = Array.isArray(info.rejected) ? info.rejected.length : 0;
      if (rejected > 0) console.warn(`[email] ${rejected} of ${accepted + rejected} recipients were refused by the mail server.`);
    } catch (e) {
      if (e instanceof EmailDeliveryError) throw e;
      const kind = classify(e);
      // Only the error CODE is kept — never the original message, which can echo addresses or server banners.
      const code = (e as { code?: string }).code;
      throw new EmailDeliveryError(`Email not delivered: ${KIND_TEXT[kind]}${code ? ` (${code})` : ""}.`, kind);
    }
  }

  /** Checks that the server is reachable and the credentials work, without sending anything. */
  async verify(): Promise<void> {
    try {
      await this.transport.verify();
    } catch (e) {
      const kind = classify(e);
      const code = (e as { code?: string }).code;
      throw new EmailDeliveryError(`Mail server check failed: ${KIND_TEXT[kind]}${code ? ` (${code})` : ""}.`, kind);
    }
  }

  close(): void { this.transport.close(); }
}
