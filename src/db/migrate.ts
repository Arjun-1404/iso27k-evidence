import fs from "node:fs";
import path from "node:path";
import type { Client } from "pg";

const APP_ROLE = "portal_app";

/** Creates the low-privilege application role. The app must NEVER connect as the table owner or a superuser. */
export async function ensureAppRole(client: Client, password?: string): Promise<void> {
  const { rows } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [APP_ROLE]);
  if (rows.length === 0) {
    await client.query(`CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
  }
  if (password) {
    const escaped = password.replace(/'/g, "''");
    await client.query(`ALTER ROLE ${APP_ROLE} PASSWORD '${escaped}'`);
  }
}

/** Applies every .sql file in order, once. Each migration runs in its own transaction. */
export async function migrate(client: Client, dir = path.resolve("db/migrations")): Promise<string[]> {
  await client.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const applied = new Set((await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name as string));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const ran: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
      await client.query("COMMIT");
      ran.push(f);
    } catch (e) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
    }
  }
  return ran;
}
