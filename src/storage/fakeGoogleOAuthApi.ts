import type { Fetcher } from "./googleDrive.ts";

/**
 * A fetch-compatible stand-in for Google's OAuth token endpoint. Understands exactly the request
 * GoogleOAuthClient.exchangeCode makes, and can be told to simulate the specific failure modes worth
 * guarding against (a bad code, a missing refresh token).
 */
export class FakeGoogleOAuthApi {
  private validCodes = new Map<string, { refreshToken: string; accessToken: string; expiresIn: number }>();
  private omitRefreshTokenFor = new Set<string>();
  /** refresh token -> number of access tokens issued so far (so each refresh yields a distinct token). */
  private refreshTokens = new Map<string, number>();
  private revokedRefreshTokens = new Set<string>();
  private queuedRefreshFailures: { status: number; body: unknown }[] = [];
  private accessTokenLifetimeSeconds = 3600;
  calls: { url: string; body: string }[] = [];

  /** Registers a code this fake will accept, with the tokens it should hand back for it. */
  seedCode(code: string, tokens: { refreshToken: string; accessToken?: string; expiresIn?: number } = { refreshToken: `refresh-${code}` }) {
    this.validCodes.set(code, { refreshToken: tokens.refreshToken, accessToken: tokens.accessToken ?? `access-${code}`, expiresIn: tokens.expiresIn ?? 3600 });
    this.refreshTokens.set(tokens.refreshToken, 0);
  }

  /** Registers a refresh token directly, for tests that start from an already-connected org. */
  seedRefreshToken(refreshToken: string): void {
    this.refreshTokens.set(refreshToken, 0);
  }

  /** Simulates the user revoking this app's access: the next refresh answers invalid_grant, like Google. */
  revokeRefreshToken(refreshToken: string): void {
    this.revokedRefreshTokens.add(refreshToken);
  }

  /** Makes the next refresh request fail with the given HTTP status/body before behaving normally. */
  queueRefreshFailure(status: number, body: unknown = { error: "backend_error" }): void {
    this.queuedRefreshFailures.push({ status, body });
  }

  /** How long (seconds) an access token issued by a refresh claims to live. */
  setAccessTokenLifetime(seconds: number): void {
    this.accessTokenLifetimeSeconds = seconds;
  }

  /** Number of refresh-token grants this fake has served. */
  get refreshCount(): number {
    return this.calls.filter((c) => new URLSearchParams(c.body).get("grant_type") === "refresh_token").length;
  }

  /** Makes a seeded code succeed the exchange but omit the refresh token, as Google does when offline
   *  access was already granted and consent isn't re-prompted. */
  omitRefreshToken(code: string) {
    this.omitRefreshTokenFor.add(code);
  }

  fetcher: Fetcher = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const bodyText = typeof init?.body === "string" ? init.body : "";
    this.calls.push({ url, body: bodyText });

    if (!url.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ error: "unexpected_endpoint" }), { status: 500 });
    }
    const params = new URLSearchParams(bodyText);

    if (params.get("grant_type") === "refresh_token") return this.handleRefresh(params.get("refresh_token") ?? "");

    const code = params.get("code") ?? "";
    const tokens = this.validCodes.get(code);
    if (!tokens) {
      return new Response(JSON.stringify({ error: "invalid_grant", error_description: "Malformed auth code." }), { status: 400 });
    }
    const body: Record<string, unknown> = { access_token: tokens.accessToken, expires_in: tokens.expiresIn, token_type: "Bearer" };
    if (!this.omitRefreshTokenFor.has(code)) body.refresh_token = tokens.refreshToken;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };

  private handleRefresh(refreshToken: string): Response {
    const queued = this.queuedRefreshFailures.shift();
    if (queued) return new Response(JSON.stringify(queued.body), { status: queued.status });
    if (this.revokedRefreshTokens.has(refreshToken) || !this.refreshTokens.has(refreshToken)) {
      return new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }), { status: 400 });
    }
    const n = (this.refreshTokens.get(refreshToken) ?? 0) + 1;
    this.refreshTokens.set(refreshToken, n);
    // Per Google, a refresh response carries a new access token but NO new refresh token.
    return new Response(JSON.stringify({ access_token: `access-${refreshToken}-${n}`, expires_in: this.accessTokenLifetimeSeconds, token_type: "Bearer" }),
      { status: 200, headers: { "content-type": "application/json" } });
  }
}
