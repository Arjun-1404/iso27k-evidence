// The sample world the demo starts in: a made-up audit firm with two clients, an audit cycle part-way through, one
// already closed, and a few dozen files and comments, so every screen has something real-looking to show.
//
// Everything is fictional (see accounts.ts). Dates are worked out from "now", so there are always some overdue and
// some upcoming items. The mix of statuses comes from a fixed random seed, so it is the same every time.

import template from "./iso27001-2022.json";
import { DEMO_ORG_NAME, DEMO_PASSWORD } from "./accounts";
import { STATE_VERSION, type DemoAudit, type DemoComment, type DemoControl, type DemoFile, type DemoLogEntry, type DemoReview, type DemoState, type DemoTenant, type DemoUser } from "./state";
import type { ControlStatus, Role } from "../api/types";

export interface SeedOptions { now: number; newId: () => string }

interface TemplateControl { kind: "clause" | "annex"; section: string; control_ref: string; title: string; default_evidence: string; sort_order: number }
const TEMPLATE_CONTROLS = template.controls as TemplateControl[];

const DAY = 86_400_000;

/**
 * Ids for the sample world: the same every time, so a second tab (or a reload after the saved copy is gone) finds the same
 * people under the same ids, and a sign-in kept by the browser still belongs to someone. Things made while using the demo
 * get random ids.
 */
export function seedIdGenerator(): () => string {
  let n = 0;
  return () => { n += 1; return `5eed0000-0000-4000-8000-${String(n).padStart(12, "0")}`; };
}

/** A small, fixed-seed random number generator (mulberry32): the sample data is the same every time. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick one of the entries, each with a chance proportional to its weight. */
function weighted<T>(rand: () => number, options: [T, number][]): T {
  const total = options.reduce((sum, [, w]) => sum + w, 0);
  let roll = rand() * total;
  for (const [value, w] of options) { roll -= w; if (roll < 0) return value; }
  return options[options.length - 1][0];
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);

/** File names for the controls where a real company would have an obvious document; everything else gets one from its title. */
const NICE_FILES: Record<string, string[]> = {
  "4.1": ["context-of-the-organisation-2026.pdf"],
  "4.3": ["isms-scope-statement-v2.pdf"],
  "5.2": ["information-security-policy-v3.2.pdf"],
  "6.1.2": ["risk-assessment-method.pdf", "risk-register-2026.csv"],
  "6.1.3": ["statement-of-applicability-v4.pdf"],
  "9.2": ["internal-audit-report-2026.pdf"],
  "9.3": ["management-review-minutes-2026-06.pdf"],
  "A.5.1": ["information-security-policy-v3.2.pdf"],
  "A.5.15": ["access-control-policy.pdf"],
  "A.6.1": ["screening-procedure.pdf"],
  "A.6.3": ["awareness-training-attendance-q1.csv"],
  "A.8.8": ["vulnerability-scan-summary-2026-09.pdf", "patch-compliance-report.csv"],
  "A.8.13": ["backup-restore-test-2026.pdf"],
  "A.8.15": ["logging-and-monitoring-standard.pdf"],
  "A.8.24": ["cryptography-standard.pdf"],
};

export const mimeTypeFor = (fileName: string): string => {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".txt")) return "text/plain";
  return "application/octet-stream";
};

/** A new audit cycle's controls: one copy of every control in the template, nothing started (001_core: create_audit). */
export function controlsFromTemplate(tenantId: string, auditId: string, newId: () => string): DemoControl[] {
  return TEMPLATE_CONTROLS.map((c): DemoControl => ({
    id: newId(), tenantId, auditId, kind: c.kind, section: c.section, controlRef: c.control_ref, title: c.title,
    baseEvidence: c.default_evidence, baseFileSpec: {}, evidenceOverride: null, fileSpecOverride: null,
    applicable: true, naJustification: null, status: "not_started", dueDate: null, lastRemindedAt: null, requirementChangedAt: null,
    sortOrder: c.sort_order, folderId: null,
  }));
}

/** Controls a fully remote company would mark not applicable (and say why). */
const NOT_APPLICABLE = new Set(["A.7.1", "A.7.2", "A.7.3", "A.7.5", "A.7.12"]);
const NA_REASON = "Brightwave is fully remote: all staff work from home and the one meeting room is rented by the hour from a serviced office, which is covered by the landlord's own certification.";

export function buildSeed({ now, newId }: SeedOptions): DemoState {
  const rand = mulberry32(27001);
  const ago = (days: number) => new Date(now - days * DAY).toISOString();
  const dateOnly = (offsetDays: number) => new Date(now + offsetDays * DAY).toISOString().slice(0, 10);

  const org = { id: newId(), name: DEMO_ORG_NAME, storageProvider: "local" as const, mfaPolicy: "off" as const, allowedDomains: ["harbourview.example"] };
  const templateId = newId();

  const users: DemoUser[] = [];
  const tenants: DemoTenant[] = [];
  const audits: DemoAudit[] = [];
  const controls: DemoControl[] = [];
  const files: DemoFile[] = [];
  const comments: DemoComment[] = [];
  const reviews: DemoReview[] = [];
  const assignments: { controlId: string; userId: string }[] = [];
  const auditorAssignments: { userId: string; tenantId: string }[] = [];
  const logs: (Omit<DemoLogEntry, "seq"> & { at: number })[] = [];

  const log = (daysAgo: number, actorId: string | null, action: string, tenantId: string | null, entity: string | null, entityId: string | null, change?: unknown) =>
    logs.push({ at: now - daysAgo * DAY, actorId, action, tenantId, entity, entityId, change: change ?? null, createdAt: ago(daysAgo) });

  // ---- people ---------------------------------------------------------------------------------------------------
  const person = (email: string, fullName: string, role: Role, tenantId: string | null, status: DemoUser["status"] = "active"): DemoUser => {
    const user: DemoUser = {
      id: newId(), email, fullName, role, status, tenantId, password: status === "invited" ? "" : DEMO_PASSWORD,
      failedLogins: 0, lockedUntil: null, sessionEpoch: 0, mfa: null,
    };
    users.push(user);
    return user;
  };

  const aoife = person("aoife.brennan@harbourview.example", "Aoife Brennan", "org_admin", null);
  const declan = person("declan.walsh@harbourview.example", "Declan Walsh", "lead_auditor", null);
  const maeve = person("maeve.okafor@harbourview.example", "Maeve Okafor", "auditor", null);
  const ronan = person("ronan.hayes@harbourview.example", "Ronan Hayes", "read_only", null);
  const niamh = person("niamh.kelly@harbourview.example", "Niamh Kelly", "auditor", null, "invited");

  const tenant = (name: string, domain: string, status: DemoTenant["status"], withFolder: boolean): DemoTenant => {
    const t: DemoTenant = { id: newId(), name, status, storageRootId: withFolder ? `demo-disk:${slug(name)}` : null, allowedDomains: [domain] };
    tenants.push(t);
    return t;
  };
  const brightwave = tenant("Brightwave Software Ltd", "brightwave.example", "active", true);
  const corran = tenant("Corran Logistics", "corran.example", "active", true);
  const oldMill = tenant("Old Mill Foods", "oldmill.example", "archived", false);

  const priya = person("priya.shah@brightwave.example", "Priya Shah", "tenant_lead", brightwave.id);
  const tom = person("tom.byrne@brightwave.example", "Tom Byrne", "contributor", brightwave.id);
  const lena = person("lena.fischer@brightwave.example", "Lena Fischer", "contributor", brightwave.id);
  const sam = person("sam.ito@brightwave.example", "Sam Ito", "viewer", brightwave.id);
  const colm = person("colm.dunne@corran.example", "Colm Dunne", "tenant_lead", corran.id);
  const ines = person("ines.rocha@corran.example", "Ines Rocha", "contributor", corran.id);

  for (const [pair, days] of [[[declan, brightwave], 118], [[declan, corran], 40], [[maeve, brightwave], 118], [[ronan, brightwave], 100]] as const) {
    auditorAssignments.push({ userId: pair[0].id, tenantId: pair[1].id });
    log(days, aoife.id, "auditor.assigned", pair[1].id, "user", pair[0].id);
  }

  log(130, aoife.id, "tenant.created", brightwave.id, "tenant", brightwave.id, { name: brightwave.name });
  log(129, aoife.id, "tenant.storage_root_created", brightwave.id, "tenant", brightwave.id);
  log(45, aoife.id, "tenant.created", corran.id, "tenant", corran.id, { name: corran.name });
  log(44, aoife.id, "tenant.storage_root_created", corran.id, "tenant", corran.id);
  log(300, aoife.id, "tenant.created", oldMill.id, "tenant", oldMill.id, { name: oldMill.name });
  log(20, aoife.id, "tenant.archived", oldMill.id, "tenant", oldMill.id);
  log(131, aoife.id, "org.storage_connected", null, "storage_connection", org.id, { provider: "local" });
  for (const [u, days] of [[declan, 140], [maeve, 125], [ronan, 100], [niamh, 3], [priya, 128], [tom, 126], [lena, 126], [sam, 120], [colm, 44], [ines, 43]] as const) {
    log(days, aoife.id, "user.invited", u.tenantId, "user", u.id, { role: u.role, side: u.tenantId ? "tenant" : "auditor" });
  }

  // ---- an audit cycle: its controls start as copies of the template ------------------------------------------------
  const startAudit = (t: DemoTenant, name: string, createdDaysAgo: number, createdBy: DemoUser): { audit: DemoAudit; list: DemoControl[] } => {
    const audit: DemoAudit = { id: newId(), tenantId: t.id, name, status: "in_progress", templateVersion: template.version, createdAt: ago(createdDaysAgo), closedAt: null, closedBy: null };
    audits.push(audit);
    log(createdDaysAgo, createdBy.id, "audit.created", t.id, "audit", audit.id, { name });
    const list = controlsFromTemplate(t.id, audit.id, newId);
    controls.push(...list);
    return { audit, list };
  };

  const fileNameFor = (c: DemoControl, i: number) => NICE_FILES[c.controlRef]?.[i] ?? `${slug(c.title)}${i > 0 ? `-${i + 1}` : ""}.pdf`;

  /** Records the files, and the log lines that go with them. `daysAgo` is when the first one went up. */
  const addFiles = (c: DemoControl, count: number, uploader: DemoUser, daysAgo: number, scan: DemoFile["scanStatus"] = "clean") => {
    c.folderId = c.folderId ?? `demo-disk:${slug(c.controlRef)}-${c.id.slice(0, 8)}`;
    for (let i = 0; i < count; i++) {
      const fileName = fileNameFor(c, i);
      const f: DemoFile = {
        id: newId(), controlId: c.id, tenantId: c.tenantId, providerFileId: `demo-disk:${c.id.slice(0, 8)}-${i}`, fileName,
        sizeBytes: 30_000 + Math.floor(rand() * 1_100_000), mimeType: mimeTypeFor(fileName), scanStatus: scan, integrityStatus: "unchecked",
        uploadedAt: ago(daysAgo - i * 0.01), uploadedBy: uploader.id,
      };
      files.push(f);
      log(daysAgo - i * 0.01, uploader.id, "evidence.uploaded", c.tenantId, "audit_control", c.id, { fileName, scanStatus: scan });
    }
  };

  const comment = (c: DemoControl, by: DemoUser, type: DemoComment["type"], body: string, daysAgo: number) => {
    comments.push({ id: newId(), controlId: c.id, tenantId: c.tenantId, authorId: by.id, type, body, createdAt: ago(daysAgo) });
    log(daysAgo, by.id, "control.comment", c.tenantId, "audit_control", c.id, { type });
  };

  const review = (c: DemoControl, by: DemoUser, decision: "accept" | "reject", daysAgo: number, reason: string | null = null) => {
    reviews.push({ id: newId(), controlId: c.id, tenantId: c.tenantId, reviewerId: by.id, decision, reason, createdAt: ago(daysAgo) });
    log(daysAgo, by.id, `control.${decision}`, c.tenantId, "audit_control", c.id, { status: decision === "accept" ? "accepted" : "rejected", reason });
  };

  const assign = (c: DemoControl, to: DemoUser, by: DemoUser, daysAgo: number) => {
    assignments.push({ controlId: c.id, userId: to.id });
    log(daysAgo, by.id, "control.assigned", c.tenantId, "audit_control", c.id, { userId: to.id });
  };

  /** Moves a control through the statuses a real one would have passed, writing the history as it goes. */
  const settle = (c: DemoControl, status: ControlStatus, who: { uploader: DemoUser; auditor: DemoUser }, uploadedDaysAgo: number, rejectReason?: string) => {
    c.status = status;
    if (status === "not_started" || status === "awaiting_evidence") return;
    log(uploadedDaysAgo - 0.1, who.uploader.id, "control.submitted", c.tenantId, "audit_control", c.id);
    if (status === "accepted") review(c, who.auditor, "accept", Math.max(uploadedDaysAgo - 2, 0.3));
    if (status === "rejected") review(c, who.auditor, "reject", Math.max(uploadedDaysAgo - 2, 0.3), rejectReason ?? "The evidence does not cover the whole audit period.");
  };

  // ---- Brightwave: the 2025 cycle, finished and closed -------------------------------------------------------------
  {
    const { audit, list } = startAudit(brightwave, "ISO/IEC 27001:2022 certification audit 2025", 330, declan);
    for (const c of list) {
      if (NOT_APPLICABLE.has(c.controlRef)) { c.applicable = false; c.naJustification = NA_REASON; continue; }
      c.status = "accepted";
      addFiles(c, 1, priya, 300 - Math.floor(rand() * 90));
    }
    audit.status = "closed";
    audit.closedAt = ago(150);
    audit.closedBy = declan.id;
    log(150, declan.id, "audit.closed", brightwave.id, "audit", audit.id, { name: audit.name, applicableControls: list.filter((c) => c.applicable).length, acceptedControls: list.filter((c) => c.applicable).length });
  }

  // ---- Brightwave: the 2026 cycle, part-way through ----------------------------------------------------------------
  {
    const { list } = startAudit(brightwave, "ISO/IEC 27001:2022 surveillance audit 2026", 75, declan);
    const auditors = [declan, maeve];
    const owner = (c: DemoControl): DemoUser => (c.kind === "clause" || c.section.startsWith("A.5") ? priya : c.section.startsWith("A.8") ? tom : lena);

    for (const c of list) {
      if (NOT_APPLICABLE.has(c.controlRef)) { c.applicable = false; c.naJustification = NA_REASON; log(72, declan.id, "control.applicability_changed", c.tenantId, "audit_control", c.id, { applicable: false }); continue; }
      const who = owner(c);
      assign(c, who, aoife, 70);

      const status = c.kind === "clause"
        ? weighted<ControlStatus>(rand, [["accepted", 80], ["submitted", 8], ["rejected", 4], ["awaiting_evidence", 8]])
        : weighted<ControlStatus>(rand, [["accepted", 42], ["submitted", 7], ["rejected", 3], ["awaiting_evidence", 23], ["not_started", 25]]);
      const uploaded = 8 + Math.floor(rand() * 55);
      const auditor = auditors[Math.floor(rand() * auditors.length)];
      if (status === "accepted" || status === "submitted" || status === "rejected") addFiles(c, rand() < 0.12 ? 2 : 1, who, uploaded);
      if (status === "awaiting_evidence" && rand() < 0.25) addFiles(c, 1, who, uploaded, "skipped");
      settle(c, status, { uploader: who, auditor }, uploaded);

      // Due dates: a third of the outstanding ones are late, a third are coming up, the rest have none.
      if (status === "awaiting_evidence" || status === "not_started") {
        const r = rand();
        if (r < 0.33) c.dueDate = dateOnly(-(3 + Math.floor(rand() * 20)));
        else if (r < 0.66) c.dueDate = dateOnly(4 + Math.floor(rand() * 35));
        if (c.dueDate && c.dueDate < dateOnly(0) && rand() < 0.5) { c.lastRemindedAt = ago(3); log(3, declan.id, "control.reminder_sent", c.tenantId, "audit_control", c.id); }
      }
    }

    const find = (ref: string) => list.find((c) => c.controlRef === ref)!;
    const reset = (c: DemoControl) => { // drop the random history of a control that the story below replaces
      c.dueDate = null; c.lastRemindedAt = null; c.status = "not_started";
      for (let i = files.length - 1; i >= 0; i--) if (files[i].controlId === c.id) files.splice(i, 1);
      for (let i = reviews.length - 1; i >= 0; i--) if (reviews[i].controlId === c.id) reviews.splice(i, 1);
      for (let i = logs.length - 1; i >= 0; i--) if (logs[i].entityId === c.id && /^(evidence\.|control\.(submitted|accept|reject))/.test(logs[i].action)) logs.splice(i, 1);
    };

    // A few controls are written by hand so that a visitor finds something to do on every role's first screen.
    const a51 = find("A.5.1"); reset(a51); addFiles(a51, 1, priya, 60); settle(a51, "accepted", { uploader: priya, auditor: declan }, 60);
    comment(a51, declan, "ofi", "Optional improvement: show the review date in the policy footer so readers can see at a glance that it is current.", 55);

    const a63 = find("A.6.3"); reset(a63); addFiles(a63, 1, lena, 21); settle(a63, "rejected", { uploader: lena, auditor: maeve }, 21, "The attendance list only covers Q1. Please include the Q2 and Q3 sessions.");
    comment(a63, maeve, "minor", "Training attendance covers the first quarter only; the audit period is the full twelve months.", 19);
    comment(a63, lena, "comment", "Thanks. The Q2 and Q3 sheets are being exported from the training system and will be uploaded this week.", 18);

    const c613 = find("6.1.3"); reset(c613); addFiles(c613, 1, priya, 14); settle(c613, "rejected", { uploader: priya, auditor: declan }, 14, "The version in this file is v4, but the management review minutes approved v5. Please upload the approved version.");
    comment(c613, declan, "major", "The Statement of Applicability version does not match the one approved at management review.", 12);

    const a88 = find("A.8.8"); reset(a88); addFiles(a88, 2, tom, 2); settle(a88, "submitted", { uploader: tom, auditor: declan }, 2);
    comment(a88, tom, "comment", "September scan summary attached, plus the patch compliance export from the same day.", 2);

    const a813 = find("A.8.13"); reset(a813); addFiles(a813, 1, tom, 40); settle(a813, "accepted", { uploader: tom, auditor: declan }, 40);
    a813.status = "under_review";
    const changed = files.find((f) => f.controlId === a813.id)!;
    changed.integrityStatus = "modified";
    log(1, declan.id, "evidence.integrity_flagged", a813.tenantId, "evidence_file", changed.id, { status: "modified" });
    comment(a813, declan, "observation", "The backup test report was changed in storage after it was accepted. Sent back to review while the client confirms what changed.", 1);

    for (const c of list) if (c.status === "accepted") for (const f of files) if (f.controlId === c.id && f.integrityStatus === "unchecked") f.integrityStatus = "verified";
  }

  // ---- Corran Logistics: a new client, a cycle just started ---------------------------------------------------------
  {
    const { list } = startAudit(corran, "ISO/IEC 27001:2022 initial audit", 12, declan);
    for (const c of list) {
      const lead = c.section.startsWith("A.8") ? ines : colm;
      assign(c, lead, declan, 10);
      const status = weighted<ControlStatus>(rand, [["not_started", 55], ["awaiting_evidence", 28], ["submitted", 9], ["accepted", c.kind === "clause" ? 14 : 4]]);
      const uploaded = 1 + Math.floor(rand() * 9);
      if (status === "accepted" || status === "submitted") addFiles(c, 1, lead, uploaded);
      settle(c, status, { uploader: lead, auditor: declan }, uploaded);
      if ((status === "awaiting_evidence" || status === "not_started") && rand() < 0.3) c.dueDate = dateOnly(10 + Math.floor(rand() * 30));
    }
  }

  for (const f of files) if (f.integrityStatus === "unchecked" && controls.find((c) => c.id === f.controlId)?.status === "accepted") f.integrityStatus = "verified";

  // The log is written in the order things happened, then numbered.
  logs.sort((a, b) => a.at - b.at);
  const numbered: DemoLogEntry[] = logs.map(({ at: _at, ...entry }, i) => ({ ...entry, seq: i + 1 }));

  return {
    version: STATE_VERSION,
    org,
    storageConnections: [{ id: newId(), provider: "local", label: "This server's disk", status: "active" }],
    templates: [{ id: templateId, framework: template.framework, version: template.version, name: template.name, isPlatformDefault: true }],
    tenants, users, auditorAssignments, audits, controls, assignments, files, comments, reviews,
    log: numbered,
    nextLogSeq: numbered.length + 1,
  };
}
