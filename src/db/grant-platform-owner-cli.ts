import { Client } from "pg";
import { setPlatformOwner } from "./platformOwner.ts";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

/**
 * Makes an organisation admin the owner of the installation (and removes ownership from anyone else).
 * Usage: DATABASE_URL=... ADMIN_EMAIL=admin@acme.example npm run db:grant-platform-owner
 * Connects as the database owner, like db:bootstrap-admin.
 */
async function main() {
  const client = new Client({ connectionString: required("DATABASE_URL") });
  await client.connect();
  try {
    const r = await setPlatformOwner(client, required("ADMIN_EMAIL"));
    console.log(`${r.email} is now the owner of this installation.`);
    if (r.previousOwners.length > 0) console.log(`No longer the owner: ${r.previousOwners.join(", ")}.`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("Failed:", (e as Error).message);
  process.exit(1);
});
