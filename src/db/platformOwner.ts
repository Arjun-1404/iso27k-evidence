import type { Client, Pool, PoolClient } from "pg";

type Db = Client | Pool | PoolClient;

export interface OwnerChange { userId: string; email: string; previousOwners: string[] }

/**
 * Makes one organisation admin the (single) owner of the installation: the person who can enter the mail server, the
 * malware scanner and the Google app details in the web app. Everyone else loses the flag, so there is never any doubt
 * about who has this power. This is what to run if the owner leaves, or loses access and an administrator has to be
 * promoted. It connects as the database owner (like the bootstrap script) on purpose: the application's own role can't
 * do this, so no bug or stolen session in the web app can hand it out.
 */
export async function setPlatformOwner(db: Db, email: string): Promise<OwnerChange> {
  const target = await db.query(
    "SELECT id, email, role, status FROM users WHERE lower(email) = lower($1)", [email.trim()]);
  const u = target.rows[0] as { id: string; email: string; role: string; status: string } | undefined;
  if (!u) throw new Error(`No user with the email ${email}.`);
  if (u.role !== "org_admin") throw new Error(`${u.email} is not an organisation admin. Only an organisation admin can own the installation.`);
  if (u.status === "disabled") throw new Error(`${u.email} is disabled. Enable the account first.`);

  const before = await db.query("SELECT email FROM users WHERE is_platform_owner AND id <> $1 ORDER BY email", [u.id]);
  await db.query("UPDATE users SET is_platform_owner = (id = $1) WHERE is_platform_owner OR id = $1", [u.id]);
  return { userId: u.id, email: u.email, previousOwners: before.rows.map((r) => r.email as string) };
}
