import { describe, it, expect, afterAll } from "vitest";
import { adminPool, appPool } from "./helpers";

describe("database bootstrap", () => {
  afterAll(async () => { await adminPool.end(); await appPool.end(); });

  it("applies the migration and seeds the ISO 27001:2022 template (24 clauses + 93 Annex A controls)", async () => {
    const r = await adminPool.query(
      "SELECT count(*) FILTER (WHERE kind='clause')::int AS clauses, count(*) FILTER (WHERE kind='annex')::int AS annex FROM template_controls");
    expect(r.rows[0]).toEqual({ clauses: 24, annex: 93 });
  });

  it("enables row-level security on every application table", async () => {
    const r = await adminPool.query(
      "SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity AND relname <> 'schema_migrations'");
    expect(r.rows).toEqual([]);
  });

  it("the application role is not a superuser and cannot bypass row-level security", async () => {
    const r = await adminPool.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='portal_app'");
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});
