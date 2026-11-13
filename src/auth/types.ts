export interface Session { userId: string }

/**
 * Verifies a bearer token and returns the session it belongs to, or null. Two real implementations:
 * JwtTokenVerifier (src/auth/jwt.ts) checks this project's own self-signed session tokens, issued by
 * the built-in email+password login — fully self-contained, so it's genuinely tested, not just stubbed.
 * Auth0TokenVerifier (src/auth/auth0.ts) is the optional alternative for an external OIDC provider;
 * that one verifies against the provider's JWKS over the network, which this sandbox can't reach, so
 * it stays a documented TODO. Tests use FakeTokenVerifier, which maps a plain string to a user id —
 * enough to test everything downstream of "we know who is calling."
 */
export interface TokenVerifier {
  verify(token: string): Promise<Session | null>;
}

export class FakeTokenVerifier implements TokenVerifier {
  private tokens = new Map<string, string>();
  issue(userId: string): string {
    const token = `fake.${userId}.${Math.random().toString(36).slice(2)}`;
    this.tokens.set(token, userId);
    return token;
  }
  async verify(token: string): Promise<Session | null> {
    const userId = this.tokens.get(token);
    return userId ? { userId } : null;
  }
}
