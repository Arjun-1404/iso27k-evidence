// Helpers for the demo's tests only (nothing in the app imports this file): a pretend server on a fixed clock, and a way
// to be signed in as one of its made-up people using the app's real ApiClient, so the tests exercise exactly the calls
// the screens make.

import { ApiClient } from "../api/client";
import type { AuditSummary, ControlSummary, Tenant } from "../api/types";
import { DemoBackend } from "./backend";
import { installDemoFetch } from "./install";
import { DEMO_PASSWORD } from "./accounts";

export const TEST_BASE_URL = "https://api.demo.invalid";
/** A Wednesday, so "due in 10 days" and "closed 150 days ago" are easy to reason about. */
export const FIXED_NOW = Date.parse("2026-06-10T09:00:00.000Z");

export interface Kit {
  backend: DemoBackend;
  clock: { now: number };
  /** Signs in as the person with this address and returns a client that carries their session. */
  as: (email: string, password?: string) => Promise<ApiClient>;
  /** A client with no session. */
  anonymous: () => ApiClient;
  stop: () => void;
}

export function makeKit(): Kit {
  const clock = { now: FIXED_NOW };
  let counter = 0;
  const backend = new DemoBackend({ now: () => clock.now, newId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`, store: null });
  const stop = installDemoFetch(backend, { baseUrl: TEST_BASE_URL });

  const anonymous = () => new ApiClient({ baseUrl: TEST_BASE_URL, getToken: async () => null });

  async function as(email: string, password: string = DEMO_PASSWORD): Promise<ApiClient> {
    const res = await fetch(`${TEST_BASE_URL}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
    const data = await res.json();
    if (!res.ok) throw new Error(`login failed for ${email}: ${JSON.stringify(data)}`);
    if (data.mfaRequired) throw new Error(`login for ${email} needs a second step`);
    return new ApiClient({ baseUrl: TEST_BASE_URL, getToken: async () => data.token });
  }
  return { backend, clock, as, anonymous, stop };
}

/** The made-up people, by the name a test would use for them. */
export const PEOPLE = {
  aoife: "aoife.brennan@harbourview.example", // organisation admin
  declan: "declan.walsh@harbourview.example", // lead auditor
  maeve: "maeve.okafor@harbourview.example", // auditor
  ronan: "ronan.hayes@harbourview.example", // read-only auditor
  priya: "priya.shah@brightwave.example", // Brightwave's lead
  tom: "tom.byrne@brightwave.example", // Brightwave contributor
  lena: "lena.fischer@brightwave.example", // Brightwave contributor
  sam: "sam.ito@brightwave.example", // Brightwave viewer
  colm: "colm.dunne@corran.example", // Corran's lead
  ines: "ines.rocha@corran.example", // Corran contributor
} as const;

export async function tenantNamed(api: ApiClient, start: string): Promise<Tenant> {
  const t = (await api.listTenants()).find((x) => x.name.startsWith(start));
  if (!t) throw new Error(`no client starting "${start}" is visible`);
  return t;
}

export async function auditOf(api: ApiClient, tenantStart: string, which: "open" | "closed"): Promise<AuditSummary> {
  const t = await tenantNamed(api, tenantStart);
  const a = (await api.listTenantAudits(t.id)).find((x) => (which === "closed") === (x.status === "closed"));
  if (!a) throw new Error(`${tenantStart} has no ${which} audit visible`);
  return a;
}

export async function control(api: ApiClient, auditId: string, ref: string): Promise<ControlSummary> {
  const c = (await api.listControls(auditId)).find((x) => x.controlRef === ref);
  if (!c) throw new Error(`no control ${ref} visible in that audit`);
  return c;
}

/** Runs a call that must be refused and returns how it was refused. */
export async function refusal(call: Promise<unknown>): Promise<{ status: number; code: string; message: string }> {
  try {
    await call;
  } catch (e) {
    const err = e as { status?: number; code?: string; message?: string };
    if (typeof err.status === "number") return { status: err.status, code: err.code ?? "", message: err.message ?? "" };
    throw e;
  }
  throw new Error("expected the call to be refused, but it succeeded");
}

/** A small file the upload rules accept. */
export function pdfFile(name = "evidence.pdf", size = 2048): File {
  return new File([new Uint8Array(size).fill(37)], name, { type: "application/pdf" });
}
