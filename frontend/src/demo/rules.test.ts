import { describe, expect, it } from "vitest";
import type { ControlStatus, Role } from "../api/types";
import { checkPasswordStrength, dashboardSummary, DEFAULT_MAX_FILES_PER_CONTROL, MAX_UPLOAD_BYTES, OUTSTANDING, statusTransitionOk, validateFile, type DashboardRow } from "./rules";

// Every rule the real database enforces, spelled out. The real server's own tests spell out the same rules against a
// real database; if one side changes, one of the two suites fails.

const STATUSES: ControlStatus[] = ["not_started", "awaiting_evidence", "submitted", "under_review", "accepted", "rejected"];

describe("who may move a control from one status to another", () => {
  const allowed = (role: Role) => STATUSES.flatMap((a) => STATUSES.filter((b) => a !== b && statusTransitionOk(a, b, role)).map((b) => `${a}>${b}`)).sort();

  it("the client side can only submit: from not started, awaiting evidence or rejected", () => {
    const expected = ["not_started>submitted", "awaiting_evidence>submitted", "rejected>submitted"].sort();
    expect(allowed("contributor")).toEqual(expected);
    expect(allowed("tenant_lead")).toEqual(expected);
  });

  it("auditors, lead auditors and admins can ask for evidence, review, accept, reject, and take back an acceptance", () => {
    const expected = [
      "not_started>awaiting_evidence",
      "submitted>under_review", "submitted>accepted", "submitted>rejected",
      "under_review>accepted", "under_review>rejected",
      "accepted>under_review",
    ].sort();
    for (const role of ["auditor", "lead_auditor", "org_admin"] as const) expect(allowed(role)).toEqual(expected);
  });

  it("nobody else can move a control", () => {
    for (const role of ["read_only", "dashboard_only", "viewer", "tenant_dashboard"] as const) expect(allowed(role)).toEqual([]);
  });

  it("'no change' is always fine, for anyone", () => {
    for (const role of ["read_only", "viewer", "contributor", "auditor"] as const) for (const s of STATUSES) expect(statusTransitionOk(s, s, role)).toBe(true);
  });

  it("a reminder only makes sense while evidence is outstanding", () => {
    expect([...OUTSTANDING].sort()).toEqual(["awaiting_evidence", "not_started", "rejected"]);
  });
});

describe("which files are accepted", () => {
  const ok = { fileName: "report.pdf", mimeType: "application/pdf", sizeBytes: 1000 };
  it("accepts the allowed types, in any letter case of the extension", () => {
    expect(validateFile(ok, undefined, 0)).toEqual({ ok: true });
    expect(validateFile({ ...ok, fileName: "REPORT.PDF" }, undefined, 0)).toEqual({ ok: true });
    for (const [name, mime] of [["a.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"], ["a.png", "image/png"], ["a.jpg", "image/jpeg"], ["a.csv", "text/csv"], ["a.txt", "text/plain"]] as const) {
      expect(validateFile({ fileName: name, mimeType: mime, sizeBytes: 5 }, undefined, 0)).toEqual({ ok: true });
    }
  });
  it("refuses a type that is not on the list, and a name that does not match its type", () => {
    expect(validateFile({ fileName: "a.exe", mimeType: "application/x-msdownload", sizeBytes: 5 }, undefined, 0).ok).toBe(false);
    expect(validateFile({ fileName: "a.png", mimeType: "application/pdf", sizeBytes: 5 }, undefined, 0).ok).toBe(false);
    expect(validateFile({ fileName: "pdf", mimeType: "application/pdf", sizeBytes: 5 }, undefined, 0).ok).toBe(false);
  });
  it("enforces the size limits: 1 byte to 25 MB", () => {
    expect(validateFile({ ...ok, sizeBytes: 0 }, undefined, 0).ok).toBe(false);
    expect(validateFile({ ...ok, sizeBytes: 1 }, undefined, 0).ok).toBe(true);
    expect(validateFile({ ...ok, sizeBytes: MAX_UPLOAD_BYTES }, undefined, 0).ok).toBe(true);
    expect(validateFile({ ...ok, sizeBytes: MAX_UPLOAD_BYTES + 1 }, undefined, 0).ok).toBe(false);
  });
  it("refuses awkward file names", () => {
    for (const name of ["a/b.pdf", "a\\b.pdf", "a\u0000.pdf", " a.pdf", "a.pdf ", ".pdf".padStart(256, "x"), ""]) {
      expect(validateFile({ ...ok, fileName: name }, undefined, 0).ok).toBe(false);
    }
  });
  it("follows what the control asks for: file kinds and how many", () => {
    expect(validateFile(ok, { types: ["image"] }, 0)).toMatchObject({ ok: false });
    expect(validateFile({ fileName: "a.png", mimeType: "image/png", sizeBytes: 5 }, { types: ["image"] }, 0).ok).toBe(true);
    expect(validateFile(ok, { types: ["any"] }, 0).ok).toBe(true);
    expect(validateFile(ok, { maxFiles: 2 }, 1).ok).toBe(true);
    expect(validateFile(ok, { maxFiles: 2 }, 2).ok).toBe(false);
    expect(validateFile(ok, undefined, DEFAULT_MAX_FILES_PER_CONTROL).ok).toBe(false);
    expect(validateFile(ok, undefined, DEFAULT_MAX_FILES_PER_CONTROL - 1).ok).toBe(true);
  });
});

describe("passwords", () => {
  it("need 12 characters, at most 256, and must not be on the short list of common ones", () => {
    expect(checkPasswordStrength("a".repeat(11)).ok).toBe(false);
    expect(checkPasswordStrength("a".repeat(12)).ok).toBe(true);
    expect(checkPasswordStrength("a".repeat(256)).ok).toBe(true);
    expect(checkPasswordStrength("a".repeat(257)).ok).toBe(false);
    expect(checkPasswordStrength("LETMEIN12345").ok).toBe(false);
  });
});

describe("the dashboard numbers", () => {
  const row = (o: Partial<DashboardRow>): DashboardRow => ({ applicable: true, status: "not_started", dueDate: null, section: "A", sortOrder: 1, ...o });

  it("is all zeroes, with no division by zero, when nothing is applicable", () => {
    const d = dashboardSummary([row({ applicable: false })], "2026-01-01");
    expect(d).toMatchObject({ total: 1, applicable: 0, notApplicable: 1, accepted: 0, overdue: 0, completionPct: 0, byStatus: [] });
  });
  it("rounds the percentage to one decimal place like the database does (1 of 3 is 33.3, 2 of 3 is 66.7)", () => {
    const rows = (n: number) => [...Array(3)].map((_, i) => row({ status: i < n ? "accepted" : "submitted" }));
    expect(dashboardSummary(rows(1), "2026-01-01").completionPct).toBe(33.3);
    expect(dashboardSummary(rows(2), "2026-01-01").completionPct).toBe(66.7);
    expect(dashboardSummary(rows(3), "2026-01-01").completionPct).toBe(100);
  });
  it("counts as overdue only what is applicable, not accepted, and due strictly before today", () => {
    const today = "2026-06-10";
    const d = dashboardSummary([
      row({ dueDate: "2026-06-09" }), // overdue
      row({ dueDate: "2026-06-10" }), // due today: not overdue
      row({ dueDate: "2026-06-09", status: "accepted" }), // done
      row({ dueDate: "2026-06-09", applicable: false }), // not applicable
      row({ dueDate: null }), // no date
    ], today);
    expect(d.overdue).toBe(1);
  });
  it("lists the statuses the way the database's JSON does (shorter names first, then alphabetically) and counts applicable controls only", () => {
    const d = dashboardSummary([
      row({ status: "awaiting_evidence" }), row({ status: "under_review" }), row({ status: "not_started" }), row({ status: "rejected" }),
      row({ status: "submitted" }), row({ status: "accepted" }), row({ status: "accepted" }), row({ status: "submitted", applicable: false }),
    ], "2026-01-01");
    expect(d.byStatus.map((s) => s.status)).toEqual(["accepted", "rejected", "submitted", "not_started", "under_review", "awaiting_evidence"]);
    expect(d.byStatus.find((s) => s.status === "submitted")!.count).toBe(1);
    expect(d.byStatus.find((s) => s.status === "accepted")!.count).toBe(2);
  });
  it("lists the sections in the order of their first control, with each section's own counts", () => {
    const d = dashboardSummary([
      row({ section: "B", sortOrder: 5, status: "accepted" }), row({ section: "A", sortOrder: 2 }), row({ section: "B", sortOrder: 3 }), row({ section: "A", sortOrder: 9, applicable: false }),
    ], "2026-01-01");
    expect(d.bySection).toEqual([{ section: "A", applicable: 1, accepted: 0 }, { section: "B", applicable: 2, accepted: 1 }]);
  });
});
