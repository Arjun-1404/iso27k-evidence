// What the pretend server remembers. Everything lives in this one plain object, which is what makes the demo easy to
// reset (build a fresh one) and easy to keep for the length of a tab (it is plain JSON).

import type { BaseRole, ChoosableStorage, ControlStatus, FileSpec, IntegrityStatus, MfaPolicy, Permission, Role, ScanStatus } from "../api/types";
import type { TourStepId } from "./tour";

export interface DemoOrg {
  id: string;
  name: string;
  storageProvider: ChoosableStorage;
  mfaPolicy: MfaPolicy;
  /** Email domains the organisation's own staff may use. */
  allowedDomains: string[];
}

export interface DemoTenant {
  id: string;
  name: string;
  status: "active" | "archived";
  /** The client's top-level evidence folder; null until an admin creates it. */
  storageRootId: string | null;
  allowedDomains: string[];
}

export interface DemoMfa {
  secret: string;
  /** False while the person has been given a secret but has not yet proved their phone has it. */
  confirmed: boolean;
  /** Recovery codes not yet used, in their canonical form (no dashes). */
  recoveryCodes: string[];
  /** The last 30-second step accepted, so one code cannot be used twice. */
  lastStep: number | null;
  failedCodes: number;
  lockedUntil: number | null;
}

export interface DemoUser {
  id: string;
  email: string;
  fullName: string | null;
  role: Role;
  /** The firm's custom role (a built-in role with some abilities taken away), if the person has one. Its base role is `role`. */
  customRoleId?: string | null;
  status: "invited" | "active" | "disabled";
  tenantId: string | null;
  password: string;
  failedLogins: number;
  lockedUntil: number | null;
  /** Counts how many times this person's sessions have been ended (a password change, a two-step reset). A session
   *  carries the number it was issued under, and only the current one is still good. */
  sessionEpoch: number;
  mfa: DemoMfa | null;
}

export interface DemoAudit {
  id: string;
  tenantId: string;
  name: string;
  status: "in_progress" | "closed";
  templateVersion: string;
  createdAt: string;
  closedAt: string | null;
  closedBy: string | null;
}

export interface DemoControl {
  id: string;
  tenantId: string;
  auditId: string;
  kind: "clause" | "annex";
  section: string;
  controlRef: string;
  title: string;
  baseEvidence: string;
  baseFileSpec: FileSpec;
  evidenceOverride: string | null;
  fileSpecOverride: FileSpec | null;
  applicable: boolean;
  naJustification: string | null;
  status: ControlStatus;
  dueDate: string | null;
  lastRemindedAt: string | null;
  requirementChangedAt: string | null;
  sortOrder: number;
  folderId: string | null;
}

export interface DemoFile {
  id: string;
  controlId: string;
  tenantId: string;
  providerFileId: string;
  fileName: string;
  sizeBytes: number;
  mimeType: string;
  scanStatus: ScanStatus;
  integrityStatus: IntegrityStatus;
  uploadedAt: string;
  uploadedBy: string;
}

export interface DemoComment {
  id: string;
  controlId: string;
  tenantId: string;
  authorId: string;
  type: "comment" | "major" | "minor" | "ofi" | "observation";
  body: string;
  createdAt: string;
}

export interface DemoReview {
  id: string;
  controlId: string;
  tenantId: string;
  reviewerId: string;
  decision: "accept" | "reject" | "close";
  reason: string | null;
  createdAt: string;
}

/** A role of the firm's own: a built-in role with some abilities taken away (migration 016). */
export interface DemoCustomRole {
  id: string;
  name: string;
  description: string | null;
  baseRole: BaseRole;
  denied: Permission[];
}

export interface DemoLogEntry {
  seq: number;
  tenantId: string | null;
  actorId: string | null;
  action: string;
  entity: string | null;
  entityId: string | null;
  change: unknown;
  createdAt: string;
}

export interface DemoTemplate { id: string; framework: string; version: string; name: string; isPlatformDefault: boolean }

export interface DemoState {
  /** Bump when the shape changes, so a tab holding an older shape starts fresh instead of breaking. */
  version: 2;
  org: DemoOrg;
  /** Which storages the organisation has switched on (the demo only ever offers this server's disk). */
  storageConnections: { id: string; provider: ChoosableStorage; label: string; status: "active" | "revoked" | "error" }[];
  templates: DemoTemplate[];
  tenants: DemoTenant[];
  users: DemoUser[];
  customRoles: DemoCustomRole[];
  auditorAssignments: { userId: string; tenantId: string }[];
  audits: DemoAudit[];
  controls: DemoControl[];
  assignments: { controlId: string; userId: string }[];
  files: DemoFile[];
  comments: DemoComment[];
  reviews: DemoReview[];
  log: DemoLogEntry[];
  nextLogSeq: number;
  /** The guided tour's ticked steps. Absent until the first one: a tab holding an older copy of the state still loads. */
  tour?: { done: TourStepId[] };
}

export const STATE_VERSION = 2 as const;

/** Where the tab's copy is kept. Wrapped in try/catch everywhere: private windows and blocked site data make it throw. */
export const STORAGE_KEY = "iso27k-demo-state";

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function tabStore(): KeyValueStore | null {
  try { return typeof sessionStorage === "undefined" ? null : sessionStorage; } catch { return null; }
}

/** What an earlier visit in this tab left behind, or null (nothing there, from an older shape, or unreadable). */
export function loadState(store: KeyValueStore | null = tabStore()): DemoState | null {
  try {
    const raw = store?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DemoState> | null;
    if (!parsed || parsed.version !== STATE_VERSION || !Array.isArray(parsed.controls) || !Array.isArray(parsed.users)) return null;
    return parsed as DemoState;
  } catch {
    return null;
  }
}

/** Keeps a copy for the rest of this tab's life. Failing to is fine: the demo then simply starts fresh on reload. */
export function saveState(state: DemoState, store: KeyValueStore | null = tabStore()): void {
  try { store?.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* not kept; nothing else depends on it */ }
}

export function forgetState(store: KeyValueStore | null = tabStore()): void {
  try { store?.removeItem(STORAGE_KEY); } catch { /* nothing to forget */ }
}
