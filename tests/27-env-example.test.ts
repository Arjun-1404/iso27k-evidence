import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "../src/config.ts";

/**
 * The first thing a new self-hoster does is `cp .env.example .env` and fill in the blanks. This file pins
 * down that the example, taken exactly as shipped, produces a configuration the server will start with —
 * and that the placeholders a user is told to replace are the only things standing between them and a
 * working install.
 */

const SAVED = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
});

/** Minimal .env parser: KEY=value lines only; comments and blanks ignored (that is how docker compose reads it). */
function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0) out[t.slice(0, eq)] = t.slice(eq + 1);
  }
  return out;
}

const exampleVars = () => parseEnvFile(resolve(__dirname, "../.env.example"));

/** Start from a clean slate so the developer's own shell can't make this pass or fail by accident. */
function clean() {
  for (const k of ["DATABASE_URL", "PORT", "JWT_SECRET", "APP_BASE_URL", "SECRET_ENCRYPTION_KEY",
    "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REDIRECT_URI", "CORS_ALLOWED_ORIGINS"]) delete process.env[k];
}

describe(".env.example", () => {
  it("is loadable exactly as shipped (Google Drive off, nothing half-configured)", () => {
    clean();
    Object.assign(process.env, exampleVars(), { DATABASE_URL: "postgres://x@localhost/x" });
    const c = loadConfig();
    expect(c.googleOAuth).toBeUndefined();
    expect(c.secretEncryptionKey).toBeUndefined();
    expect(c.appBaseUrl).toBe("http://localhost:5173");
    // CORS defaults to the frontend's own origin when the example doesn't override it
    expect(c.corsAllowedOrigins).toEqual(["http://localhost:5173"]);
  });

  it("sets every variable the docker-compose api service marks as required", () => {
    const v = exampleVars();
    for (const name of ["POSTGRES_PASSWORD", "APP_DB_PASSWORD", "JWT_SECRET"]) expect(v[name], name).toBeTruthy();
  });

  it("works with Google Drive switched on once the commented lines are filled in", () => {
    clean();
    Object.assign(process.env, exampleVars(), {
      DATABASE_URL: "postgres://x@localhost/x",
      GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "secret",
      GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:3000/oauth/google/callback",
      SECRET_ENCRYPTION_KEY: "0".repeat(64),
    });
    expect(loadConfig().googleOAuth?.clientId).toBe("id");
  });

});

describe("what docker compose passes when the Google variables are left unset", () => {
  it("treats empty strings as 'not configured', not as a half-configured client", () => {
    // Compose substitutes ${VAR:-} with an empty string, so process.env sees "" rather than undefined.
    clean();
    Object.assign(process.env, {
      DATABASE_URL: "postgres://x@localhost/x", JWT_SECRET: "j",
      GOOGLE_OAUTH_CLIENT_ID: "", GOOGLE_OAUTH_CLIENT_SECRET: "", GOOGLE_OAUTH_REDIRECT_URI: "", SECRET_ENCRYPTION_KEY: "",
    });
    const c = loadConfig();
    expect(c.googleOAuth).toBeUndefined();
    expect(c.secretEncryptionKey).toBeUndefined();
  });
});

/** Every environment variable src/config.ts reads — found by looking at the source, so a new setting that
 *  someone forgets to document or pass through docker compose fails here instead of silently not working. */
function configVariables(): string[] {
  const src = readFileSync(resolve(__dirname, "../src/config.ts"), "utf8");
  const names = new Set<string>();
  for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/"([A-Z][A-Z0-9_]{3,})"/g)) names.add(m[1]);
  return [...names].sort();
}

describe("deployment files stay consistent with the code", () => {
  const compose = () => parseYaml(readFileSync(resolve(__dirname, "../docker-compose.yml"), "utf8"));
  const pkg = () => JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8"));

  it("finds the settings we expect (so the scan itself is trustworthy)", () => {
    const vars = configVariables();
    for (const must of ["DATABASE_URL", "JWT_SECRET", "SMTP_HOST", "EMAIL_FROM", "CLAMD_HOST", "GOOGLE_OAUTH_CLIENT_ID", "SECRET_ENCRYPTION_KEY", "CORS_ALLOWED_ORIGINS"]) {
      expect(vars, must).toContain(must);
    }
  });

  it("docker-compose.yml is valid YAML with the services the README promises", () => {
    // (An unquoted ': ' inside a value once made this file unreadable by docker compose itself.)
    const c = compose();
    for (const svc of ["db", "migrate", "api", "frontend"]) expect(Object.keys(c.services), svc).toContain(svc);
  });

  it("ClamAV and the local mail catcher are opt-in, not part of a plain `docker compose up`", () => {
    const c = compose();
    expect(c.services.clamav.profiles).toEqual(["scanning"]);
    expect(c.services.mailpit.profiles).toEqual(["dev-mail"]);
    for (const svc of ["db", "migrate", "api", "frontend"]) expect(c.services[svc].profiles, svc).toBeUndefined();
  });

  it("every setting the server reads reaches the api container", () => {
    const passed = Object.keys(compose().services.api.environment);
    for (const name of configVariables()) expect(passed, `${name} is read by config.ts but not passed to the api service in docker-compose.yml`).toContain(name);
  });

  it("every setting the server reads is documented in .env.example (the ones compose fills in itself aside)", () => {
    const text = readFileSync(resolve(__dirname, "../.env.example"), "utf8");
    for (const name of configVariables().filter((n) => !["DATABASE_URL", "PORT"].includes(n))) {
      expect(text, `${name} is not mentioned in .env.example`).toContain(name);
    }
  });

  it("the packages the production image runs on are real dependencies, not dev-only ones", () => {
    // `npm ci --omit=dev` is what the image installs: a runtime package listed under devDependencies is
    // simply absent there ("tsx: not found" on the first start).
    const { dependencies, devDependencies } = pkg();
    for (const name of ["tsx", "nodemailer", "express", "pg", "bcryptjs", "jsonwebtoken", "zod"]) {
      expect(Object.keys(dependencies), name).toContain(name);
      expect(Object.keys(devDependencies), `${name} should not also be a devDependency`).not.toContain(name);
    }
    for (const name of ["smtp-server", "vitest", "yaml", "supertest", "embedded-postgres"]) {
      expect(Object.keys(dependencies), `${name} is test-only and shouldn't ship in the image`).not.toContain(name);
    }
  });

  it("the Dockerfile copies what the server needs and runs it with the installed tsx", () => {
    const d = readFileSync(resolve(__dirname, "../Dockerfile"), "utf8");
    for (const dir of ["src", "db"]) expect(d, dir).toMatch(new RegExp(`COPY ${dir} \\./${dir}`));
    expect(d).toMatch(/CMD \["npx", "tsx", "src\/server\.ts"\]/);
    expect(d).not.toContain("npm install --no-save"); // the old workaround that never actually installed tsx
  });
});
