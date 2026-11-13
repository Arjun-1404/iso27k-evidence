import fs from "node:fs";
import path from "node:path";
import type { Client } from "pg";

interface CatalogFile {
  framework: string; version: string; name: string;
  controls: { kind: string; section: string; control_ref: string; title: string; default_evidence: string; sort_order: number }[];
}

/** Loads the platform-default control template (org_id NULL). Safe to run repeatedly. */
export async function seedPlatformTemplate(client: Client, file = path.resolve("db/seed/iso27001-2022.json")): Promise<string> {
  const cat = JSON.parse(fs.readFileSync(file, "utf8")) as CatalogFile;
  const existing = await client.query(
    "SELECT id FROM control_templates WHERE org_id IS NULL AND framework = $1 AND version = $2", [cat.framework, cat.version]);
  if (existing.rows.length) return existing.rows[0].id as string;
  await client.query("BEGIN");
  try {
    const t = await client.query(
      "INSERT INTO control_templates (org_id, framework, version, name) VALUES (NULL, $1, $2, $3) RETURNING id",
      [cat.framework, cat.version, cat.name]);
    const id = t.rows[0].id as string;
    for (const c of cat.controls) {
      await client.query(
        `INSERT INTO template_controls (template_id, kind, section, control_ref, title, default_evidence, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, c.kind, c.section, c.control_ref, c.title, c.default_evidence, c.sort_order]);
    }
    await client.query("COMMIT");
    return id;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}
