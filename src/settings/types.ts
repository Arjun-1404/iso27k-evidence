import type { SmtpSettings } from "../email/smtp.ts";
import type { ClamAvSettings } from "../scan/clamav.ts";
import type { GoogleOAuthSettings } from "../config.ts";

/**
 * The three things an installation's owner can set up from the web app instead of the server's environment file.
 * The DATABASE_URL, JWT_SECRET and SECRET_ENCRYPTION_KEY deliberately stay outside: the last one is what unlocks every
 * secret stored in the database, so it cannot itself be kept there.
 */
export const GROUPS = ["email", "scanner", "google"] as const;
export type Group = (typeof GROUPS)[number];
export const isGroup = (v: unknown): v is Group => typeof v === "string" && (GROUPS as readonly string[]).includes(v);

/** Where a group's values come from. The server's environment wins over the web app, and then can't be edited there. */
export type Source = "environment" | "panel" | "none";

/** The secret fields each group has (write-only: never sent back to a browser). */
export const SECRET_NAMES: Record<Group, readonly string[]> = { email: ["password"], scanner: [], google: ["clientSecret"] };

export type SecretMap = Record<string, string>;

export interface GroupState<T> {
  source: Source;
  /** The settings in force; absent when the group is not set up, or when what was saved can't be used. */
  settings?: T;
  /** Set when something is saved in the web app but can't be used (the encryption key changed, or the data is invalid). */
  problem?: string;
}

export interface EffectiveSettings {
  email: GroupState<SmtpSettings>;
  scanner: GroupState<ClamAvSettings>;
  google: GroupState<GoogleOAuthSettings>;
}

/** What the server's own environment already provides (see config.ts). */
export interface EnvSettings {
  email?: SmtpSettings;
  scanner?: ClamAvSettings;
  google?: GoogleOAuthSettings;
}
