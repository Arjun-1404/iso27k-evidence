import type { Pool } from "pg";
import { withUser } from "../db/pool.ts";
import { AppError, mapDbError } from "../errors.ts";
import type { SecretStore } from "../auth/secretStore.ts";
import { EmailDeliveryError } from "../email/types.ts";
import { SmtpEmailSender } from "../email/smtp.ts";
import { ClamAvScanner } from "../scan/clamav.ts";
import { EICAR_TEST_STRING, ScannerUnavailableError } from "../scan/types.ts";
import { confirmPassword, lookupAccount } from "./auth.ts";
import { getStatus, verifySecondStep } from "./mfa.ts";
import type { Notifier } from "./notices.ts";
import { loadStoredRows, openSecrets, SecretsUnreadable, type RuntimeSettings } from "../settings/runtime.ts";
import { SECRET_NAMES, type EnvSettings, type Group, type SecretMap, type Source } from "../settings/types.ts";
import { describeSettings, parseGroup, SettingsInputError } from "../settings/validate.ts";

/**
 * Server settings from the web app: the mail server, the malware scanner and the Google app details.
 *
 * Who and how:
 *  - Only the owner of the installation (see migration 012). Everyone else is told no, whatever they send.
 *  - Saving or removing a group asks the owner to confirm with their password (and a code, if they use two-step
 *    sign-in), the way changing a password does. The mail settings decide where reset links are sent, so a borrowed
 *    browser session alone must not be able to change them.
 *  - Secrets are write-only: stored encrypted, never sent back. Leaving a secret field blank keeps what is stored.
 *  - A group the server's environment provides is locked: the environment wins, and the page says so.
 *  - Typing mistakes are reported BEFORE the password and code are checked, so a typo never spends a one-time code.
 */

export interface PlatformDeps {
  pool: Pool;
  store?: SecretStore;
  runtime: RuntimeSettings;
  /** What the server's own environment provides (those groups are locked here). */
  env: EnvSettings;
}

export interface Reauth { password: string; code?: string }

export interface GroupView {
  group: Group;
  source: Source;
  /** True when the server's environment provides this group, so it can't be changed from the web app. */
  locked: boolean;
  /** The non-secret values in force, or null when the group is not set up. */
  values: Record<string, string | number | null> | null;
  /** Which secret fields have a value stored. The values themselves are never sent. */
  secretsSet: string[];
  updatedAt: string | null;
  updatedBy: string | null;
  /** Why saved settings are being ignored, if they are. */
  problem: string | null;
}

export interface SettingsView {
  /** False when the server has no SECRET_ENCRYPTION_KEY: groups that hold a secret can't be saved without it. */
  canStoreSecrets: boolean;
  /** Whether the owner uses two-step sign-in, i.e. whether saving needs a code too. */
  needsCode: boolean;
  groups: GroupView[];
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) { if (e instanceof AppError) throw e; throw mapDbError(e); }
}

export const isOwner = (pool: Pool, userId: string) =>
  run(() => withUser(pool, userId, (c) => c.query("SELECT platform_is_owner() AS o").then((r) => r.rows[0].o as boolean)));

async function requireOwner(pool: Pool, userId: string) {
  if (!(await isOwner(pool, userId))) {
    throw new AppError("Only the owner of this installation can see or change the server settings.", 403, "FORBIDDEN_ROLE");
  }
}

const envLocked = (group: Group) => new AppError(
  "These settings come from the server's own configuration (its .env file), so they can't be changed here. Change them there and restart the server.",
  409, "SETTING_LOCKED");

interface ReadRow { out_key: Group; out_config: Record<string, unknown>; out_secrets_set: string[]; out_updated_at: Date; out_updated_by: string | null }

/** The settings page's view of things, from the database as it is right now. */
export async function getSettings(d: PlatformDeps, userId: string): Promise<SettingsView> {
  d.runtime.invalidate(); // the page should show what is true now, not what was cached a few seconds ago
  return buildView(d, userId);
}

async function buildView(d: PlatformDeps, userId: string): Promise<SettingsView> {
  const rows = await run(() => withUser(d.pool, userId, (c) => c.query("SELECT * FROM platform_settings_read()").then((r) => r.rows as ReadRow[])));
  const eff = await d.runtime.current();
  const needsCode = (await getStatus(d.pool, d.store, userId)).enabled;
  const groups = (["email", "scanner", "google"] as const).map((group): GroupView => {
    const state = eff[group];
    const row = rows.find((r) => r.out_key === group);
    return {
      group,
      source: state.source,
      locked: state.source === "environment",
      values: state.settings ? describeSettings(group, state.settings) : null,
      secretsSet: state.source === "environment" ? [] : (row?.out_secrets_set ?? []),
      updatedAt: state.source === "panel" && row ? row.out_updated_at.toISOString() : null,
      updatedBy: state.source === "panel" ? (row?.out_updated_by ?? null) : null,
      problem: state.problem ?? null,
    };
  });
  return { canStoreSecrets: !!d.store, needsCode, groups };
}

/** Password first (counted toward the lock-out like any wrong password), then a code if two-step sign-in is on. */
async function reauthenticate(d: PlatformDeps, userId: string, reauth: Reauth, notify?: Notifier) {
  const twoStep = (await getStatus(d.pool, d.store, userId)).enabled;
  if (twoStep && !reauth.code) {
    throw new AppError("Enter a code from your authenticator app (or one of your recovery codes) to change the server settings.", 400, "MFA_CODE_REQUIRED");
  }
  await confirmPassword(d.pool, userId, reauth.password);
  if (twoStep) await verifySecondStep(d.pool, d.store, userId, reauth.code!, 403, notify);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export async function saveGroup(d: PlatformDeps, userId: string, group: Group, input: Record<string, unknown>, reauth: Reauth, notify?: Notifier): Promise<SettingsView> {
  await requireOwner(d.pool, userId);
  if (d.env[group]) throw envLocked(group);
  if (SECRET_NAMES[group].length > 0 && !d.store) {
    throw new AppError("This server has no SECRET_ENCRYPTION_KEY, so it can't store passwords or secrets safely. Set one in the server's .env file (openssl rand -hex 32) and restart.", 503, "SETTINGS_NEED_ENCRYPTION_KEY");
  }

  const stored = (await loadStoredRows(d.pool)).find((r) => r.out_key === group);
  let existing: SecretMap = {};
  try { existing = openSecrets(d.store, stored?.out_secret_enc ?? null); } catch (e) { if (!(e instanceof SecretsUnreadable)) throw e; }

  let parsed;
  try { parsed = parseGroup(group, input, existing); } catch (e) {
    if (e instanceof SettingsInputError) throw new AppError(e.message, 400, "VALIDATION");
    throw e;
  }

  await reauthenticate(d, userId, reauth, notify);

  const secretNames = Object.keys(parsed.secrets);
  const enc = secretNames.length > 0 ? d.store!.encrypt(JSON.stringify(parsed.secrets)) : null;
  // For the audit log: which FIELDS changed, never what they changed to.
  const changed = new Set<string>();
  for (const [k, v] of Object.entries(parsed.config)) if (!same(v, stored?.out_config?.[k])) changed.add(k);
  for (const k of Object.keys(stored?.out_config ?? {})) if (!(k in parsed.config)) changed.add(k);
  for (const k of secretNames) if (parsed.secrets[k] !== existing[k]) changed.add(k);
  for (const k of Object.keys(existing)) if (!(k in parsed.secrets)) changed.add(k);

  await run(() => withUser(d.pool, userId, (c) =>
    c.query("SELECT platform_setting_save($1,$2::jsonb,$3,$4::text[],$5::text[])", [group, JSON.stringify(parsed.config), enc, secretNames, [...changed]])));
  d.runtime.invalidate(); // the running server must use the new values from the very next email, upload or Google sign-in
  return buildView(d, userId);
}

export async function clearGroup(d: PlatformDeps, userId: string, group: Group, reauth: Reauth, notify?: Notifier): Promise<SettingsView> {
  await requireOwner(d.pool, userId);
  if (d.env[group]) throw envLocked(group);
  await reauthenticate(d, userId, reauth, notify);
  await run(() => withUser(d.pool, userId, (c) => c.query("SELECT platform_setting_clear($1)", [group])));
  d.runtime.invalidate();
  return buildView(d, userId);
}

/** Sends a short message to the owner's OWN address through the mail server in force, to prove it works. Never to anyone else. */
export async function sendTestEmail(d: PlatformDeps, userId: string): Promise<{ ok: true; sentTo: string }> {
  await requireOwner(d.pool, userId);
  d.runtime.invalidate();
  const smtp = (await d.runtime.current()).email.settings;
  if (!smtp) throw new AppError("No mail server is set up yet. Save the email settings first.", 409, "NOT_CONFIGURED");
  const me = await lookupAccount(d.pool, userId);
  if (!me) throw new AppError("You don't have access to do that.", 403, "FORBIDDEN");
  try {
    await new SmtpEmailSender(smtp).send({
      to: [me.email],
      subject: "Evidence Portal: test email",
      text: "This is a test message from your Evidence Portal. If you are reading it, the mail server settings work.\n\nNothing else needs doing.",
    });
  } catch (e) {
    if (e instanceof EmailDeliveryError) throw new AppError(e.message, 502, "EMAIL_TEST_FAILED");
    throw new AppError("The test email could not be sent.", 502, "EMAIL_TEST_FAILED");
  }
  return { ok: true, sentTo: me.email };
}

/** Connects to the malware scanner in force and checks it really detects the standard (harmless) antivirus test string. */
export async function checkScanner(d: PlatformDeps, userId: string): Promise<{ ok: true }> {
  await requireOwner(d.pool, userId);
  d.runtime.invalidate();
  const settings = (await d.runtime.current()).scanner.settings;
  if (!settings) throw new AppError("No malware scanner is set up yet. Save the scanner settings first.", 409, "NOT_CONFIGURED");
  const scanner = new ClamAvScanner(settings);
  let verdict;
  try {
    await scanner.ping();
    verdict = await scanner.scan("eicar-test.txt", Buffer.from(EICAR_TEST_STRING));
  } catch (e) {
    if (e instanceof ScannerUnavailableError) throw new AppError(e.message, 502, "SCANNER_TEST_FAILED");
    throw new AppError("The scanner could not be checked.", 502, "SCANNER_TEST_FAILED");
  }
  if (verdict !== "infected") {
    throw new AppError(
      "The scanner answered, but it did not report the standard antivirus test file as a virus. Its virus signatures may still be downloading (this takes a few minutes after it first starts) — try again shortly.",
      502, "SCANNER_TEST_WEAK");
  }
  return { ok: true };
}
