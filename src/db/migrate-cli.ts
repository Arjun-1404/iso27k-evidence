import { Client } from "pg";
import { ensureAppRole, migrate } from "./migrate.ts";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

async function main() {
  const client = new Client({ connectionString: required("DATABASE_URL") });
  await client.connect();
  try {
    await ensureAppRole(client, process.env.APP_DB_PASSWORD);
    const ran = await migrate(client);
    if (ran.length === 0) console.log("Database already up to date — no migrations to apply.");
    else console.log("Applied:", ran.join(", "));
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("Migration failed:", (e as Error).message);
  process.exit(1);
});
