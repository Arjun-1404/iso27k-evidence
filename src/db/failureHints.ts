/**
 * Plain-language help for the database errors that people actually meet when they set the portal up, shown under the
 * raw error by the one-off database commands (db:migrate, db:bootstrap-admin, db:grant-platform-owner).
 * Returns null when there is nothing more to say than the error itself.
 */
export function databaseHint(e: unknown): string | null {
  const code = (e as { code?: unknown } | null)?.code;

  // 28P01 = invalid_password. In Docker the usual cause is not a typo: PostgreSQL stores the password it is first started
  // with in its data volume and never reads POSTGRES_PASSWORD again, so a regenerated .env no longer matches it.
  if (code === "28P01") {
    return [
      "The database refused the password in .env. The database keeps the password it was first created with: changing",
      "POSTGRES_PASSWORD in .env afterwards does not change it. This usually means .env was regenerated (or the project was",
      "unzipped again into a folder of the same name) after the database already existed.",
      "",
      "Either put the previous .env back, or, if the database holds nothing you need, start it again from empty:",
      "  docker compose down -v      # deletes the database",
      "  docker compose up -d",
      "Without Docker, set the postgres user's password to the one in .env instead:",
      "  sudo -u postgres psql -c \"ALTER USER postgres PASSWORD '<POSTGRES_PASSWORD from .env>';\"",
    ].join("\n");
  }
  return null;
}
