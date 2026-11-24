import { Client } from "pg";
import { ensureAppRole, migrate } from "./migrate.ts";
import { assertNotPlaceholderPassword, passwordInDatabaseUrl } from "../secretsCheck.ts";
import { databaseHint } from "./failureHints.ts";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

async function main() {
  const databaseUrl = required("DATABASE_URL");
  // Before touching the database: don't set it up with the passwords that are published in .env.example.
  assertNotPlaceholderPassword("The database password (POSTGRES_PASSWORD)", passwordInDatabaseUrl(databaseUrl));
  assertNotPlaceholderPassword("APP_DB_PASSWORD", process.env.APP_DB_PASSWORD);
  const client = new Client({ connectionString: databaseUrl });
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
  const hint = databaseHint(e);
  if (hint) console.error(`\n${hint}`);
  process.exit(1);
});
