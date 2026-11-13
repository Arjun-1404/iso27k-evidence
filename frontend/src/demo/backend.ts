// The pretend server. It answers the same requests as the real API (see src/api/client.ts) with the same answers, from
// the sample world in state.ts, entirely inside the browser tab: nothing is sent anywhere and nothing outlives the tab.
//
// The rules it enforces (who may do what, which status changes are legal, when a cycle is read-only) are the ones the
// real server's database enforces; rules.ts holds the pure ones and the "RLS" helpers below hold the visibility ones.

import type { AuditSummary, ControlSummary, Role } from "../api/types";
import { fail, DemoHttpError, type DemoRequest, type DemoResponse, type RouteResult } from "./http";
import { DASHBOARD_ONLY_ROLES, OUTSTANDING, REMINDER_COOLDOWN_MS, isAuditorSide, statusTransitionOk } from "./rules";
import { buildSeed, seedIdGenerator } from "./seed";
import { forgetState, loadState, saveState, type DemoAudit, type DemoControl, type DemoState, type DemoTenant, type DemoUser, type KeyValueStore } from "./state";
import { authRoutes } from "./routesAuth";
import { controlRoutes } from "./routesControls";
import { peopleRoutes } from "./routesPeople";

export const AUDIT_CLOSED_MESSAGE = "This audit cycle is closed, so it can no longer be changed. A lead auditor or an organisation admin can reopen it.";

/** The things a request handler is given. */
export interface Ctx {
  api: DemoBackend;
  /** Who is asking. Always set for a route that needs a session. */
  user: DemoUser;
  params: Record<string, string>;
  req: DemoRequest;
}

export interface Route {
  method: string;
  /** Like "/audits/:auditId/controls". */
  path: string;
  /** True for the few things a signed-out visitor may call (sign-in, the signed upload link). */
  open?: boolean;
  /** Setting up two-step sign-in must stay possible for someone the organisation's policy has locked out of everything else. */
  mfaSetup?: boolean;
  handle: (ctx: Ctx) => Promise<RouteResult | undefined> | RouteResult | undefined;
}

export interface BackendOptions {
  /** The clock, in milliseconds. Tests pass their own. */
  now?: () => number;
  newId?: () => string;
  /** Where the tab's copy is kept; null keeps nothing. Defaults to sessionStorage. */
  store?: KeyValueStore | null;
  /** Start from this world instead of the sample one (or one left behind in the tab). */
  initial?: DemoState;
}

function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

interface CompiledRoute extends Route { regex: RegExp; keys: string[] }

function compile(route: Route): CompiledRoute {
  const keys: string[] = [];
  const pattern = route.path.replace(/:([A-Za-z]+)/g, (_m, key: string) => { keys.push(key); return "([^/]+)"; });
  return { ...route, regex: new RegExp(`^${pattern}$`), keys };
}

/** Roles whose members may change a control at all (001_core: audit_controls_update). Everyone else's attempt finds nothing. */
const CONTROL_WRITERS: readonly Role[] = ["org_admin", "lead_auditor", "auditor", "tenant_lead", "contributor"];

export class DemoBackend {
  state: DemoState;
  readonly now: () => number;
  readonly newId: () => string;
  private store: KeyValueStore | null | undefined;
  private seedIds: (() => string) | undefined;
  private routes: CompiledRoute[];
  /** Upload links handed out and the bytes received for them. Held in memory only: they never reach the saved copy. */
  readonly pendingUploads = new Map<string, { controlId: string; userId: string; fileName: string; mimeType: string; sizeBytes: number; providerFileId: string; expiresAt: number; received: boolean }>();
  readonly blobs = new Map<string, Blob>();

  constructor(opts: BackendOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.newId = opts.newId ?? randomId;
    this.store = opts.store;
    this.seedIds = opts.newId;
    this.state = opts.initial ?? (opts.store === null ? null : loadState(opts.store)) ?? buildSeed({ now: this.now(), newId: opts.newId ?? seedIdGenerator() });
    this.routes = [...authRoutes(), ...controlRoutes(), ...peopleRoutes()].map(compile);
  }

  /** Back to the sample world, as if the page had just been opened. */
  reset(): void {
    if (this.store !== null) forgetState(this.store);
    this.pendingUploads.clear();
    this.blobs.clear();
    this.state = buildSeed({ now: this.now(), newId: this.seedIds ?? seedIdGenerator() });
    this.persist();
  }

  persist(): void {
    if (this.store !== null) saveState(this.state, this.store);
  }

  // ---- time -------------------------------------------------------------------------------------------------------
  iso(): string { return new Date(this.now()).toISOString(); }
  today(): string { return this.iso().slice(0, 10); }

  // ---- finding things ---------------------------------------------------------------------------------------------
  user(id: string): DemoUser | undefined { return this.state.users.find((u) => u.id === id); }
  userByEmail(email: string): DemoUser | undefined { const e = email.trim().toLowerCase(); return this.state.users.find((u) => u.email.toLowerCase() === e); }
  tenant(id: string): DemoTenant | undefined { return this.state.tenants.find((t) => t.id === id); }
  audit(id: string): DemoAudit | undefined { return this.state.audits.find((a) => a.id === id); }
  control(id: string): DemoControl | undefined { return this.state.controls.find((c) => c.id === id); }
  displayName(user: DemoUser): string { return user.fullName?.trim() || user.email; }

  // ---- who may see what (the row-level security of 001_core, in plain code) -------------------------------------------
  /** A client's own people see their client; an org admin sees every client; other auditor-side people see the ones assigned to them. */
  canSeeTenant(user: DemoUser, tenantId: string): boolean {
    if (!this.tenant(tenantId)) return false;
    if (user.tenantId) return user.tenantId === tenantId;
    return user.role === "org_admin" || this.state.auditorAssignments.some((a) => a.userId === user.id && a.tenantId === tenantId);
  }

  tenantActive(user: DemoUser, tenantId: string): boolean {
    return this.canSeeTenant(user, tenantId) && this.tenant(tenantId)!.status === "active";
  }

  /** Dashboard-only roles never read a control; a contributor reads only the ones assigned to them. */
  canReadControl(user: DemoUser, control: DemoControl): boolean {
    if (!this.canSeeTenant(user, control.tenantId)) return false;
    if (DASHBOARD_ONLY_ROLES.includes(user.role)) return false;
    return user.role !== "contributor" || this.state.assignments.some((a) => a.controlId === control.id && a.userId === user.id);
  }

  canReadAudit(user: DemoUser, audit: DemoAudit): boolean {
    return this.canSeeTenant(user, audit.tenantId) && !DASHBOARD_ONLY_ROLES.includes(user.role);
  }

  readableControl(user: DemoUser, id: string): DemoControl | undefined {
    const c = this.control(id);
    return c && this.canReadControl(user, c) ? c : undefined;
  }

  requireControl(user: DemoUser, id: string, message = "Control not found or not visible to you."): DemoControl {
    return this.readableControl(user, id) ?? fail(404, "NOT_FOUND", message);
  }

  isClosed(auditId: string): boolean { return this.audit(auditId)?.status === "closed"; }

  /** The refusal a closed cycle gives to anything that would change it (migration 014). */
  refuseIfClosed(auditId: string): void {
    if (this.isClosed(auditId)) fail(409, "AUDIT_CLOSED", AUDIT_CLOSED_MESSAGE);
  }

  /** Checks, with plain-language reasons, that `targetId` may be given controls of `tenantId` (migration 013 enforces the same). */
  requireAssignable(caller: DemoUser, targetId: string, tenantId: string): void {
    const t = this.user(targetId);
    // A person the caller can't see is reported as not found, the same as one that doesn't exist.
    const visible = t ? (t.tenantId ? this.canSeeTenant(caller, t.tenantId) : isAuditorSide(caller.role)) : false;
    if (!t || !visible) fail(404, "NOT_FOUND", "That person was not found.");
    if (t!.tenantId !== tenantId) fail(400, "ASSIGNEE_WRONG_TENANT", "That person belongs to a different client.");
    if (t!.role !== "contributor" && t!.role !== "tenant_lead") fail(400, "ASSIGNEE_ROLE", "Only a client's contributors and leads can be given controls.");
    if (t!.status === "disabled") fail(400, "ASSIGNEE_DISABLED", "That person's account is switched off.");
  }

  // ---- the audit log ----------------------------------------------------------------------------------------------------
  log(actor: DemoUser | null, action: string, tenantId: string | null, entity: string | null, entityId: string | null, change?: unknown): void {
    this.state.log.push({ seq: this.state.nextLogSeq++, tenantId, actorId: actor?.id ?? null, action, entity, entityId, change: change ?? null, createdAt: this.iso() });
  }

  // ---- shapes the API sends ------------------------------------------------------------------------------------------------
  toAuditSummary(viewer: DemoUser, a: DemoAudit): AuditSummary {
    const closer = a.closedBy ? this.user(a.closedBy) : undefined;
    return {
      id: a.id, name: a.name, status: a.status, templateVersion: a.templateVersion, createdAt: a.createdAt, closedAt: a.closedAt,
      // People on a client's side can't see the audit firm's staff, so they are not told who closed a cycle.
      closedBy: closer && isAuditorSide(viewer.role) ? this.displayName(closer) : null,
    };
  }

  toControlSummary(c: DemoControl): ControlSummary {
    return {
      id: c.id, kind: c.kind, section: c.section, controlRef: c.controlRef, title: c.title,
      effectiveEvidence: c.evidenceOverride ?? c.baseEvidence,
      effectiveFileSpec: c.fileSpecOverride ?? c.baseFileSpec,
      isOverridden: c.evidenceOverride !== null || c.fileSpecOverride !== null,
      applicable: c.applicable, naJustification: c.naJustification, status: c.status, dueDate: c.dueDate,
      requirementChangedAt: c.requirementChangedAt,
      fileCount: this.state.files.filter((f) => f.controlId === c.id).length,
    };
  }

  // ---- changing a control (001_core: audit_controls_update policy + audit_controls_guard trigger + checks) ------------------
  /**
   * Applies `patch` to a control the way the database would, in the same order: first "can this person change it at all"
   * (otherwise it simply isn't there for them), then the closed-cycle lock, then the role and status rules, then the
   * table's own checks. Nothing is changed unless every rule passes.
   */
  updateControl(user: DemoUser, controlId: string, patch: Partial<DemoControl>, action: string, change: unknown): { id: string } {
    const c = this.readableControl(user, controlId);
    if (!c || !CONTROL_WRITERS.includes(user.role) || !this.tenantActive(user, c.tenantId)) fail(404, "NOT_FOUND", "Control not found or not visible to you.");
    this.refuseIfClosed(c.auditId);

    const next: DemoControl = { ...c, ...patch };
    const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const changed = (k: keyof DemoControl) => !same(c[k], next[k]);

    const tenantSide = user.role === "tenant_lead" || user.role === "contributor";
    const settings: (keyof DemoControl)[] = ["applicable", "naJustification", "evidenceOverride", "fileSpecOverride", "dueDate"];
    if (tenantSide && [...settings, "lastRemindedAt" as const].some(changed)) fail(403, "FORBIDDEN_COLUMN", "tenant users can only submit evidence");
    if (user.role === "auditor" && settings.some(changed)) fail(403, "FORBIDDEN_COLUMN", "auditors cannot change applicability, requirements or due dates");

    if (changed("status")) {
      if (!(c.applicable && next.applicable)) fail(409, "NOT_APPLICABLE", "status of a not-applicable control cannot change");
      if (!statusTransitionOk(c.status, next.status, user.role)) fail(409, "INVALID_TRANSITION", `${c.status} to ${next.status} is not allowed for role ${user.role}`);
      if ((next.status === "submitted" || next.status === "accepted") && !this.state.files.some((f) => f.controlId === c.id)) {
        fail(409, "EVIDENCE_REQUIRED", "no evidence file is recorded for this control");
      }
    }

    if (changed("lastRemindedAt")) {
      if (!OUTSTANDING.includes(c.status)) fail(409, "REMINDER_NOT_ALLOWED", "evidence is not outstanding");
      if (c.lastRemindedAt && Date.parse(c.lastRemindedAt) > this.now() - REMINDER_COOLDOWN_MS) {
        fail(429, "REMINDER_RATE_LIMIT", "a reminder was already sent in the last 24 hours");
      }
      next.lastRemindedAt = this.iso();
    }

    // The table's own checks come after the triggers.
    if (!next.applicable && next.kind === "clause") fail(400, "clauses_always_applicable", "Clauses 4 to 10 are mandatory and cannot be marked not applicable.");
    if (!next.applicable && (next.naJustification ?? "").trim().length < 3) fail(400, "na_needs_justification", "A justification is required when marking a control not applicable.");

    if ((changed("evidenceOverride") || changed("fileSpecOverride")) && (c.status === "submitted" || c.status === "under_review" || c.status === "accepted")) {
      next.requirementChangedAt = this.iso();
    }

    Object.assign(c, next);
    this.log(user, action, c.tenantId, "audit_control", c.id, change);
    return { id: c.id };
  }

  // ---- sessions ----------------------------------------------------------------------------------------------------------
  /** A session carries the person and the number of times their sessions had been ended when it was issued. */
  sessionToken(user: DemoUser): string { return `demo.${user.id}.${user.sessionEpoch}`; }

  /** The person a session token belongs to, if it is still good: they exist, are active, and have not been signed out since. */
  authenticate(token: string | null): DemoUser | null {
    const m = token?.match(/^demo\.([^.]+)\.(\d+)$/);
    const user = m ? this.user(m[1]) : undefined;
    return user && user.status === "active" && user.sessionEpoch === Number(m![2]) ? user : null;
  }

  /** Has the organisation's two-step policy (001–011: mfa_requirement) made it compulsory for this person? */
  mfaRequired(user: DemoUser): boolean {
    const policy = this.state.org.mfaPolicy;
    return user.status === "active" && user.password !== "" && (policy === "everyone" || (policy === "staff" && user.tenantId === null));
  }

  mfaEnabled(user: DemoUser): boolean { return user.mfa?.confirmed === true; }

  // ---- answering a request -----------------------------------------------------------------------------------------------------
  async handle(req: DemoRequest): Promise<DemoResponse> {
    try {
      const response = await this.dispatch(req);
      if (req.method !== "GET") this.persist();
      return response;
    } catch (e) {
      if (req.method !== "GET") this.persist(); // a failed sign-in still counts toward the lock-out
      if (e instanceof DemoHttpError) return { status: e.status, json: { error: { code: e.code, message: e.message } } };
      console.error("[demo] unexpected error", e);
      return { status: 500, json: { error: { code: "INTERNAL", message: "Unexpected error." } } };
    }
  }

  private async dispatch(req: DemoRequest): Promise<DemoResponse> {
    const method = req.method.toUpperCase();
    let matched: { route: CompiledRoute; params: Record<string, string> } | null = null;
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.regex.exec(req.path);
      if (m) {
        try { matched = { route, params: Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) }; }
        catch { fail(400, "VALIDATION", "That address is not valid."); }
        break;
      }
    }
    if (!matched) fail(404, "NOT_FOUND", "There is no such page in the API.");
    const { route, params } = matched;

    let user: DemoUser | null = null;
    if (!route.open) {
      user = this.authenticate(req.token);
      if (!user) fail(401, "UNAUTHENTICATED", req.token ? "Invalid or expired session." : "Missing or malformed Authorization header.");
      if (!route.mfaSetup && this.mfaRequired(user) && !this.mfaEnabled(user)) {
        fail(403, "MFA_SETUP_REQUIRED", "Your organisation requires two-step sign-in. Set it up in Security settings to carry on.");
      }
    }

    const result = await route.handle({ api: this, user: user as DemoUser, params, req });
    if (!result) return { status: 204 };
    return { status: result.status ?? 200, json: result.json, blob: result.blob, headers: result.headers };
  }
}
