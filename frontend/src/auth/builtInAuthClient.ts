import type { AuthClient, AuthUser, LoginOutcome } from "./types";
import type { SessionResult } from "../api/types";
import { ApiError } from "../api/client";

const STORAGE_KEY = "evidence-portal-session";

interface StoredSession { token: string; user: AuthUser }

type Listener = (user: AuthUser | null) => void;

function readStoredSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

/**
 * Talks to the backend's own POST /auth/login — this project's built-in email+password login, not an
 * external identity provider, so it needs no network access beyond the backend itself and is fully
 * testable (see builtInAuthClient.test.ts). Deliberately does its own minimal fetch rather than
 * reusing the shared ApiClient: ApiClient's getToken callback reads from THIS class, so this class
 * depending back on an ApiClient instance would be circular.
 */
export class BuiltInAuthClient implements AuthClient {
  private apiBaseUrl: string;
  private session: StoredSession | null;
  private listeners = new Set<Listener>();
  /** The half-finished sign-in of an account with two-step sign-in on. Held in memory only — never written to
   *  storage — so a page reload simply starts again from the password. */
  private pending: { mfaToken: string; email: string } | null = null;

  constructor(apiBaseUrl: string) {
    this.apiBaseUrl = apiBaseUrl;
    this.session = readStoredSession();
  }

  getUser(): AuthUser | null {
    return this.session?.user ?? null;
  }

  async getToken(): Promise<string | null> {
    return this.session?.token ?? null;
  }

  private async post(path: string, body: unknown) {
    const res = await fetch(`${this.apiBaseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new ApiError(data?.error?.message ?? "Sign in failed. Please try again.", res.status, data?.error?.code ?? "UNKNOWN");
    }
    return data;
  }

  private startSession(data: { token: string; userId: string; role: string; tenantId?: string | null }, email: string) {
    // The sign-in response carries the account's identity, not a display name (full_name is a separate,
    // optional profile field the backend doesn't collect at invite time yet) — the email is a
    // reasonable, honest stand-in until that exists.
    const user: AuthUser = { userId: data.userId, email, name: email, role: data.role, tenantId: data.tenantId ?? undefined };
    this.session = { token: data.token, user };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.session));
    this.listeners.forEach((fn) => fn(user));
  }

  async login(email: string, password: string): Promise<LoginOutcome> {
    this.pending = null;
    const data = await this.post("/auth/login", { email, password });
    if (data.mfaRequired) {
      this.pending = { mfaToken: data.mfaToken, email };
      return "mfa-required";
    }
    this.startSession(data, email);
    return "signed-in";
  }

  async completeMfa(code: string): Promise<void> {
    if (!this.pending) throw new ApiError("Your sign-in has expired. Please enter your password again.", 401, "INVALID_MFA_TOKEN");
    const { mfaToken, email } = this.pending;
    try {
      this.startSession(await this.post("/auth/mfa/verify", { mfaToken, code }), email);
      this.pending = null;
    } catch (e) {
      // A wrong code can be retried; an expired or void sign-in cannot — start again from the password.
      if (e instanceof ApiError && e.code === "INVALID_MFA_TOKEN") this.pending = null;
      throw e;
    }
  }

  cancelMfa(): void {
    this.pending = null;
  }

  replaceSession(result: SessionResult): void {
    if (!this.session || this.session.user.userId !== result.userId) return; // only ever for the person already signed in
    this.session = { ...this.session, token: result.token };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.session));
  }

  logout(): void {
    this.pending = null;
    this.session = null;
    localStorage.removeItem(STORAGE_KEY);
    this.listeners.forEach((fn) => fn(null));
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
