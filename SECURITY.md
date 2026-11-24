# Security policy

This is an open-source tool that holds audit evidence, so security reports are taken seriously and welcome.

## Reporting a vulnerability

**Please report it privately — don't open a public issue or pull request for it.**

Use GitHub's private reporting: <https://github.com/Arjun-1404/iso27k-evidence/security/advisories/new>
(the repository's *Security* tab → *Report a vulnerability*). Only the maintainer can see what you send.

Helpful to include: what you found, where (file, endpoint or screen), the steps to reproduce it, what an attacker could
do with it, and the version or commit you tried it on. A proof of concept against your own installation is enough — please
don't test against anyone else's installation or against the live demo's hosting.

This project is maintained by one person in their own time, so there is no fixed response time. The aim is to acknowledge
a report within a week, to say whether it is accepted, and to fix confirmed problems quickly, with credit to you in the
release notes if you want it.

## What is supported

Only the latest version on the `main` branch. Fixes are not back-ported.

## What is in scope

The portal's own code: the API (`src/`), the database rules (`db/migrations/`), the web app (`frontend/`), the install and
launcher scripts (`scripts/`), and the Docker setup. Examples: signing in as someone else, reading or changing another
organisation's or client's data, getting past a role's limits, uploading something that is then served back to someone as
active content, making the server fetch an address it shouldn't, secrets ending up in logs or responses.

Out of scope: weaknesses that need someone to already control the server, its database or its `.env` file; running the
portal with the example secrets (it refuses to start that way); missing hardening on a reverse proxy or server that the
installer chose and configured themselves; findings in third-party packages with no way to reach them from this code
(report those to the package); denial of service by sheer volume of traffic; and the public demo, which holds only
made-up data and runs entirely in the visitor's browser.

## Running it safely

The README's "Installation" section covers a safe setup. The points that matter most:

- Generate the secrets with `npm run setup` (or the Docker command in the README); never run with the values from `.env.example`.
- Serve it over HTTPS, and set `APP_BASE_URL` and `CORS_ALLOWED_ORIGINS` to the real address.
- Set `TRUST_PROXY` when it sits behind a reverse proxy, so the per-address limits see real visitors.
- Set `SMTP_HOST` so invitation and reset links are emailed, not printed to the log.
- Turn on malware scanning (ClamAV) if evidence comes from outside your organisation.
- Keep the portal and its container images up to date, and back up the database and the evidence storage.
