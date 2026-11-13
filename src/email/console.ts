import type { EmailMessage, EmailSender } from "./types.ts";

/**
 * Development fallback used when no SMTP server is configured: prints each message to the server log
 * instead of sending it. That is the only way to get an invite link in this mode — and it also means the
 * link (which works like a password) lands in the log, so never run production this way.
 */
export class ConsoleEmailSender implements EmailSender {
  constructor(private readonly log: (line: string) => void = console.log) {}
  async send(message: EmailMessage): Promise<void> {
    this.log(`[email:not-sent] to=${message.to.join(",")} subject=${JSON.stringify(message.subject)}\n${message.text}`);
  }
}
