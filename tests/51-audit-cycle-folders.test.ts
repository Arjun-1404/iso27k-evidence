import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { adminPool, appPool, makeWorld, controlId, assignContributor, type World } from "./helpers.ts";
import { InMemoryStorageProvider } from "../src/storage/inMemoryProvider.ts";
import { FakeScanner } from "../src/scan/types.ts";
import { auditFolderName } from "../src/services/folderNames.ts";
import * as audits from "../src/services/audits.ts";
import * as evidence from "../src/services/evidence.ts";
import * as dashboard from "../src/services/dashboard.ts";

afterAll(async () => { await adminPool.end(); await appPool.end(); });

const ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

describe("auditFolderName", () => {
  it("is the audit's name followed by a short code from its id", () => {
    expect(auditFolderName("ISO 27001 audit 2026", ID)).toBe("ISO 27001 audit 2026 [1a2b3c4d]");
  });

  it("tells two audits with the same name apart", () => {
    const a = auditFolderName("Surveillance audit", ID);
    const b = auditFolderName("Surveillance audit", "9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f");
    expect(a).not.toBe(b);
    expect(a.endsWith("[1a2b3c4d]")).toBe(true);
    expect(b.endsWith("[9f8e7d6c]")).toBe(true);
  });

  it("is the same every time for the same audit, so the folder is found again rather than duplicated", () => {
    expect(auditFolderName("2027 cycle", ID)).toBe(auditFolderName("2027 cycle", ID));
  });

  it("replaces characters that Drive, SharePoint or Windows won't accept in a folder name", () => {
    expect(auditFolderName('Q4/2027: "big" audit? <draft> | a\\b*', ID)).toBe("Q4-2027- -big- audit- -draft- - a-b- [1a2b3c4d]");
    for (const bad of ['/', '\\', ':', '*', '?', '"', '<', '>', '|', "\u0000", "\n", "\t"]) {
      const name = auditFolderName(`a${bad}b`, ID);
      expect(name, JSON.stringify(bad)).not.toMatch(/[\\/:*?"<>|\u0000-\u001f]/);
    }
  });

  it("collapses runs of spaces and trims the ends", () => {
    expect(auditFolderName("   spaced    out   name  ", ID)).toBe("spaced out name [1a2b3c4d]");
  });

  it("never ends the name part with a dot or a space (SharePoint and Windows refuse that)", () => {
    expect(auditFolderName("Audit...", ID)).toBe("Audit [1a2b3c4d]");
    expect(auditFolderName("Audit . . ", ID)).toBe("Audit [1a2b3c4d]");
  });

  it("falls back to 'Audit' when nothing usable is left of the name", () => {
    expect(auditFolderName("...", ID)).toBe("Audit [1a2b3c4d]");
    expect(auditFolderName("   ", ID)).toBe("Audit [1a2b3c4d]");
  });

  it("keeps long names to a sensible length", () => {
    const name = auditFolderName("x".repeat(500), ID);
    expect(name).toBe(`${"x".repeat(120)} [1a2b3c4d]`);
  });
});

describe("evidence from different audit cycles stays apart", () => {
  let w: World; let storage: InMemoryStorageProvider; let scanner: FakeScanner;
  let second: audits.AuditSummary; let third: audits.AuditSummary;
  const put = async (user: string, control: string, name: string) => {
    const s = await evidence.requestUploadSession(appPool, user, storage, control, { fileName: name, mimeType: "application/pdf", sizeBytes: 10 });
    await evidence.confirmUpload(appPool, user, storage, scanner, control, s.providerFileId);
    return s.providerFileId;
  };
  const folderOf = async (control: string) =>
    (await adminPool.query("SELECT folder_id FROM audit_controls WHERE id=$1", [control])).rows[0].folder_id as string;

  beforeAll(async () => {
    w = await makeWorld();
    await adminPool.query("UPDATE tenants SET storage_root_id = 'root-a1' WHERE id = $1", [w.tA1]);
    storage = new InMemoryStorageProvider(); scanner = new FakeScanner();
    const [template] = await audits.listTemplates(appPool, w.lead);
    second = await audits.createAudit(appPool, w.lead, w.tA1, template.id, "2027 surveillance audit");
    third = await audits.createAudit(appPool, w.lead, w.tA1, template.id, "2027 surveillance audit"); // same name on purpose
  });

  it("a control's folder sits inside its audit cycle's folder, inside the client's folder", async () => {
    const c = await controlId(w.auditA1, "A.8.5");
    await assignContributor(w, c);
    const fileId = await put(w.contrib, c, "first-cycle.pdf");
    const cycle = await storage.findOrCreateFolder("root-a1", auditFolderName("A1 audit", w.auditA1));
    const ctl = await storage.findOrCreateFolder(cycle.id, "A.8.5");
    expect(await folderOf(c)).toBe(ctl.id);
    expect((await storage.listFiles(ctl.id)).map((f) => f.providerFileId)).toEqual([fileId]);
    // and nothing was put straight into the client's folder under the control's name
    const flat = await storage.findOrCreateFolder("root-a1", "A.8.5");
    expect(flat.id).not.toBe(ctl.id);
    expect(await storage.listFiles(flat.id)).toEqual([]);
  });

  it("the same control in a later cycle gets a different folder, and each holds only its own cycle's files", async () => {
    const c1 = await controlId(w.auditA1, "A.8.5");
    const c2 = await controlId(second.id, "A.8.5");
    await assignContributor(w, c2);
    const f2 = await put(w.contrib, c2, "second-cycle.pdf");
    expect(await folderOf(c2)).not.toBe(await folderOf(c1));
    expect((await storage.listFiles(await folderOf(c2))).map((f) => f.providerFileId)).toEqual([f2]);
    expect((await storage.listFiles(await folderOf(c1))).map((f) => f.name)).toEqual(["first-cycle.pdf"]);
  });

  it("two cycles with the very same name still get separate folders", async () => {
    const c2 = await controlId(second.id, "A.8.7");
    const c3 = await controlId(third.id, "A.8.7");
    await assignContributor(w, c2); await assignContributor(w, c3);
    await put(w.contrib, c2, "a.pdf"); await put(w.contrib, c3, "b.pdf");
    expect(await folderOf(c2)).not.toBe(await folderOf(c3));
    expect((await storage.listFiles(await folderOf(c3))).map((f) => f.name)).toEqual(["b.pdf"]);
    expect((await storage.listFiles(await folderOf(c2))).map((f) => f.name)).toEqual(["a.pdf"]);
  });

  it("later uploads to the same control keep using that control's one folder", async () => {
    const c2 = await controlId(second.id, "A.8.5");
    const before = await folderOf(c2);
    await put(w.contrib, c2, "more.pdf");
    expect(await folderOf(c2)).toBe(before);
    expect((await storage.listFiles(before)).map((f) => f.name).sort()).toEqual(["more.pdf", "second-cycle.pdf"]);
  });

  it("the evidence list and the dashboard of one cycle know nothing of another's", async () => {
    const c1 = await controlId(w.auditA1, "A.8.5");
    const c2 = await controlId(second.id, "A.8.5");
    expect((await evidence.listEvidenceFiles(appPool, w.lead, c1)).map((f) => f.fileName)).toEqual(["first-cycle.pdf"]);
    expect((await evidence.listEvidenceFiles(appPool, w.lead, c2)).map((f) => f.fileName).sort()).toEqual(["more.pdf", "second-cycle.pdf"]);
    await adminPool.query("UPDATE audit_controls SET status='accepted' WHERE id=$1", [c1]);
    const d1 = await dashboard.getDashboard(appPool, w.lead, w.auditA1);
    const d2 = await dashboard.getDashboard(appPool, w.lead, second.id);
    expect(d1.accepted).toBe(1);
    expect(d2.accepted).toBe(0);
  });
});

describe("a client's audit cycles", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });

  it("are listed newest first, and every cycle is a complete, separate set of controls", async () => {
    const [template] = await audits.listTemplates(appPool, w.lead);
    const b = await audits.createAudit(appPool, w.lead, w.tA1, template.id, "Cycle B");
    const c = await audits.createAudit(appPool, w.lead, w.tA1, template.id, "Cycle C");
    const list = await audits.listAudits(appPool, w.lead, w.tA1);
    expect(list.map((a) => a.id)).toEqual([c.id, b.id, w.auditA1]);
    expect(list.map((a) => a.status)).toEqual(["in_progress", "in_progress", "in_progress"]);
    for (const a of [b, c]) {
      const n = await adminPool.query("SELECT count(*)::int AS n, count(DISTINCT id)::int AS d FROM audit_controls WHERE audit_id=$1", [a.id]);
      expect(n.rows[0]).toEqual({ n: 117, d: 117 });
    }
  });

  it("a new cycle starts with nothing done, whatever happened in the earlier ones", async () => {
    const c = await controlId(w.auditA1, "A.8.5");
    await adminPool.query("UPDATE audit_controls SET status='accepted', applicable=false, na_justification='not relevant here' WHERE id=$1", [c]);
    const [template] = await audits.listTemplates(appPool, w.lead);
    const fresh = await audits.createAudit(appPool, w.lead, w.tA1, template.id, "Fresh start");
    const r = await adminPool.query("SELECT status, applicable FROM audit_controls WHERE audit_id=$1 AND control_ref='A.8.5'", [fresh.id]);
    expect(r.rows[0]).toEqual({ status: "not_started", applicable: true });
  });
});
