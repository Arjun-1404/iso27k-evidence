export interface EmailMessage {
  to: string[];
  subject: string;
  text: string;
}

export type EmailFailureKind =
  | "invalid_message"  // refused before anything was sent (bad address, header-injection attempt, ...)
  | "unreachable"      // couldn't connect, or the connection timed out
  | "auth"             // the mail server rejected our credentials
  | "rejected"         // the mail server refused the message or every recipient
  | "other";

/**
 * Thrown by any EmailSender when a message could not be delivered. The message is always safe to log: it
 * never contains credentials, recipient addresses or the message body (invite emails carry a sign-in link,
 * which is as good as a password, so it must not end up in a log file by accident).
 */
export class EmailDeliveryError extends Error {
  constructor(message: string, readonly kind: EmailFailureKind) {
    super(message);
    this.name = "EmailDeliveryError";
  }
}

/** Swappable email transport (Azure Communication Services, Postmark, SMTP, ...) behind one interface. */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** Captures every message instead of sending it — for tests and local development. */
export class FakeEmailSender implements EmailSender {
  sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}
