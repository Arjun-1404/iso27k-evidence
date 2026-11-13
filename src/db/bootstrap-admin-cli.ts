import { Client } from "pg";
import { generateInviteToken } from "../auth/inviteToken.ts";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

/**
 * Creates the first org and its first admin user directly, bypassing the normal application layer —
 * there is no public "sign up" endpoint by design (every other user is invited by someone who already
 * has an account), so the very first account on a fresh instance has to come from somewhere. This
 * connects as the database owner on purpose: it's a one-time operation run by whoever controls the
 * server, not something the application itself should ever be able to do.
 *
 * Usage: DATABASE_URL=... ORG_NAME="Acme Audits" ORG_DOMAIN=acme.example ADMIN_EMAIL=admin@acme.example \
 *        npx tsx src/db/bootstrap-admin-cli.ts
 */
async function main() {
  const orgName = required("ORG_NAME");
  const orgDomain = required("ORG_DOMAIN");
  const adminEmail = required("ADMIN_EMAIL");
  const appBaseUrl = (process.env.APP_BASE_URL ?? "http://localhost:5173").replace(/\/$/, "");

  const client = new Client({ connectionString: required("DATABASE_URL") });
  await client.connect();
  try {
    const existing = await client.query("SELECT 1 FROM users WHERE lower(email) = lower($1)", [adminEmail]);
    if ((existing.rowCount ?? 0) > 0) {
      console.error(`A user with the email ${adminEmail} already exists. Nothing to do.`);
      process.exit(1);
    }

    const org = await client.query("INSERT INTO orgs (name, allowed_domains) VALUES ($1, $2) RETURNING id", [orgName, [orgDomain]]);
    const orgId = org.rows[0].id as string;
    const invite = generateInviteToken();
    const user = await client.query(
      "INSERT INTO users (org_id, email, role, status, invite_token_hash, invite_token_expires_at, is_platform_owner) " +
      // The first administrator of a fresh installation is its owner: the one person who can enter the mail server, scanner
      // and Google app details in the web app. Only if nobody is the owner yet (a second organisation's admin is not).
      "VALUES ($1,$2,'org_admin','invited',$3,$4, NOT EXISTS (SELECT 1 FROM users WHERE is_platform_owner)) RETURNING id",
      [orgId, adminEmail, invite.tokenHash, invite.expiresAt],
    );

    console.log(`Created org "${orgName}" (${orgId}) and admin user ${adminEmail} (${user.rows[0].id}).`);
    const owner = await client.query("SELECT is_platform_owner AS o FROM users WHERE id = $1", [user.rows[0].id]);
    console.log(owner.rows[0].o
      ? "They are the owner of this installation: after signing in they can set up email, malware scanning and Google Drive under Server settings."
      : "This installation already has an owner, so they are an ordinary organisation admin.");
    console.log("\nSet their password at:");
    console.log(`${appBaseUrl}/accept-invite?token=${invite.token}`);
    console.log("\nThis link expires in 7 days.");
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("Bootstrap failed:", (e as Error).message);
  process.exit(1);
});
