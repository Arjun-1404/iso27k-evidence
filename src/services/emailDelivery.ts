import { AppError } from "../errors.ts";
import { EmailDeliveryError, type EmailMessage, type EmailSender } from "../email/types.ts";

export const EMAIL_FAILED = "EMAIL_DELIVERY_FAILED";

/**
 * Sends one email and turns ANY failure into a clean 502 the API can return. What gets logged is only the
 * sender's own failure summary (which by contract holds no addresses, credentials or message text) — the
 * body of an invite email is a sign-in link and must never end up in a log because a send went wrong.
 */
export async function deliver(email: EmailSender, message: EmailMessage): Promise<void> {
  try {
    await email.send(message);
  } catch (e) {
    console.error(e instanceof EmailDeliveryError ? `[email] ${e.message}` : "[email] sending failed unexpectedly");
    throw new AppError(
      "The email could not be sent. Check the mail server settings and try again.",
      502,
      EMAIL_FAILED,
    );
  }
}
