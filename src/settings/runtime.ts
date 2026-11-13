import type { Pool } from "pg";
import { withoutUser } from "../db/pool.ts";
import type { SecretStore } from "../auth/secretStore.ts";
import { GROUPS, type EffectiveSettings, type EnvSettings, type Group, type GroupState, type SecretMap } from "./types.ts";
import { parseGroup } from "./validate.ts";

/** A stored settings row as the running server receives it: the non-secret values and the secrets still encrypted. */
export interface StoredRow { out_key: string; out_config: Record<string, unknown>; out_secret_enc: string | null }

export const loadStoredRows = (pool: Pool): Promise<StoredRow[]> =>
  withoutUser(pool, (c) => c.query("SELECT * FROM platform_settings_load()")).then((r) => r.rows as StoredRow[]);

export class SecretsUnreadable extends Error {
  constructor() { super("The saved secrets can't be decrypted."); this.name = "SecretsUnreadable"; }
}

/** Opens a row's encrypted secrets. Throws SecretsUnreadable if there is no key, the key has changed, or the data is damaged. */
export function openSecrets(store: SecretStore | undefined, enc: string | null): SecretMap {
  if (enc === null) return {};
  if (!store) throw new SecretsUnreadable();
  try {
    const parsed: unknown = JSON.parse(store.decrypt(enc));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("shape");
    const out: SecretMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v !== "string") throw new Error("shape");
      out[k] = v;
    }
    return out;
  } catch {
    throw new SecretsUnreadable();
  }
}

/** The server's settings right now, whichever place each comes from. */
export interface RuntimeSettings {
  current(): Promise<EffectiveSettings>;
  /** Forget what was loaded, so the next call reads the database again (called after the owner saves). */
  invalidate(): void;
}

export interface RuntimeOptions {
  pool: Pool;
  secretStore?: SecretStore;
  /** What the server's environment provides. For a group that has it, the environment wins and the database is not consulted. */
  env: EnvSettings;
  /** How long a load is reused. Another running copy of the server sees a change within this time. Default 5 seconds. */
  ttlMs?: number;
  now?: () => number;
  warn?: (line: string) => void;
}

const STALE_WARNING_EVERY_MS = 60_000;

/**
 * Loads the settings in effect and keeps them for a few seconds, so a request doesn't cost a database round trip.
 *
 *  - The environment wins: a group the server's environment provides is used as it is, and the web app can't change it.
 *  - Nothing is ever guessed. A saved group that can't be decrypted or no longer validates counts as "not set up", with a
 *    reason the settings page can show, rather than being used half-way.
 *  - If the database can't be reached, the last values that loaded fine keep being used (a mail server doesn't stop
 *    working because the database blinked). With nothing loaded yet, the call fails — callers treat that as "can't
 *    send / can't scan", never as "not configured".
 */
export function createRuntimeSettings(opts: RuntimeOptions): RuntimeSettings {
  const ttl = opts.ttlMs ?? 5_000;
  const now = opts.now ?? Date.now;
  const warn = opts.warn ?? ((l: string) => console.warn(l));
  let fresh: { at: number; value: EffectiveSettings } | undefined;
  let lastGood: EffectiveSettings | undefined;
  let inflight: Promise<EffectiveSettings> | undefined;
  let generation = 0;
  let lastStaleWarning = -Infinity;
  const warnedProblems = new Set<string>();

  async function build(): Promise<EffectiveSettings> {
    const { env } = opts;
    const rows = GROUPS.every((g) => env[g]) ? [] : await loadStoredRows(opts.pool);
    const out: Partial<Record<Group, GroupState<unknown>>> = {};
    for (const group of GROUPS) {
      const fromEnv = env[group];
      if (fromEnv) { out[group] = { source: "environment", settings: fromEnv }; continue; }
      const row = rows.find((r) => r.out_key === group);
      if (!row) { out[group] = { source: "none" }; continue; }
      try {
        const parsed = parseGroup(group, row.out_config, openSecrets(opts.secretStore, row.out_secret_enc));
        out[group] = { source: "panel", settings: parsed.settings };
      } catch (e) {
        const problem = e instanceof SecretsUnreadable
          ? "What was saved here can't be read: the server's encryption key is missing or has changed. Enter the settings again."
          : "What was saved here is no longer valid. Enter the settings again.";
        out[group] = { source: "none", problem };
        if (!warnedProblems.has(`${group}:${problem}`)) {
          warnedProblems.add(`${group}:${problem}`);
          warn(`[settings] the saved ${group} settings can't be used and are being ignored. ${problem}`);
        }
      }
    }
    return out as EffectiveSettings;
  }

  return {
    async current() {
      if (fresh && now() - fresh.at < ttl) return fresh.value;
      if (inflight) return inflight;
      const started = generation;
      const attempt = (async () => {
        try {
          const value = await build();
          lastGood = value;
          if (started === generation) fresh = { at: now(), value };
          return value;
        } catch (e) {
          if (lastGood) {
            if (now() - lastStaleWarning >= STALE_WARNING_EVERY_MS) {
              lastStaleWarning = now();
              warn("[settings] the server settings could not be reloaded from the database; the last known values are still in use.");
            }
            // Try again soon rather than on every request.
            if (started === generation) fresh = { at: now() - ttl + 1_000, value: lastGood };
            return lastGood;
          }
          throw e;
        } finally {
          inflight = undefined;
        }
      })();
      inflight = attempt;
      return attempt;
    },
    invalidate() {
      generation++;
      fresh = undefined;
    },
  };
}

/** The group names the environment provides, for the settings page's "locked" state. */
export const envGroups = (env: EnvSettings): Group[] => GROUPS.filter((g) => env[g] !== undefined);
