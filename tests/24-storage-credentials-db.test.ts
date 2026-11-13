import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { adminPool, appPool, as, makeWorld, type World } from "./helpers.ts";
import { withoutUser } from "../src/db/pool.ts";

afterAll(async () => { await adminPool.end(); await appPool.end(); });

async function connect(org: string, tokenRef: string, status = "active", provider = "google_drive"): Promise<string> {
  const r = await adminPool.query(
    "INSERT INTO storage_connections (org_id, provider, token_ref, status) VALUES ($1,$2,$3,$4) RETURNING id",
    [org, provider, tokenRef, status]);
  return r.rows[0].id as string;
}
const creds = (userId: string) => as(userId, (c) => c.query("SELECT * FROM storage_credentials_for_caller()"));

describe("storage_credentials_for_caller", () => {
  let w: World; let connA: string; let connB: string;
  beforeAll(async () => {
    w = await makeWorld();
    connA = await connect(w.orgA, "token-ref-for-org-a");
    connB = await connect(w.orgB, "token-ref-for-org-b");
  });

  it("gives every role that works with evidence exactly its OWN org's connection", async () => {
    for (const u of [w.admin, w.lead, w.auditor, w.readOnly, w.tLead, w.contrib, w.viewer]) {
      const r = await creds(u);
      expect(r.rows, u).toEqual([{ out_connection_id: connA, out_provider: "google_drive", out_token_ref: "token-ref-for-org-a" }]);
    }
    const b = await creds(w.adminB);
    expect(b.rows).toEqual([{ out_connection_id: connB, out_provider: "google_drive", out_token_ref: "token-ref-for-org-b" }]);
  });

  it("never reveals another org's credential, whoever asks", async () => {
    for (const u of [w.adminB, w.leadB, w.tLeadB]) {
      const r = await creds(u);
      expect(JSON.stringify(r.rows)).not.toContain("token-ref-for-org-a");
    }
    for (const u of [w.admin, w.lead, w.tLead, w.contrib]) {
      expect(JSON.stringify((await creds(u)).rows)).not.toContain("token-ref-for-org-b");
    }
  });

  it("returns nothing to the dashboard-only roles, which never touch storage", async () => {
    for (const u of [w.dash, w.tDash]) expect((await creds(u)).rowCount).toBe(0);
  });

  it("returns nothing with no signed-in user (fails closed)", async () => {
    const r = await withoutUser(appPool, (c) => c.query("SELECT * FROM storage_credentials_for_caller()"));
    expect(r.rowCount).toBe(0);
  });

  it("returns nothing for a disabled user", async () => {
    const w2 = await makeWorld();
    await connect(w2.orgA, "ref-w2");
    expect((await creds(w2.contrib)).rowCount).toBe(1);
    await adminPool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [w2.contrib]);
    expect((await creds(w2.contrib)).rowCount).toBe(0);
  });

  it("does not loosen the table itself: only an org admin can still read storage_connections directly", async () => {
    const asAdmin = await as(w.admin, (c) => c.query("SELECT token_ref FROM storage_connections"));
    expect(asAdmin.rowCount).toBe(1);
    for (const u of [w.lead, w.auditor, w.tLead, w.contrib]) {
      const r = await as(u, (c) => c.query("SELECT token_ref FROM storage_connections"));
      expect(r.rowCount, u).toBe(0);
    }
  });

  it("ignores a connection that is revoked or in error", async () => {
    for (const status of ["revoked", "error"]) {
      const w3 = await makeWorld();
      await connect(w3.orgA, "ref-w3", status);
      expect((await creds(w3.contrib)).rowCount, status).toBe(0);
    }
  });

  it("only offers a connection for the provider the org has actually chosen", async () => {
    const w4 = await makeWorld(); // orgs default to google_drive
    await connect(w4.orgA, "ref-sp", "active", "sharepoint"); // a SharePoint connection exists, but the org uses Drive
    expect((await creds(w4.contrib)).rowCount).toBe(0);
    await adminPool.query("UPDATE orgs SET storage_provider = 'sharepoint' WHERE id = $1", [w4.orgA]);
    const r = await creds(w4.contrib);
    expect(r.rows[0].out_provider).toBe("sharepoint");
  });
});

describe("storage_connection_flag_revoked", () => {
  let w: World; let conn: string;
  beforeAll(async () => {
    w = await makeWorld();
    conn = await connect(w.orgA, "ref-flag");
  });
  const flag = (userId: string | null, id: string) =>
    userId
      ? as(userId, (c) => c.query("SELECT storage_connection_flag_revoked($1) AS f", [id])).then((r) => r.rows[0].f as boolean)
      : withoutUser(appPool, (c) => c.query("SELECT storage_connection_flag_revoked($1) AS f", [id])).then((r) => r.rows[0].f as boolean);
  const status = async (id: string) => (await adminPool.query("SELECT status, token_ref FROM storage_connections WHERE id = $1", [id])).rows[0];

  it("cannot be used by someone outside the org, or by nobody at all", async () => {
    expect(await flag(w.adminB, conn)).toBe(false);
    expect(await flag(w.tLeadB, conn)).toBe(false);
    expect(await flag(null, conn)).toBe(false);
    expect((await status(conn)).status).toBe("active");
  });

  it("a user of the org can flag its connection revoked, and the audit entry names THEM", async () => {
    expect(await flag(w.contrib, conn)).toBe(true);
    const s = await status(conn);
    expect(s.status).toBe("revoked");
    expect(s.token_ref).toBe("ref-flag"); // it only moves the status — the credential itself is untouched

    const log = await adminPool.query(
      "SELECT actor_id, entity_id, change FROM audit_log WHERE org_id = $1 AND action = 'org.storage_revoked'", [w.orgA]);
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0].actor_id).toBe(w.contrib);
    expect(log.rows[0].entity_id).toBe(conn);
  });

  it("is a one-way, once-only step: a second call changes nothing and logs nothing more", async () => {
    expect(await flag(w.admin, conn)).toBe(false);
    const log = await adminPool.query("SELECT count(*)::int AS n FROM audit_log WHERE org_id = $1 AND action = 'org.storage_revoked'", [w.orgA]);
    expect(log.rows[0].n).toBe(1);
  });

  it("keeps the audit log's hash chain intact", async () => {
    const r = await adminPool.query("SELECT verify_audit_chain($1) AS bad", [w.orgA]);
    expect(r.rows[0].bad).toBeNull(); // null = no broken link found
  });

  it("an unknown connection id is simply not flagged", async () => {
    expect(await flag(w.admin, "00000000-0000-0000-0000-000000000000")).toBe(false);
  });
});
