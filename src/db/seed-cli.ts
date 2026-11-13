import { Client } from "pg";
import { seedPlatformTemplate } from "./seed.ts";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

async function main() {
  const client = new Client({ connectionString: required("DATABASE_URL") });
  await client.connect();
  try {
    const id = await seedPlatformTemplate(client);
    console.log("Platform control template ready:", id);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("Seeding failed:", (e as Error).message);
  process.exit(1);
});
