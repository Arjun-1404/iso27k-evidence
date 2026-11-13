import { describe, it, expect, afterAll } from "vitest";
import { adminPool, appPool, makeWorld, controlId, addEvidence, as, denied } from "./helpers.ts";

afterAll(async () => { await adminPool.end(); await appPool.end(); });

const providerOf = async (org: string) => (await adminPool.query("SELECT storage_provider FROM orgs WHERE id = $1", [org])).rows[0].storage_provider as string;

describe("which storages an organisation can choose", () => {
  it("accepts Google Drive, SharePoint, local disk and S3 — and nothing else — for both the choice and the connection", async () => {
    const w = await makeWorld();
    for (const p of ["google_drive", "sharepoint", "local", "s3"]) {
      await adminPool.query("UPDATE orgs SET storage_provider = $2 WHERE id = $1", [w.orgA, p]);
      expect(await providerOf(w.orgA), p).toBe(p);
      await adminPool.query("INSERT INTO storage_connections (org_id, provider, token_ref) VALUES ($1,$2,'x') ON CONFLICT (org_id, provider) DO NOTHING", [w.orgA, p]);
    }
    await denied(adminPool.query("UPDATE orgs SET storage_provider = 'dropbox' WHERE id = $1", [w.orgA]), /orgs_storage_provider_check/);
    await denied(adminPool.query("INSERT INTO storage_connections (org_id, provider, token_ref) VALUES ($1,'dropbox','x')", [w.orgA]), /storage_connections_provider_check/);
  });
});

describe("switching storage is free until the first evidence file is recorded, then locked for good", () => {
  it("before any evidence: the switch works, the old storage's folders are forgotten, and the change is logged", async () => {
    const w = await makeWorld();
    await adminPool.query("UPDATE tenants SET storage_root_id = 'drive-root-1' WHERE id IN ($1,$2)", [w.tA1, w.tA2]);
    const c85 = await controlId(w.auditA1, "A.8.5");
    await adminPool.query("UPDATE audit_controls SET folder_id = 'drive-folder-1' WHERE id = $1", [c85]);
    await adminPool.query("UPDATE tenants SET storage_root_id = 'other-org-root' WHERE id = $1", [w.tB1]);

    await as(w.admin, (c) => c.query("UPDATE orgs SET storage_provider = 'local' WHERE id = $1", [w.orgA]));

    expect(await providerOf(w.orgA)).toBe("local");
    expect((await adminPool.query("SELECT storage_root_id FROM tenants WHERE org_id = $1", [w.orgA])).rows.map((r) => r.storage_root_id)).toEqual([null, null]);
    expect((await adminPool.query("SELECT folder_id FROM audit_controls WHERE id = $1", [c85])).rows[0].folder_id).toBeNull();
    // Another organisation's folders are not touched.
    expect((await adminPool.query("SELECT storage_root_id FROM tenants WHERE id = $1", [w.tB1])).rows[0].storage_root_id).toBe("other-org-root");
    const log = await adminPool.query("SELECT actor_id, change FROM audit_log WHERE org_id = $1 AND action = 'org.storage_provider_changed'", [w.orgA]);
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0].actor_id).toBe(w.admin);
    expect(log.rows[0].change).toEqual({ from: "google_drive", to: "local" });
  });

  it("saving the same choice again changes nothing and logs nothing", async () => {
    const w = await makeWorld();
    await adminPool.query("UPDATE tenants SET storage_root_id = 'keep-me' WHERE id = $1", [w.tA1]);
    await as(w.admin, (c) => c.query("UPDATE orgs SET storage_provider = 'google_drive', name = 'Renamed' WHERE id = $1", [w.orgA]));
    expect((await adminPool.query("SELECT storage_root_id FROM tenants WHERE id = $1", [w.tA1])).rows[0].storage_root_id).toBe("keep-me");
    expect((await adminPool.query("SELECT count(*)::int AS n FROM audit_log WHERE org_id = $1 AND action = 'org.storage_provider_changed'", [w.orgA])).rows[0].n).toBe(0);
  });

  it("once a file is recorded, any switch is refused, whoever asks and however it is attempted", async () => {
    const w = await makeWorld();
    const c85 = await controlId(w.auditA1, "A.8.5");
    await adminPool.query("UPDATE tenants SET storage_root_id = 'root-x' WHERE id = $1", [w.tA1]);
    await addEvidence(w.orgA, w.tA1, c85, w.contrib);

    await denied(as(w.admin, (c) => c.query("UPDATE orgs SET storage_provider = 'local' WHERE id = $1", [w.orgA])), /STORAGE_PROVIDER_LOCKED/);
    await denied(as(w.admin, (c) => c.query("UPDATE orgs SET storage_provider = 's3' WHERE id = $1", [w.orgA])), /already has evidence/);
    await denied(adminPool.query("UPDATE orgs SET storage_provider = 'local' WHERE id = $1", [w.orgA]), /STORAGE_PROVIDER_LOCKED/);   // even the database owner
    expect(await providerOf(w.orgA)).toBe("google_drive");
    expect((await adminPool.query("SELECT storage_root_id FROM tenants WHERE id = $1", [w.tA1])).rows[0].storage_root_id).toBe("root-x");
  });

  it("the lock is per organisation: evidence in one does not lock another", async () => {
    const w = await makeWorld();
    await addEvidence(w.orgA, w.tA1, await controlId(w.auditA1, "A.8.5"), w.contrib);
    await as(w.adminB, (c) => c.query("UPDATE orgs SET storage_provider = 's3' WHERE id = $1", [w.orgB]));
    expect(await providerOf(w.orgB)).toBe("s3");
  });

  it("only an org admin can change it at all", async () => {
    const w = await makeWorld();
    for (const u of [w.lead, w.auditor, w.tLead, w.contrib]) {
      const r = await as(u, (c) => c.query("UPDATE orgs SET storage_provider = 'local' WHERE id = $1", [w.orgA]).catch((e) => e as Error));
      // Either rejected outright, or the row policy let it touch no row.
      if (r instanceof Error) expect(r.message).toMatch(/permission denied/);
      else expect(r.rowCount).toBe(0);
    }
    expect(await providerOf(w.orgA)).toBe("google_drive");
  });

  it("a closed audit cycle's frozen controls don't stop an (evidence-free) switch, and keep their folder", async () => {
    const w = await makeWorld();
    const c85 = await controlId(w.auditA1, "A.8.5");
    await adminPool.query("UPDATE audit_controls SET folder_id = 'old-folder' WHERE id = $1", [c85]);
    await adminPool.query("UPDATE audit_controls SET folder_id = 'folder-open' WHERE id = $1", [await controlId(w.auditA2, "A.8.5")]);
    await as(w.lead, (c) => c.query("SELECT audit_close($1)", [w.auditA1]));

    await as(w.admin, (c) => c.query("UPDATE orgs SET storage_provider = 'local' WHERE id = $1", [w.orgA]));

    expect(await providerOf(w.orgA)).toBe("local");
    expect((await adminPool.query("SELECT folder_id FROM audit_controls WHERE id = $1", [c85])).rows[0].folder_id).toBe("old-folder");
    expect((await adminPool.query("SELECT folder_id FROM audit_controls WHERE id = $1", [await controlId(w.auditA2, "A.8.5")])).rows[0].folder_id).toBeNull();
  });
});

describe("finishing a Google Drive connection also makes Drive the storage — when that is still allowed", () => {
  const complete = async (w: Awaited<ReturnType<typeof makeWorld>>, stateHash: string) => {
    await adminPool.query("INSERT INTO oauth_states (state_hash, org_id, actor_id, provider, expires_at) VALUES ($1,$2,$3,'google_drive', now() + interval '10 minutes')", [stateHash, w.orgA, w.admin]);
    return adminPool.query("SELECT * FROM oauth_complete_connection($1, 'tok', NULL)", [stateHash]);
  };

  it("an organisation that had chosen local disk is switched to Drive", async () => {
    const w = await makeWorld();
    await adminPool.query("UPDATE orgs SET storage_provider = 'local' WHERE id = $1", [w.orgA]);
    const r = await complete(w, `h-${w.tag}-1`);
    expect(r.rowCount).toBe(1);
    expect(await providerOf(w.orgA)).toBe("google_drive");
  });

  it("an organisation whose evidence already lives elsewhere keeps its storage; the Drive connection is saved but not used", async () => {
    const w = await makeWorld();
    await adminPool.query("UPDATE orgs SET storage_provider = 's3' WHERE id = $1", [w.orgA]);
    await addEvidence(w.orgA, w.tA1, await controlId(w.auditA1, "A.8.5"), w.contrib);
    const r = await complete(w, `h-${w.tag}-2`);
    expect(r.rowCount).toBe(1);
    expect(await providerOf(w.orgA)).toBe("s3");
    expect((await adminPool.query("SELECT status FROM storage_connections WHERE org_id = $1 AND provider = 'google_drive'", [w.orgA])).rows[0].status).toBe("active");
  });

  it("an unknown or used state still yields nothing, and changes nothing", async () => {
    const w = await makeWorld();
    await adminPool.query("UPDATE orgs SET storage_provider = 'local' WHERE id = $1", [w.orgA]);
    expect((await adminPool.query("SELECT * FROM oauth_complete_connection('nope', 'tok', NULL)")).rowCount).toBe(0);
    expect(await providerOf(w.orgA)).toBe("local");
  });
});
