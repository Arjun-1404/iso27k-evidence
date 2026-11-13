# Contributing

Thanks for taking a look. This started as a tool for ISO 27001 auditors to collect evidence without
ever taking custody of it — evidence stays in the auditor's own Google Drive or SharePoint; the portal
only tracks what's required and what's been accepted. It's still early, and there's a clear list of
what's real versus stubbed in the two READMEs (`README.md` for the backend, `frontend/README.md` for
the UI) — read those first.

## Getting a dev environment running

The fastest path is Docker Compose — see the Quick Start in `README.md`. For working directly on the
code without Docker, follow **"Manual setup (no Docker)"** in `README.md` (**"Windows (no Docker)"** on Windows — `node scripts/local.mjs` does the database, administrator and start-up steps there): it takes you from a fresh machine to the API
(`npm start`) and the web app (`cd frontend && npm run dev`) running against your own local PostgreSQL. While you are changing
code, `npm run typecheck` and `npx vitest run <test file>` check one thing quickly; `npm run verify` (below) checks everything.

## Checking everything at once

```
cd portal && npm run verify                  # types, all server tests, all web tests, both builds (real and live demo), lint, library audit
cd portal && npm run verify -- --mutation    # the same, plus both deliberate-breakage checks (about an hour)
```

Run this before opening a pull request. Every check is reported on its own line and a failure doesn't stop the
others. `--skip-audit` leaves out the library vulnerability check (it needs internet; it is skipped with a note,
never counted as passed, if the network is unreachable). The same command runs in GitHub Actions
(`.github/workflows/ci.yml`); `.github/workflows/mutation.yml` runs the breakage checks weekly.

## Running the tests

```
cd portal && npm test
```

This starts a real, throwaway PostgreSQL (via the `embedded-postgres` dev dependency — no Docker, no
external service) and runs every test against it. Nothing at the database layer is mocked.

```
cd portal/frontend && npm test
```

Runs the frontend suite against MSW-mocked API responses shaped like the real API's actual JSON.

## If you touch a migration, a row-level-security policy, or security-relevant code

Run the mutation-testing script:
```
cd portal && python3 scripts/mutation-check.py
```

It deliberately breaks one security rule at a time and checks that the tests actually notice. There are two
lists in the script: `MUTATIONS` (a database rule, changed in a disposable copy of the migrations) and
`SOURCE_MUTATIONS` (application code, changed in a disposable copy of the whole project — your working tree is
never touched). If you add a new rule — a new RLS policy, a trigger check, a constraint, a rate limit, a
permission check — add a breakage for it, and make sure a test catches it. A rule nothing tests for is a rule that
can silently regress.

A breakage counts as caught only if tests really ran and at least one failed; a run that never got as far as running
tests (the test database couldn't start, say) is reported as "BROKEN RUN", never as a success.

Breakages are tagged by the stage that added them (`[013-db]` for a database rule, `[013-src]` for code; closing an
audit cycle is `[close-db]`, `[close-src]` and, in the frontend script, `[close-fe]`), so you can
re-run just one stage's with, for example, `python3 scripts/mutation-check.py 013-src`. Add
`--tests=tests/54-close-audit-cycle-db.test.ts,tests/55-close-audit-cycle-http.test.ts` to run only those test files for
the database breakages while you are developing (a breakage that survives that must be re-run against the full suite). They cover the database rules,
the server code, and the `scripts/` folder (the setup script is copied along with the rest of the project).

A full run takes a good while (every breakage starts its own database; a mutated run stops at its first failing
test, so a caught breakage is quick and only a survivor runs the whole suite). Don't run it at the same time as the
normal tests: they share one throwaway database, and nothing under `src/`, `tests/` or `db/` may change while it
runs, because every breakage is built from the files as they are at that moment. To re-check just one rule after
writing a test for it, pass part of its description or file name; `--exclude=text` leaves some out:
```
python3 scripts/mutation-check.py "expired state"
python3 scripts/mutation-check.py rateLimit
python3 scripts/mutation-check.py --exclude=mfa-src
```

The frontend has the same kind of check, `python3 scripts/frontend-mutation-check.py`: it breaks one behaviour at a
time in a copy of `frontend/` (the QR code, the two-step sign-in steps, the Security page, changing your password, the organisation policy, the admin reset, the Server settings page) and
confirms the frontend tests notice. It is quick (a few minutes). Like the server one, it takes part of a description
as a filter (`python3 scripts/frontend-mutation-check.py assign`), and a new screen or rule should get a breakage added
to it. It also covers the control-assignment screens, the audit-cycle chooser and the remembered choice, and the closed-cycle lock (the Close / Reopen buttons and the screens that take their edit buttons away).

Storage options are tagged `[storage-options]` (server) and `[storage-fe]` (web app). Their tests use a real S3 server,
[moto](https://github.com/getmoto/moto) (`pip install "moto[server]"`, which provides `moto_server`); those tests are skipped
with a note when it is not installed, so install it before judging a run.

The embedded database was only run on Linux. The test setup picks the right build for macOS and Windows too, but if it
won't start on your machine, use a Linux machine or Docker for the test runs and tell us what happened.

## Migration conventions

Migrations in `db/migrations/` are numbered and additive — once one has shipped, it's never edited.
A schema change is a new file (`00N_description.sql`), even a change that undoes an earlier one (see
`003_remove_licensing.sql` for an example: it drops what `001` added, rather than `001` being rewritten).
This keeps the migration history an honest record of what actually happened, in order.

## Keeping the live demo in step

The web app also has a browser-only live demo whose pretend server (`frontend/src/demo/`) re-implements the real API's rules.
If you change what the real API accepts, refuses or returns (a status change rule, a permission, a response field), make the
same change there, or say in your pull request that you did not. Its tests (`npx vitest run src/demo` in `frontend/`) describe
the rules in plain terms and are the place to add yours. A change to the sample control list in `db/seed/` is caught by a test.

## Code style

TypeScript, strict mode, no implicit `any`. Run `npm run typecheck` before opening a PR (`npm run verify` does this
for both the server and the web app). The web app has a linter (`npm run lint` in `frontend/`, using oxlint; it runs as
part of `npm run verify`). The server has no linter configured yet — contributions adding one are welcome.

## Reporting a security issue

Please don't open a public issue for a security vulnerability. Email the maintainers directly (see the
repo's About section for contact details) and give us a chance to fix it before it's public.
