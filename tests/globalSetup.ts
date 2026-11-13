import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Client } from "pg";
import { ensureAppRole, migrate } from "../src/db/migrate";
import { seedPlatformTemplate } from "../src/db/seed";

const PORT = 54329;
// The embedded database comes as one npm package per platform (linux-x64, darwin-arm64, windows-x64, ...); npm installs
// only the one for this machine. (Only linux-x64 has been run by the author; the other names follow the package's own.)
const PLATFORM = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const EXE = process.platform === "win32" ? ".exe" : "";
const BIN = path.resolve(`node_modules/@embedded-postgres/${PLATFORM}/native/bin`);
const DATA = path.join(os.tmpdir(), "portal-pg-data");
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

function run(cmd: string, args: string[]) {
  // Postgres refuses to run as root, so drop to an unprivileged user when the sandbox runs as root.
  if (isRoot) return execFileSync("runuser", ["-u", "pguser", "--", cmd, ...args], { stdio: "pipe" });
  return execFileSync(cmd, args, { stdio: "pipe" });
}

export async function setup() {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  if (isRoot) execFileSync("chown", ["pguser", DATA]);
  run(path.join(BIN, `initdb${EXE}`), ["-D", DATA, "-U", "postgres", "--auth=trust", "-E", "UTF8"]);
  run(path.join(BIN, `pg_ctl${EXE}`), ["-D", DATA, "-o", `-p ${PORT} -k ${DATA} -c fsync=off -c listen_addresses=127.0.0.1`, "-l", path.join(DATA, "log.txt"), "-w", "start"]);
  const admin = new Client({ host: "127.0.0.1", port: PORT, user: "postgres", database: "postgres" });
  await admin.connect();
  await admin.query("CREATE DATABASE portal_test");
  await admin.end();
  const db = new Client({ host: "127.0.0.1", port: PORT, user: "postgres", database: "portal_test" });
  await db.connect();
  await ensureAppRole(db);
  await migrate(db, process.env.MIGRATIONS_DIR ? path.resolve(process.env.MIGRATIONS_DIR) : undefined);
  await seedPlatformTemplate(db);
  await db.end();
}

export async function teardown() {
  try { run(path.join(BIN, `pg_ctl${EXE}`), ["-D", DATA, "-m", "immediate", "-w", "stop"]); } catch { /* already stopped */ }
}
