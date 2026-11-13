import { StorageError, StorageAuthRevokedError } from "./types.ts";
import type { Fetcher } from "./googleDrive.ts";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Must exactly match a redirect URI registered for this client in Google Cloud Console. */
  redirectUri: string;
}

export interface RefreshedAccessToken {
  accessToken: string;
  expiresInSeconds: number;
}

export interface ExchangedTokens {
  refreshToken: string;
  accessToken: string;
  expiresInSeconds: number;
}

/** What the rest of the app needs from the Google OAuth client. The live wrapper (settings/live.ts) implements it too,
 *  which is why building the URL may be asynchronous. */
export interface GoogleOAuth {
  buildAuthUrl(state: string): string | Promise<string>;
  exchangeCode(code: string): Promise<ExchangedTokens>;
  refreshAccessToken(refreshToken: string): Promise<RefreshedAccessToken>;
}

/**
 * The OAuth "Connect Google Drive" handshake: build the URL the browser is sent to, then exchange the
 * authorization code Google redirects back with for a refresh token. Talks to real Google endpoints
 * via an injectable fetcher, the same pattern GoogleDriveProvider uses — tested against a fake that
 * speaks Google's real request/response shapes (storage/fakeGoogleOAuthApi.ts), not against the live
 * network this sandbox can't reach.
 */
export class GoogleOAuthClient implements GoogleOAuth {
  private config: GoogleOAuthConfig;
  private fetcher: Fetcher;

  constructor(config: GoogleOAuthConfig, fetcher: Fetcher = fetch) {
    this.config = config;
    this.fetcher = fetcher;
  }

  /** The URL to send the browser to. `state` is this app's own CSRF token (see oauth_states) —
   *  Google returns it unchanged in the callback, it isn't interpreted by Google at all. */
  buildAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: "code",
      scope: DRIVE_FILE_SCOPE,
      access_type: "offline", // required to get a refresh token back, not just a short-lived access token
      prompt: "consent", // forces a refresh token even on a repeat connection (Google otherwise omits it)
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<ExchangedTokens> {
    const res = await this.fetcher(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uri: this.config.redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new StorageError(`Google OAuth token exchange failed (${res.status}): ${body.slice(0, 300)}`, "INVALID_REQUEST", false);
    }
    const data = (await res.json()) as { refresh_token?: string; access_token: string; expires_in: number };
    if (!data.refresh_token) {
      // Google omits this when the user has already granted this app offline access and `prompt:
      // consent` wasn't honoured for some reason — treat it as a retryable failure (prompt again).
      throw new StorageError("Google did not return a refresh token. Please try connecting again.", "PROVIDER_UNAVAILABLE", true);
    }
    return { refreshToken: data.refresh_token, accessToken: data.access_token, expiresInSeconds: data.expires_in };
  }

  /**
   * Trades the long-lived refresh token for a short-lived access token (about an hour). Called whenever
   * the cached access token is missing or close to expiry — see AccessTokenCache.
   *
   * Google answers `invalid_grant` when the refresh token is no longer valid: the user revoked this
   * app's access, the account was deleted, or (for apps still in "Testing") the token aged out. No
   * retry can fix that, so it is surfaced as StorageAuthRevokedError — the signal to mark the
   * connection revoked and ask an org admin to reconnect — rather than as a generic failure.
   */
  async refreshAccessToken(refreshToken: string): Promise<RefreshedAccessToken> {
    let res: Response;
    try {
      res = await this.fetcher(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          refresh_token: refreshToken,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          grant_type: "refresh_token",
        }).toString(),
      });
    } catch (e) {
      throw new StorageError(`Could not reach Google to refresh access: ${(e as Error).message}`, "PROVIDER_UNAVAILABLE", true, { cause: e });
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let errorCode = "";
      try { errorCode = (JSON.parse(text) as { error?: string }).error ?? ""; } catch { /* not JSON */ }
      if (errorCode === "invalid_grant") {
        throw new StorageAuthRevokedError("Google rejected the stored credentials (access was revoked or has expired).");
      }
      const transient = res.status === 429 || res.status >= 500;
      throw new StorageError(`Google token refresh failed (${res.status}): ${text.slice(0, 300)}`, transient ? "PROVIDER_UNAVAILABLE" : "INVALID_REQUEST", transient);
    }

    const data = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
    if (!data?.access_token || typeof data.expires_in !== "number") {
      throw new StorageError("Google returned an unexpected token response.", "PROVIDER_UNAVAILABLE", true);
    }
    return { accessToken: data.access_token, expiresInSeconds: data.expires_in };
  }
}
