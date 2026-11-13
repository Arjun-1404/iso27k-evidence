import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { adminPool, appPool, as, makeWorld, controlId, assignContributor, addEvidence, denied, type World } from "./helpers.ts";

afterAll(async () => { await adminPool.end(); await appPool.end(); });

describe("evidence file immutability (belt and braces: GRANT restricts columns, the trigger double-checks)", () => {
  let w: World; let evidenceId: string;
  beforeAll(async () => {
    w = await makeWorld();
    const c85 = await controlId(w.auditA1, "A.8.5");
    await assignContributor(w, c85);
    await addEvidence(w.orgA, w.tA1, c85, w.contrib, "mfa.pdf");
    evidenceId = (await adminPool.query("SELECT id FROM evidence_files WHERE audit_control_id = $1", [c85])).rows[0].id;
  });

  it("an auditor can update integrity_status (the one thing this migration's GRANT allows)", async () => {
    const r = await as(w.auditor, (c) => c.query("UPDATE evidence_files SET integrity_status = 'modified' WHERE id = $1 RETURNING integrity_status", [evidenceId]));
    expect(r.rows[0].integrity_status).toBe("modified");
  });

  it("nobody — not even an auditor — can rewrite provider_hash, provider_version, or the file name through the app role", async () => {
    await denied(as(w.auditor, (c) => c.query("UPDATE evidence_files SET provider_hash = 'forged' WHERE id = $1", [evidenceId])), /permission denied/);
    await denied(as(w.auditor, (c) => c.query("UPDATE evidence_files SET provider_version = 'forged' WHERE id = $1", [evidenceId])), /permission denied/);
    await denied(as(w.auditor, (c) => c.query("UPDATE evidence_files SET file_name = 'renamed.pdf' WHERE id = $1", [evidenceId])), /permission denied/);
    await denied(as(w.auditor, (c) => c.query("UPDATE evidence_files SET uploaded_by = $2 WHERE id = $1", [evidenceId, w.lead])), /permission denied/);
  });

  it("a contributor and a tenant lead cannot update integrity_status at all (auditor-side only)", async () => {
    const asContrib = await as(w.contrib, (c) => c.query("UPDATE evidence_files SET integrity_status = 'verified' WHERE id = $1", [evidenceId]));
    expect(asContrib.rowCount).toBe(0);
    const asTLead = await as(w.tLead, (c) => c.query("UPDATE evidence_files SET integrity_status = 'verified' WHERE id = $1", [evidenceId]));
    expect(asTLead.rowCount).toBe(0);
  });

  it("evidence rows can never be deleted through the app role, by anyone", async () => {
    await denied(as(w.admin, (c) => c.query("DELETE FROM evidence_files WHERE id = $1", [evidenceId])), /permission denied/);
  });
});
