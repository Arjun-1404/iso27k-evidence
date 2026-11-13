import type { SessionResult } from "../api/types";

export interface AuthUser {
  userId: string;
  email: string;
  name: string;
  role: string;
  /** Present only for tenant-side users — their own tenant. Auditor-side users pick a tenant to view
   *  via the tenant selector instead (see api/TenantProvider.tsx). */
  tenantId?: string;
}

/**
 * Abstracts "how do we sign in and get a token". BuiltInAuthClient (builtInAuthClient.ts) is the real,
 * fully-tested default — it talks to the backend's own POST /auth/login, which needs no external
 * network access, so unlike an OIDC flow it's genuinely exercised end to end, not just stubbed.
 * Auth0AuthClient below is the optional alternative for an external identity provider; that one needs
 * live network access to build and test for real, so it stays a documented TODO. FakeAuthClient is
 * what tests use instead of either — "login" with any pre-registered email, no backend call at all.
 */
export interface AuthClient {
  getUser(): AuthUser | null;
  getToken(): Promise<string | null>;
  /** Checks the password. "signed-in" means done; "mfa-required" means the account has two-step sign-in on and
   *  the person is NOT signed in yet: ask for a code and call completeMfa. */
  login(email: string, password: string): Promise<LoginOutcome>;
  /** The second sign-in step: the code from the authenticator app, or a recovery code. */
  completeMfa(code: string): Promise<void>;
  /** Forgets a half-finished sign-in (the person went back to change the account). */
  cancelMfa(): void;
  /** Swaps the session token for a fresh one for the SAME person (after a password change ended the old one).
   *  Doesn't change who is signed in or notify listeners. */
  replaceSession(result: SessionResult): void;
  logout(): void;
  subscribe(fn: (user: AuthUser | null) => void): () => void;
}

export type LoginOutcome = "signed-in" | "mfa-required";

type Listener = (user: AuthUser | null) => void;

/** A working auth client for tests and quick demos with no backend at all: "login" with any
 *  pre-registered email, password ignored. Mirrors the backend's FakeTokenVerifier. */
export class FakeAuthClient implements AuthClient {
  private user: AuthUser | null = null;
  private listeners = new Set<Listener>();
  private directory: Record<string, AuthUser>;

  constructor(directory: Record<string, AuthUser> = {}) {
    this.directory = directory;
  }

  /** Registers a user the fake login screen can pick from (dev/demo convenience only). */
  registerUser(user: AuthUser) {
    this.directory[user.email] = user;
  }

  getUser() { return this.user; }
  async getToken() { return this.user ? `fake.${this.user.userId}` : null; }

  async login(email: string): Promise<LoginOutcome> {
    const user = this.directory[email];
    if (!user) throw new Error(`No fake user registered for ${email}`);
    this.user = user;
    this.listeners.forEach((fn) => fn(this.user));
    return "signed-in";
  }

  async completeMfa(): Promise<void> { throw new Error("FakeAuthClient has no two-step sign-in"); }
  cancelMfa() {}
  replaceSession() {}

  logout() {
    this.user = null;
    this.listeners.forEach((fn) => fn(null));
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

// TODO(production): implement AuthClient against Auth0 (redirect login, PKCE, token refresh, JWKS-
// verified session). Needs live network access to the identity provider to build and test for real.
// Swap this in wherever BuiltInAuthClient is constructed (see main.tsx) and nothing else changes.
export class Auth0AuthClient implements AuthClient {
  getUser(): AuthUser | null {
    throw new Error("Auth0AuthClient is not wired to a real identity provider yet");
  }
  async getToken(): Promise<string | null> {
    throw new Error("Auth0AuthClient is not wired to a real identity provider yet");
  }
  async login(): Promise<LoginOutcome> {
    throw new Error("Auth0AuthClient is not wired to a real identity provider yet");
  }
  async completeMfa(): Promise<void> {
    throw new Error("Auth0AuthClient is not wired to a real identity provider yet");
  }
  cancelMfa(): void {
    throw new Error("Auth0AuthClient is not wired to a real identity provider yet");
  }
  replaceSession(): void {
    throw new Error("Auth0AuthClient is not wired to a real identity provider yet");
  }
  logout(): void {
    throw new Error("Auth0AuthClient is not wired to a real identity provider yet");
  }
  subscribe(): () => void {
    throw new Error("Auth0AuthClient is not wired to a real identity provider yet");
  }
}
