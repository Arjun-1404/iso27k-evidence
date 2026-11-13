// @vitest-environment node
import { describe, expect, it } from "vitest";
import template from "./iso27001-2022.json";
import { buildSeed, seedIdGenerator } from "./seed";
import { DEMO_PASSWORD, SIGN_IN_ACCOUNTS } from "./accounts";
import { statusTransitionOk } from "./rules";
import { minimalPdf, placeholderFile } from "./placeholder";

const NOW = Date.parse("2026-06-10T09:00:00.000Z");
const seed = () => buildSeed({ now: NOW, newId: seedIdGenerator() });

describe("the ISO 27001:2022 control list", () => {
  it("has the 24 clause requirements and the 93 Annex A controls, each once, in order", () => {
    const controls = template.controls as { kind: string; control_ref: string; sort_order: number; title: string; default_evidence: string; section: string }[];
    expect(controls.filter((c) => c.kind === "clause")).toHaveLength(24);
    expect(controls.filter((c) => c.kind === "annex")).toHaveLength(93);
    expect(new Set(controls.map((c) => c.control_ref)).size).toBe(117);
    const orders = controls.map((c) => c.sort_order);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
    expect(controls.every((c) => c.title && c.default_evidence && c.section)).toBe(true);
  });

  // The web app's Docker build only sees the frontend folder; the repository as a whole has both copies and checks they agree.
  // (A glob finds nothing, rather than failing, when that folder is not there.)
  const originals = Object.values(import.meta.glob("../../../db/seed/iso27001-2022.json", { eager: true, import: "default" }));
  it.skipIf(originals.length === 0)("is the same list the real server loads (db/seed/iso27001-2022.json)", () => {
    expect(template).toEqual(originals[0]);
  });
});

describe("the sample world", () => {
  it("is the same every time it is built (so screenshots, tests and a visitor's second visit agree)", () => {
    expect(JSON.stringify(seed())).toBe(JSON.stringify(seed()));
  });

  it("is made of people, clients and addresses that cannot belong to anyone real", () => {
    const s = seed();
    for (const u of s.users) expect(u.email).toMatch(/\.example$/);
    for (const t of s.tenants) for (const d of t.allowedDomains) expect(d).toMatch(/\.example$/);
    expect(s.org.allowedDomains.every((d) => d.endsWith(".example"))).toBe(true);
  });

  it("offers a sign-in for people who exist and whose password is the demo password", () => {
    const s = seed();
    for (const a of SIGN_IN_ACCOUNTS) {
      const u = s.users.find((x) => x.email === a.email);
      expect(u, a.email).toBeTruthy();
      expect(u!.password).toBe(DEMO_PASSWORD);
      expect(u!.status).toBe("active");
      expect(u!.fullName).toBe(a.fullName);
    }
  });

  it("has two clients with live audits, a closed earlier cycle, and an archived client", () => {
    const s = seed();
    expect(s.tenants.map((t) => `${t.name}:${t.status}`).sort()).toEqual(["Brightwave Software Ltd:active", "Corran Logistics:active", "Old Mill Foods:archived"]);
    expect(s.audits.filter((a) => a.status === "closed")).toHaveLength(1);
    expect(s.audits.filter((a) => a.status === "in_progress")).toHaveLength(2);
  });

  it("shows every status somewhere, so no screen is empty", () => {
    const s = seed();
    const live = s.audits.find((a) => a.status === "in_progress" && a.name.includes("2026"))!;
    const statuses = new Set(s.controls.filter((c) => c.auditId === live.id).map((c) => c.status));
    expect([...statuses].sort()).toEqual(["accepted", "awaiting_evidence", "not_started", "rejected", "submitted", "under_review"]);
  });

  it("holds together: every record points at something that exists, and nothing breaks the rules", () => {
    const s = seed();
    const tenantIds = new Set(s.tenants.map((t) => t.id));
    const auditIds = new Set(s.audits.map((a) => a.id));
    const controlById = new Map(s.controls.map((c) => [c.id, c]));
    const userIds = new Set(s.users.map((u) => u.id));
    expect(new Set([...s.users, ...s.tenants, ...s.audits, ...s.controls].map((x) => x.id)).size).toBe(s.users.length + s.tenants.length + s.audits.length + s.controls.length);
    for (const c of s.controls) { expect(auditIds.has(c.auditId)).toBe(true); expect(tenantIds.has(c.tenantId)).toBe(true); }
    for (const f of s.files) { expect(controlById.has(f.controlId)).toBe(true); expect(userIds.has(f.uploadedBy)).toBe(true); }
    for (const a of s.assignments) { expect(controlById.has(a.controlId)).toBe(true); expect(userIds.has(a.userId)).toBe(true); }
    for (const e of s.log) if (e.actorId) expect(userIds.has(e.actorId)).toBe(true);
    for (const c of s.controls) {
      if (!c.applicable) { expect(c.naJustification, c.controlRef).toBeTruthy(); expect(c.kind).toBe("annex"); }
      // "accepted", "submitted" and "under_review" mean evidence was handed in
      if (["accepted", "submitted", "under_review"].includes(c.status) && c.applicable) expect(s.files.some((f) => f.controlId === c.id), `${c.controlRef} ${c.status}`).toBe(true);
    }
    const closed = s.audits.find((a) => a.status === "closed")!;
    expect(closed.closedAt).toBeTruthy();
    expect(closed.closedBy && userIds.has(closed.closedBy)).toBe(true);
    for (const c of s.controls.filter((x) => x.auditId === closed.id && x.applicable)) expect(c.status).toBe("accepted");
    expect(s.reviews.every((r) => controlById.has(r.controlId) && ["accept", "reject"].includes(r.decision))).toBe(true);
    // every status is one an auditor or client could really have reached
    expect(statusTransitionOk("not_started", "awaiting_evidence", "auditor")).toBe(true);
  });

  it("has an audit log in order, with each entry numbered once and dated in the past", () => {
    const s = seed();
    const seqs = s.log.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(s.log.every((e) => Date.parse(e.createdAt) <= NOW)).toBe(true);
    const times = s.log.map((e) => Date.parse(e.createdAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(s.nextLogSeq).toBe(Math.max(...seqs) + 1);
  });

  it("makes the dates move with the clock, so the demo never looks old", () => {
    const later = buildSeed({ now: NOW + 365 * 86_400_000, newId: seedIdGenerator() });
    const first = seed();
    const due = (s: typeof first) => s.controls.filter((c) => c.dueDate).map((c) => c.dueDate!).sort();
    expect(due(later)[0]).not.toBe(due(first)[0]);
    expect(Date.parse(due(later)[0]!) - Date.parse(due(first)[0]!)).toBe(365 * 86_400_000);
  });
});

describe("sample evidence files", () => {
  it("download as a valid PDF that says so", async () => {
    const bytes = new Uint8Array(await placeholderFile("access-review.pdf", "A.5.15 Access control").arrayBuffer());
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text.startsWith("%PDF-1.")).toBe(true);
    expect(text).toContain("%%EOF");
    expect(text).toContain("access-review.pdf");
    expect(text.toLowerCase()).toContain("demo");
    // the cross-reference table points at the right byte offsets
    const xrefAt = Number(/startxref\s+(\d+)/.exec(text)![1]);
    expect(text.slice(xrefAt, xrefAt + 4)).toBe("xref");
    const offsets = [...text.slice(xrefAt).matchAll(/^(\d{10}) 00000 n/gm)].map((m) => Number(m[1]));
    offsets.forEach((o, i) => expect(text.slice(o, o + 7)).toBe(`${i + 1} 0 obj`));
  });
  it("escape what would break the page", () => {
    const text = new TextDecoder("latin1").decode(minimalPdf(["a (b) c \\ d"]));
    expect(text).toContain("a \\(b\\) c \\\\ d");
  });
});
