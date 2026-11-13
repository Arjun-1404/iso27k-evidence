/**
 * Turns the short error codes the server puts in `?error=` after a Google Drive connection attempt into
 * a sentence a person can act on. Kept separate from the page so it is easy to test and to extend
 * (SharePoint will add its own codes here).
 */
const MESSAGES: Record<string, string> = {
  access_denied: "Google Drive wasn't connected because access was declined. Choose Connect Google Drive again and allow access.",
  invalid_or_expired_state: "That connection attempt expired or was already used. Choose Connect Google Drive to start again.",
  not_configured: "Google Drive isn't set up on this server yet. The owner of this installation can add the Google app details under Server settings.",
  OAUTH_NOT_CONFIGURED: "Google Drive isn't set up on this server yet. The owner of this installation can add the Google app details under Server settings.",
  missing_code_or_state: "Google sent back an incomplete response. Please try connecting again.",
  invalid_request: "Google sent back an incomplete response. Please try connecting again.",
  OAUTH_PROVIDER_UNAVAILABLE: "Google couldn't be reached, or didn't grant the access we need. Please try again in a moment.",
  OAUTH_INVALID_REQUEST: "Google rejected the connection request. Please try again.",
};

export function describeConnectError(code: string): string {
  // hasOwn, not a plain lookup: the code comes straight from the address bar, and a value like
  // "toString" or "constructor" would otherwise resolve to something inherited from Object.
  return Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : `Connecting Google Drive didn't work (${code}). Please try again.`;
}
