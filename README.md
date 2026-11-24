# ISO 27001 evidence portal

[![Verify](https://github.com/Arjun-1404/iso27k-evidence/actions/workflows/ci.yml/badge.svg)](https://github.com/Arjun-1404/iso27k-evidence/actions/workflows/ci.yml)

**[Try the live demo](https://arjun-1404.github.io/iso27k-evidence/)**: click through it as an auditor, a client or an
administrator, or press **Take the 3-minute tour** at the top and follow the checklist. Everything in it is made up,
runs in your own browser, and is gone when you close the tab. Nothing is sent anywhere.
([How the demo works, and what it is not](#the-live-demo).)

**Want to run it yourself, on Windows or Linux, with or without Docker?** See [Installation](#installation): what to install first, then
five step-by-step routes, starting from the GitHub download.

<!-- readme-html:skip-start -->
**Reading this on your own computer and the layout looks broken?** Open **`README.html`**, the file next to this one, in your
browser. It is the same guide, laid out for reading, with a contents list and a Copy button on every command; it needs no
internet. (Notepad and code editors show this file as raw text; GitHub draws it properly.)
<!-- readme-html:skip-end -->

![A 30-second walkthrough of the demo: a client uploads evidence and submits it, the lead auditor accepts it, the dashboard's readiness figure moves from 48.2% to 49.1%, and the audit log shows each step](docs/walkthrough.gif)

*The whole loop in the live demo: the client hands over evidence, the auditor accepts it, the dashboard moves, the audit log records it.*

| The client's progress, as the auditor sees it | Reviewing a submitted control |
|---|---|
| ![Dashboard for a fictional client: a readiness ring at 48.2%, what needs attention, where the controls stand, and a tile for every control](docs/screenshots/dashboard.png) | ![A submitted control with two files, a comment, and Accept / Reject buttons](docs/screenshots/review-evidence.png) |

*Screenshots of the live demo (fictional data).*

An open-source ISO 27001 (and similar) audit-evidence portal, built on one rule: **the evidence stays in your own
storage**: your own Google Drive, a folder on your own server, or an S3-compatible bucket (Amazon S3, MinIO, Wasabi,
Backblaze B2…). SharePoint is planned. This app is a mediator: it tracks what's required, what's been submitted, and
what's been accepted, and never keeps a copy of the evidence files in its database. Only metadata (file name, size,
hash, provider file id) ever touches the database.

```mermaid
flowchart LR
  A["Audit firm<br/>review, accept or reject"]
  C["Client's people<br/>upload and submit evidence"]
  subgraph portal["The portal, on your server"]
    W["Web app<br/>the pages, served as plain files"]
    API["API<br/>roles, statuses, audit log,<br/>checks every upload"]
    DB[("PostgreSQL<br/>row-level security keeps clients apart<br/>metadata only: file name, size, hash, file id")]
  end
  S[("Your own storage<br/>Google Drive, server disk or S3 bucket<br/>holds the evidence files")]
  X["Optional, switched on under Server settings<br/>ClamAV scans each upload<br/>A mail server sends invitations and reminders"]
  A -- "browser: loads the app, signs in, reviews" --> W
  C -- "browser: loads the app, signs in, uploads" --> W
  W --> API
  API <--> DB
  API <-- "folders, downloads, reads each file back" --> S
  C -. "Google Drive only: the file goes straight to Drive" .-> S
  API -.-> X
```

*Where things live. With Google Drive the browser sends the file straight to Drive; with the server's disk or an S3 bucket
it passes through the API on the way. Either way the API then reads the file back from storage to check its hash and scan
it for malware, and the database keeps only the record of the file, never its contents. Dotted lines are optional or special
cases (the scanner and the mail server are switched on under Server settings).*

Multi-tenant by design (one instance can serve several client organisations — the typical case for an
audit firm self-hosting this for its clients), self-hosted, MIT licensed.

This repo has two parts:
- the root (`db/`, `src/`, `tests/`): the backend: database, services, HTTP API
- `frontend/`: the React web app. See `frontend/README.md` for that half. It also contains the live demo
  (`frontend/src/demo/`), which is only an extra way of building the same web app.

## Two ways to use this repository

| | **Live demo** | **The real thing** |
|---|---|---|
| What it is | The web app with a pretend server inside the page and made-up data | The web app, the API and a PostgreSQL database |
| Where it runs | Any static web host (GitHub Pages) | Your own machine or server |
| Data | Fictional, kept only in the visitor's own browser tab | Your organisation's, in PostgreSQL; the evidence files in your own storage |
| Email, malware scanning, Drive/S3 | Not available (the screens say so) | Yes |
| What you need | A browser | Docker, or Node 22 or newer + PostgreSQL (below); and a current browser (Chrome or Edge 111+, Firefox 128+, Safari 16.4+) |

**Running your own copy from GitHub** needs nothing beyond this repository. The live demo is *not* what you run: it
contains no database and no storage. Download the repository and follow [Installation](#installation)
below (Windows or Linux, with or without Docker, step by step). The backend, the database migrations, the Docker files and the launcher
scripts are all in the repository; the demo is an optional extra that a real installation never loads (a check in
`npm run verify` proves the real build contains none of it).

## Installation

Five ways to get your own copy running. Pick the row for your computer and the column for how you want to run it; each route is
complete on its own, from nothing installed to signed in.

| | **Without Docker** (one computer: a trial, or a small team) | **With Docker** (a server that must stay up) |
|---|---|---|
| **Windows** 10/11 or Windows Server | [1. Quick installation](#1-quick-installation-windows-or-linux-no-docker) (the short list, Windows and Linux), or [3. Windows (without Docker)](#3-windows-without-docker) (the same with every detail and the fixes) | [2. Windows (with Docker)](#2-windows-with-docker) |
| **Linux** (Debian, Ubuntu, Kali) | [1. Quick installation](#1-quick-installation-windows-or-linux-no-docker), or [5. Linux (without Docker)](#5-linux-without-docker) | [4. Linux (with Docker)](#4-linux-with-docker) |

New to this? Take **1. Quick installation**: no Docker, one list for both systems.

**How far each route has been tried.** Windows without Docker: written for Windows, **not yet tried on a real Windows machine** (built
and tested on Linux). Linux without Docker: tried end to end from a GitHub-style download on Linux, including the first-client steps.
Both Docker routes: written and checked piece by piece; the Docker images have **never been built** by the author.

Whichever route you take, once you are signed in carry on with [Your first client, end to end](#your-first-client-end-to-end).

### Before you start: what to install

Install only what your route needs, then check each with the command shown: every one must answer with a version number.

| Install this | Needed for | Check it |
|---|---|---|
| **Node.js 22 or newer**, which brings **npm** with it | The no-Docker routes (1, 3, 5). The Docker routes only for the optional `npm run setup` shortcut | `node -v` shows `v22` or higher; `npm -v` (Windows PowerShell: `npm.cmd -v`) |
| **PostgreSQL 16 or newer** | The no-Docker routes (1, 3, 5). The Docker routes bring their own database | `psql --version` |
| **Docker** with **Compose v2** | The Docker routes (2, 4) | `docker --version` and `docker compose version` |
| **A way to unpack the code**: the ZIP download, or `git` | Every route | Windows unpacks ZIP files itself; Linux: `unzip -v` |
| **A current browser** (Chrome or Edge 111+, Firefox 128+, Safari 16.4+) | Every route | An older one shows a half-blank page, with a notice at the top |

Disk: about 300 MB without Docker; a few GB for Docker's images and build cache.

**Node.js and npm** (they come together). The no-Docker routes need version 22 or newer (the current LTS is the easy choice).
- *Windows:* the LTS installer from https://nodejs.org (keep the defaults). Close and reopen PowerShell, then `node -v`.
  Use `npm.cmd` rather than `npm` in PowerShell, because PowerShell may refuse to run npm's script file.
- *Linux:* install it with nvm, not with `sudo apt install nodejs`: Debian 11 and Ubuntu 20.04 provide Node 10 or 12, far too old
  (the portal's own scripts stop with `SyntaxError: Unexpected token '?'`). Skip this if `node -v` already shows v22 or higher.
  ```
  sudo apt update && sudo apt install -y curl unzip
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  # close the terminal, open a new one, then:
  nvm install 22
  node -v
  ```
  Run `npm` commands as yourself, never with `sudo`: that leaves root-owned files behind and later steps fail with "permission denied".

**PostgreSQL** (no-Docker routes only).
- *Windows:* PostgreSQL 17 from https://www.postgresql.org/download/windows/ (EDB's installer; defaults, port 5432). When it asks for
  the **password of the database superuser (postgres)**, choose one (letters and digits are simplest) and write it down: the install steps need it.
- *Linux:*
  ```
  sudo apt update && sudo apt install -y postgresql
  sudo systemctl enable --now postgresql
  psql --version
  ```

**Docker** (Docker routes only).
- *Linux:* follow Docker's own instructions for your system, https://docs.docker.com/engine/install/ , which install Docker Engine with
  the Compose plugin. On recent Ubuntu the distribution's packages also work (names differ between releases):
  `sudo apt update && sudo apt install -y docker.io docker-compose-v2`. Then `sudo systemctl enable --now docker`, and check that
  `docker compose version` prints a version beginning `v2`: a computer that only has the old `docker-compose` command needs the Compose
  plugin from Docker's page. To run `docker` without `sudo`: `sudo usermod -aG docker $USER`, then log out and back in.
- *Windows:* Docker Desktop, https://www.docker.com/products/docker-desktop/ . What it needs, and the catch inside a virtual machine, is in
  [2. Windows (with Docker)](#2-windows-with-docker).

**Getting the code** (every route). On the repository's page press the green **Code** button → **Download ZIP** and unpack it, or with git:
`git clone https://github.com/Arjun-1404/iso27k-evidence.git`. A ZIP unpacks to a folder named `iso27k-evidence-main`. Every command
in this guide is run in a terminal opened **in the folder that has `package.json` in it**. On Windows unpack to a short path such
as `C:\evidence-portal` (long paths hit a Windows limit), open the folder in File Explorer, click the address bar, type `powershell`
and press Enter. On Linux: `unzip iso27k-evidence-main.zip && cd iso27k-evidence-main`.

### 1. Quick installation (Windows or Linux, no Docker)

The shortest route, for someone who found this repository on GitHub and wants their own copy running: no Docker, everything on one
computer (a real one or a virtual machine), used in a browser on that same computer. It works the same on **Windows** and on
**Linux**, with a line for each where they differ. You need no developer and nothing but this repository.

**What you need:** the programs under [Before you start](#before-you-start-what-to-install) (steps 1 and 2 below install them if
you have not), a connection to the internet for step 3 (npm's download server, once), about 300 MB of free disk, and a browser.
If you would rather have each step explained at length, with the fixes for what can go wrong, use
[3. Windows (without Docker)](#3-windows-without-docker) or [5. Linux (without Docker)](#5-linux-without-docker): same steps, more detail.

The steps below are the same on both systems except where a line says Windows or Linux.

**1. Get the code.** On the repository's page press the green **Code** button → **Download ZIP**, and unpack it. (Or, if you
use git: `git clone https://github.com/Arjun-1404/iso27k-evidence.git`.) Open a terminal **in the folder that has
`package.json` in it** (GitHub names it `iso27k-evidence-main`):
- *Windows:* unpack to a short path such as `C:\evidence-portal` (long paths hit a Windows limit). In File Explorer open the
  folder, click the address bar, type `powershell`, press Enter.
- *Linux:* `unzip iso27k-evidence-main.zip && cd iso27k-evidence-main`

**2. Install Node.js and PostgreSQL** (skip what you already have).
- *Windows:* Node.js LTS from https://nodejs.org (keep the defaults), and PostgreSQL 17 from
  https://www.postgresql.org/download/windows/ (EDB's installer, defaults, port 5432). When the installer asks for the
  **password of the database superuser (postgres)**, choose one (letters and digits are simplest) and write it down: step 5
  needs it. Close and reopen PowerShell afterwards; `node -v` should print v22 or higher.
- *Linux:*
  ```
  sudo apt update && sudo apt install -y postgresql curl unzip
  sudo systemctl enable --now postgresql
  # only if `node -v` does not already print v22 or higher:
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  # close the terminal, open a new one, go back to the folder, then:
  nvm install 22
  ```

**3. Install the portal's libraries and build the web app** (once; a few minutes, because the web app's build tools are a
big download). A GitHub copy has the source only, with neither.
- *Windows* (`npm.cmd` rather than `npm`, because PowerShell may refuse to run npm's script file):
  ```
  npm.cmd ci --omit=dev
  npm.cmd ci --prefix frontend
  npm.cmd run build --prefix frontend
  ```
- *Linux:*
  ```
  npm ci --omit=dev
  npm ci --prefix frontend
  npm run build --prefix frontend
  ```

Run them **one at a time, from the folder that has `package.json` in it**, and wait for each to finish; there is no `cd`. Each
ends without an `npm error`, and the last one prints `✓ built in …`. Lines such as `npm warn install-scripts … msw` are normal.

If that stops with `ECONNRESET`, `ERR_SSL_WRONG_VERSION_NUMBER` or `Exit handler never called`, something on your network is
blocking npm's download server: see the troubleshooting under [4. Linux (with Docker)](#4-linux-with-docker) (it includes a mirror).

**4. Create the settings file** (fresh random secrets; keep a copy of `.env` somewhere safe, because without its
`SECRET_ENCRYPTION_KEY` everything the portal has encrypted becomes unreadable):
```
node scripts/init-env.mjs
```

**5. Make the portal and PostgreSQL agree on PostgreSQL's password.**
- *Windows:* `notepad .env`, change the line `POSTGRES_PASSWORD=…` to the password you chose in step 2 (in double quotes if it
  contains spaces or `#`), save, close. Leave the other lines alone.
- *Linux:* give PostgreSQL's `postgres` user the password that is already in `.env`:
  ```
  sudo -u postgres psql -c "ALTER USER postgres PASSWORD '$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)'"
  ```
  It should print `ALTER ROLE`. A `could not change directory … Permission denied` line before it is harmless. (If PostgreSQL is not on the usual port 5432, add `POSTGRES_PORT=<port>` to `.env`.)

**6. Check the computer.** It changes nothing and says what to fix (fix any `[FAIL]` line and run it again):
```
node scripts/local.mjs check
```

**7. Start it, with one command in one window.** The first time, give the details of the first administrator; they become the
owner of the installation. Use an email address on your own domain:
```
node scripts/local.mjs start --org "Your Firm" --domain yourfirm.example --email you@yourfirm.example
```
It prepares the database, creates that administrator, and runs the API and the web app together. When it is ready it prints a
box saying **The portal is running**, with a link ending in `/accept-invite?token=…`. **Leave the window open**: closing it, or
pressing Ctrl+C, stops the portal. (Windows may ask whether Node.js may use the network; either answer works for use on this
computer.)

**8. Open that link in a browser on this same computer**, choose a password, and sign in. Use `http://localhost:5173`
exactly, not `127.0.0.1`, because the API only accepts requests from the address in `APP_BASE_URL`. Use a current browser (Chrome or
Edge 111+, Firefox 128+, Safari 16.4+): an older one cannot read the portal's colours and shows a half-blank page, with a notice at the top saying so.

**How you know it worked:** the window shows the box in step 7, the link opens a page that asks you to choose a password, and
after that you are signed in as the owner of your firm. If something stops, the message says which step to redo; the
Windows-specific fixes are in the **If something goes wrong** list in [3. Windows (without Docker)](#3-windows-without-docker).

**Stopping and starting again.** Ctrl+C in the window stops it. To start it again: `node scripts/local.mjs start` (no details
needed any more), or on Windows double-click `start-portal.cmd`. Each start also applies any database changes that came with
the version of the code you are running. It runs while that window is open; for a portal that must stay up around the clock,
use a Linux server with Docker Compose.

**What to back up.** Three things, together: the `.env` file, the PostgreSQL database `evidenceportal`
(`pg_dump`), and the **evidence folder**: `EvidencePortal/files` inside your home folder (`%USERPROFILE%\EvidencePortal\files` on
Windows), unless you set `LOCAL_STORAGE_DIR` in `.env`. The database holds only names, sizes and checksums; the folder *is* the evidence.

**Updating later** (not yet tried across two real versions): back up those three things, unpack the new version into a new
folder, copy your `.env` into it, repeat step 3 there, and run `node scripts/local.mjs start`.

**Letting other people reach it over the network.** This route is for one computer. To let your colleagues and clients reach it
you have to set the portal's public addresses and put HTTPS in front of it before anyone signs in: see "Opening it from
another computer" under [5. Linux (without Docker)](#5-linux-without-docker) and [Request limits and reverse proxies](#request-limits-and-reverse-proxies).
That has not been tried by the author.

Next: [Your first client, end to end](#your-first-client-end-to-end).

### 2. Windows (with Docker)

The Docker route works on Windows too, but it needs more than the no-Docker route — use [3. Windows (without Docker)](#3-windows-without-docker) for a trial in a virtual
machine. **Not tried on Windows by the author, and the Docker images have not been built even on Linux (see [4. Linux (with Docker)](#4-linux-with-docker)).**

- **Docker Desktop** on Windows 10/11 (it is not available for Windows Server), with its default *WSL 2* backend. That needs
  hardware virtualisation to be switched on. **Inside a virtual machine this means *nested virtualisation* must be enabled in
  the hypervisor** (VMware: "Virtualize Intel VT-x/EPT"; Hyper-V: `Set-VMProcessor -VMName <name> -ExposeVirtualizationExtensions $true`;
  VirtualBox and Apple-silicon hosts often cannot do it). If Docker Desktop says virtualisation is not available, use the no-Docker route.
  Docker Desktop is free for personal use and small businesses; larger companies need a paid plan — check Docker's terms.
- **Commands are the same as in [4. Linux (with Docker)](#4-linux-with-docker)**, typed one at a time. Windows PowerShell 5.1 (the one that comes with Windows) does
  not understand `&&`, so do not chain them. Create `.env` with `node scripts/init-env.mjs` (Node.js installed, as in the no-Docker
  route) or with Docker: `docker run --rm -v "${PWD}:/app" -w /app node:22-slim node scripts/init-env.mjs`.
- **Extra Compose files** (the prebuilt web app, described in [4. Linux (with Docker)](#4-linux-with-docker)) are listed in `COMPOSE_FILE` with **`;` between them on Windows**, not `:`:
  `COMPOSE_FILE=docker-compose.yml;docker-compose.prebuilt-frontend.yml`. Add the line with `notepad .env`, not with
  `echo … >> .env`: Windows PowerShell 5.1 writes that as UTF-16, which Compose cannot read.
- **Do not use the offline API option (`docker-compose.offline.yml`) with the Windows download.** It copies the `node_modules` folder
  into a Linux image, and the Windows download's folder holds Windows programs. The prebuilt web app option is fine (the built
  web app is the same everywhere). Without it, the images download their libraries while building, so the build needs access to
  `registry.npmjs.org` from inside Docker.
- The portal is then at `http://localhost:5173` in the Windows browser, as in section 4. The first administrator is created
  with the `docker compose run … migrate npm run db:bootstrap-admin` command from section 4; in PowerShell write
  `-e ORG_NAME="Your Firm"` exactly like that.

### 3. Windows (without Docker)

*Starting from a GitHub download? [1. Quick installation](#1-quick-installation-windows-or-linux-no-docker) has these steps in one list for Windows and
Linux. This section adds the details and the list of fixes.*

Everything runs on the one Windows computer (or virtual machine): PostgreSQL as a Windows service, and the portal itself
in one PowerShell window (or one double-click). There is no Docker, no WSL and no `bash`. The commands below are the same in PowerShell and
in cmd. **Not tried on a real Windows machine by the author** (everything was built and tested on Linux; the launcher with its one-window
start, the web server and the start-up check were tested there, including against a PostgreSQL that asks for a password with awkward
characters in it). If a step fails, the message `node scripts/local.mjs check` prints is meant to say what to do; please
report anything it gets wrong.

**Which download do you have?** There are two kinds, and they differ in one step (step 5):

| You have | What is in it | What to do |
|---|---|---|
| **A copy from GitHub** (the green **Code** button → **Download ZIP**, or `git clone`) | The source only: **no libraries and no built web app** | Do **every** step below, including **step 5** (installs the libraries and builds the web app: needs internet, a few minutes, once) |
| **The Windows download** (`evidence-portal-windows-….zip`, if you were given one) | The libraries for 64-bit Windows (Intel/AMD and ARM) and the ready-built web app | **Skip step 5**: nothing is downloaded from npm and `npm install` is never run |

Either way, only two programs have to be installed (steps 1 and 2):

**1. Install Node.js** from https://nodejs.org (the green "LTS" button; version 22 or newer).
Keep the defaults. Close and reopen PowerShell afterwards, and check with `node -v`.

**2. Install PostgreSQL 17** with the Windows installer from https://www.postgresql.org/download/windows/ (EDB's "Download the
installer"). Keep the defaults (port 5432). When it asks for the **password for the database superuser (postgres)**, choose
one — letters and digits are the simplest — and write it down: step 7 needs it. It installs as a service that starts with
Windows. You do not need pgAdmin or Stack Builder.

*If this computer cannot download from those sites*, download the two installers on another computer and copy them over.

**3. Unpack the portal** to a short folder such as `C:\evidence-portal` (long folder names can hit Windows' path-length limit).
Before extracting, right-click the `.zip` → Properties → tick **Unblock** if you see it → OK; then right-click → Extract All.
The folder you end up in has `package.json` and `scripts` in it (and `node_modules` too, if you have the Windows download).

**4. Open PowerShell in that folder:** in File Explorer, open the folder, click the address bar, type `powershell`, press Enter.
Everything from here on is typed in that window, one command at a time. There is no `cd`: the window is already in the right folder.

**5. A copy from GitHub only: install the libraries and build the web app** (once). Skip this step if you have the Windows
download. Run the three commands **one at a time**, waiting for each to finish; this needs internet access to npm and takes a few
minutes, because the web app's build tools are a big download:
```
npm.cmd ci --omit=dev
npm.cmd ci --prefix frontend
npm.cmd run build --prefix frontend
```
(`npm.cmd` rather than `npm`, because PowerShell may refuse to run npm's script file.) The first line installs the libraries the
portal runs on; the other two build the web app into `frontend\dist`. Each ends without an `npm error`, and the last one prints
`✓ built in …`; lines such as `npm warn install-scripts … msw` are normal. If one stops with `ECONNRESET`, `ERR_SSL_WRONG_VERSION_NUMBER` or
`Exit handler never called`, something on your network is blocking npm's download server: see the troubleshooting under
[4. Linux (with Docker)](#4-linux-with-docker) (it includes a mirror). If you skipped this step by mistake, `check` (step 8) says
which of the two is missing and the rest is unchanged.

**6. Create the settings file** (it fills in fresh random secrets; keep a copy of it somewhere safe):
```
node scripts/init-env.mjs
```
(Use `node …` as written rather than `npm run …`: PowerShell may refuse to run npm's script file.)

**7. Tell the portal your PostgreSQL password.** `init-env` made up a password, but PostgreSQL has the one you chose in step 2.
```
notepad .env
```
Change the line `POSTGRES_PASSWORD=…` to `POSTGRES_PASSWORD=` followed by your PostgreSQL password. If it contains spaces or a
`#`, put it in double quotes. Save and close. Leave the other lines alone — they are the portal's own secrets.

**8. Check the computer** (changes nothing; fix any `[FAIL]` line it shows and run it again):
```
node scripts/local.mjs check
```
It looks at Node, the libraries, the web app, `.env`, that PostgreSQL answers and accepts the password, and that the ports are free.
If it says the libraries or the web app are missing, you have a GitHub copy and skipped step 5.

**9. Start it — one command, one window.** The first time, give the details of the first administrator (they become the owner
of the installation):
```
node scripts/local.mjs start --org "Your Firm" --domain yourfirm.example --email you@yourfirm.example
```
It prepares the database, creates that administrator, and runs the API and the web app together; their messages appear in the
same window, marked `[api]` and `[web]`. When everything is up it prints a box that says **The portal is running** and shows the
address and a link ending in `/accept-invite?token=…`. Windows may ask whether Node.js may use the network: either answer works
for use on this computer. **Leave the window open** — closing it, or pressing Ctrl+C in it, stops the portal (both parts).

**10. Open the link** in a browser *on this same computer*, choose a password, and sign in. Use `http://localhost:5173` exactly —
not `127.0.0.1` — because the API only accepts requests from the address in `APP_BASE_URL`. Use a current browser (Chrome or Edge
111+, Firefox 128+, Safari 16.4+); an older one shows a half-blank page. Then open **Server settings** for
mail, malware scanning and Google Drive.

**Starting it again later:** PostgreSQL starts with Windows. Either run `node scripts/local.mjs start` (no details needed any
more) or **double-click `start-portal.cmd`** in the folder; it opens a window, starts the portal, and tells you when it stops.
To start it whenever you sign in to Windows: press Win+R, type `shell:startup`, Enter, and drop a shortcut to `start-portal.cmd`
into the folder that opens. (This is for a trial on one computer: it runs while you are signed in. For a portal that must stay up
around the clock, use a Linux server with Docker Compose.)

One step at a time, if you prefer (or to find which step fails): `node scripts/local.mjs db` (database), `… admin --org … --domain
… --email …` (first administrator), `… api` and `… web` (each in its own window).

If something goes wrong:
- **`'node' is not recognized`** — close PowerShell and open a new one (the installer only updates new windows).
- **`check` says the libraries were packaged for another kind of computer** — you opened the Linux download; use the Windows one.
- **`check` says the libraries or the web app are missing** — you have a copy from GitHub and skipped step 5; run its three `npm.cmd` commands, then `check` again.
- **`refused the password in .env`** — step 7: the line must hold the password from the PostgreSQL installer. If you forgot it, search for "reset postgres password pg_hba.conf" in PostgreSQL's documentation, or reinstall PostgreSQL.
- **`Cannot reach PostgreSQL`** — open **Services** (Windows key, type *Services*), find `postgresql-x64-17`, choose Start. If the installer used another port, add `POSTGRES_PORT=<that port>` as a line in `.env`.
- **`esbuild.exe` missing or access denied** — antivirus software can quarantine a file it does not know; restore it in Windows Security → Protection history, or add the folder as an exclusion.
- **Windows Firewall / other computers** — for use on this computer only, nothing needs to be opened. To reach it from another computer, see "Opening it from another computer" under [5. Linux (without Docker)](#5-linux-without-docker).
- **Different PostgreSQL address or administrator** — optional lines `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER` in `.env` (they are listed, commented out, in `.env.example`).
- **`Port 3000 … is already in use`** — an earlier copy is still running in another window (close it), or another program uses that port. To use other ports, add lines such as `PORT=3100` or `WEB_PORT=5200` to `.env` (and keep `APP_BASE_URL` pointing at the web port).
- The ready-made Docker route is a poor fit inside a virtual machine (Docker Desktop needs virtualisation inside the virtual machine), which is why this route exists.

`node scripts/local.mjs` with no arguments lists the commands. They read `.env` themselves, so no `set`, `export` or `$env:`
is needed, and a password containing characters like `@`, `:`, `/` or `#` is handled for you.

### 4. Linux (with Docker)

Docker Compose runs the database, the API and the web app for you: the right route for a Linux server that must stay up. Install
Docker first ([Before you start](#before-you-start-what-to-install)); this computer needs no Node.js or PostgreSQL for it. On
Windows, see [2. Windows (with Docker)](#2-windows-with-docker).

```
bash scripts/preflight.sh    # optional: checks this machine and says what to fix before you start
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD":/app -w /app node:22-slim node scripts/init-env.mjs   # creates .env with fresh random secrets
docker compose build api     # one image at a time: two big downloads at once are what flaky networks choke on
docker compose build frontend
docker compose up -d
docker compose ps            # db should say healthy; api and frontend running
```

That first command copies `.env.example` to `.env` and fills in the database passwords, the session-signing secret and
the encryption key for you. It never overwrites an existing `.env`, and the new file is readable only by you. Keep a
copy somewhere safe (a password manager): without `SECRET_ENCRYPTION_KEY`, everything the portal has encrypted
becomes unreadable. It runs inside a throw-away container, so **this computer needs no Node.js at all** for the Docker route.
`--user "$(id -u):$(id -g)"` makes the new `.env` yours rather than root's; without it `docker compose` cannot
read the file (if that happened: `sudo chown $USER: .env`). On Windows PowerShell use `-v "${PWD}:/app"` and drop `--user`.
If this computer has Node 22 or newer anyway, `npm run setup` does the same thing. To set the public addresses at the same time,
add them to either form: `--app-url https://portal.yourfirm.example --api-url https://portal-api.yourfirm.example`
(with npm, after a `--`: `npm run setup -- --app-url …`).

**If `npm run setup` stops with `SyntaxError: Unexpected token '?'`** — the Node.js on this computer is too old (Node 12 or 10,
which is what `apt install nodejs` gives on Debian 11 and Ubuntu 20.04; `node -v` shows it) and the copy of the portal you have
predates the fix. Run the `docker run …` command above instead, which brings its own Node. Newer copies of the script run on
Node 12 and later, and `bash scripts/preflight.sh` says what to do on anything older. Only the no-Docker routes need a Node of their own (22 or newer: see [Before you start](#before-you-start-what-to-install)).

Once `migrate` finishes and `api`/`frontend` are up, create the first account. This person becomes **the owner of the
installation**:
```
docker compose run --rm -e ORG_NAME="Your Org" -e ORG_DOMAIN=yourorg.example \
  -e ADMIN_EMAIL=you@yourorg.example migrate npm run db:bootstrap-admin
```
That prints a one-time link — open it to set your password, then sign in at the frontend URL
(`http://localhost:5173` by default; use a current browser: Chrome or Edge 111+, Firefox 128+, Safari 16.4+). Then open **Server settings** in the left-hand menu to set up
[email, malware scanning and Google Drive](#server-settings-email-scanning-and-google-drive-from-the-web-app) —
no files to edit and no restart.

**What has and hasn't been verified about Docker:** the sandbox this was built in has the Docker tools but
no Docker daemon, so the images have never been built or run here. What *was* checked: `docker compose config`
accepts the Compose file under several configurations (which caught a real bug — an unquoted colon that made the
file unreadable); the backend image's install steps were replayed in a clean folder with a production
environment (which caught another — `tsx` was listed as a dev-only package and so would be missing from the
image); and the exact sequence Compose automates — `npm run db:setup` → `npm run db:bootstrap-admin` → opening
the printed link → setting a password → logging in → an authenticated API call — was run for real over HTTP
against a real Postgres. If `docker compose up` still doesn't work on the first try for you, please open an
issue; the gap is most likely in the image plumbing rather than the application underneath.

**If the build stops with `the --mount option requires BuildKit`** — you have an older copy of the portal's Dockerfiles, and your Docker has
no `buildx` plugin (`WARN … buildx Docker CLI plugin not found: falling back to the classic builder`; typical of Ubuntu's `docker.io` package).
The current Dockerfiles build with either builder, so download the latest copy. To fix the copy you have, run this in the project folder and build again:
```
sed -i 's|^RUN --mount=type=cache,target=/root/.npm \\|RUN \\|' Dockerfile frontend/Dockerfile
```
(Or install the plugin: `sudo apt install docker-buildx`, or `docker-buildx-plugin` from Docker's own apt repository.)

**If the build stops with `npm error Exit handler never called!`** — that is npm itself giving up, almost always
because the download from the npm registry was cut off (a VPN or company proxy, flaky Wi-Fi, Docker Desktop with too
little memory). It is not a fault in the portal's code. The images retry failed downloads on their own, so
simply running the same command again often finishes it. If it keeps happening, build the two images one after the
other instead of at the same time, then start everything:
```
docker compose build api
docker compose build frontend
docker compose up
```
In Docker Desktop, 4 GB of memory (Settings → Resources) is a sensible minimum; if you are behind a company proxy, Docker
Desktop needs the proxy set in its own settings too.

**If the build stops with `npm error code ECONNRESET`, `network request … failed` or `ERR_SSL_WRONG_VERSION_NUMBER`** —
something on your network is blocking `registry.npmjs.org`, or answering for it with something that is not the real
site (a firewall or content filter, a captive-portal or proxy, or DNS pointing somewhere else). It is not a fault in the
portal, and the same thing stops `npm ci` in the no-Docker route. `bash scripts/preflight.sh` runs the checks below and prints
what to do. Doing it by hand, find out which it is:
```
curl -sS -I https://registry.npmjs.org/vary/-/vary-1.1.2.tgz | head -1     # should print HTTP/2 200; an error here means the machine itself is blocked
getent hosts registry.npmjs.org                                            # normally Cloudflare addresses, starting 104.16.
env | grep -i proxy                                                        # a proxy set here is used by npm and curl, but not by Docker builds
```
If curl shows an error or the addresses look different, change the machine's DNS to 1.1.1.1 and 8.8.8.8 (on Kali), or try
another network (a phone hotspot) or a VPN:
```
nmcli connection show                                     # note the NAME of your active connection
sudo nmcli connection modify "NAME" ipv4.dns "1.1.1.1 8.8.8.8" ipv4.ignore-auto-dns yes
sudo nmcli connection up "NAME" && sudo systemctl restart docker
```
If that does not help, download the libraries from a mirror instead. Add one line to `.env`, then build again:
```
NPM_REGISTRY=https://registry.yarnpkg.com
```
For the no-Docker route use `npm ci --omit=dev --registry=https://registry.yarnpkg.com`. If curl works with `-4` (IPv4 only)
but not without it, IPv6 is the broken part: run `export NODE_OPTIONS=--dns-result-order=ipv4first` before `npm ci`, and for
Docker `sudo sysctl -w net.ipv6.conf.all.disable_ipv6=1 net.ipv6.conf.default.disable_ipv6=1` then restart Docker. If that address
is blocked too, `https://registry.npmmirror.com` is another. npm still checks every download against the hashes in
`package-lock.json`, so a mirror cannot change what is installed.

**If Docker stops with `TLS handshake timeout` or `failed to resolve reference "docker.io/library/…"`** (for example while
fetching `node:22-slim`, which the first `docker run` or `docker compose build` needs) — Docker cannot reach Docker Hub
(`registry-1.docker.io`), where every base image comes from. It is not a fault in the portal. The Docker service does the
downloading, not your shell, so a proxy or DNS change you made in your terminal does not apply to it. In this order:
```
docker pull node:22-slim                                          # once more: timeouts are often momentary
curl -sS -I https://registry-1.docker.io/v2/ | head -1            # should print HTTP/2 401 (that is normal: "log in first"); an error means the network is the problem
sudo sysctl -w net.ipv6.conf.all.disable_ipv6=1 net.ipv6.conf.default.disable_ipv6=1 && sudo systemctl restart docker   # if the same curl works with -4 but not without
```
If it still times out, point Docker at a mirror of Docker Hub. Google runs one for the popular images, which covers `node`,
`postgres` and `nginx` (anything it does not have is fetched from Docker Hub as usual). Put this in `/etc/docker/daemon.json`
(create the file if it is not there; in Docker Desktop it is Settings → Docker Engine), then restart Docker and check that
`docker info` lists the mirror:
```
{
  "registry-mirrors": ["https://mirror.gcr.io"]
}
```
Behind a company proxy, Docker needs the proxy set for the Docker service itself (Docker's documentation, "Daemon proxy
configuration"; Docker Desktop: Settings → Resources → Proxies). A phone hotspot or VPN for the one-time download also works:
once the images are on the machine, builds do not need Docker Hub again. Creating the settings file does not need Docker: with any
Node.js from 12 on, `npm run setup` does the same thing as the `docker run` command above.

**If `docker compose up -d` stops with `service "migrate" didn't complete successfully`** — look at why:

```
docker compose logs migrate | tail -5
```

If the last line says `password authentication failed for user "postgres"`, the database was created earlier with a different
password than the one in `.env` now. PostgreSQL keeps the password it was first started with in its data volume and never reads
`POSTGRES_PASSWORD` again, and Docker names that volume after the project folder, so a regenerated `.env`, or the project
unzipped again into a folder of the same name, no longer matches. Either put the previous `.env` back, or, if the database holds
nothing you need (a first trial, say), start it again from empty:

```
docker compose down -v      # deletes the database and the evidence-files volume
docker compose up -d
```

If the last line says the password `is still the example text from .env.example`, `.env` still holds the placeholder passwords.
Move it aside (`mv .env .env.old`), run the `docker run … init-env.mjs` command above for a fresh one (it never overwrites an existing
file), then `docker compose down -v` and `docker compose up -d`: the database was already created with the placeholder password.

The web app is the bigger download (about 240 packages, 400 MB — mostly testing and build tools the running portal never
uses), so on an unreliable connection it can fail even when the API image built. For that case the download ships the
web app already built (`frontend/dist`) and Docker can simply serve it, with no downloads for the frontend at all
(on Windows, see [2. Windows (with Docker)](#2-windows-with-docker): `;` instead of `:`, and edit `.env` with Notepad):
```
echo 'COMPOSE_FILE=docker-compose.yml:docker-compose.prebuilt-frontend.yml' >> .env
docker compose build frontend
docker compose up -d
```
That copy talks to the API at `http://localhost:3000`, so open the portal on the machine that runs it. For another API
address, use the normal build (and rebuild `frontend/dist` with `cd frontend && VITE_API_BASE_URL=<address> npm run build`
if you want to keep using this shortcut).

If the API image cannot be built either (npm is blocked everywhere), the offline download also carries the API's libraries.
Build the API image from those, with no npm download at all — put this line in `.env` (replacing the `COMPOSE_FILE` line
above, if you added one):
```
COMPOSE_FILE=docker-compose.yml:docker-compose.prebuilt-frontend.yml:docker-compose.offline.yml
```
then `docker compose build api`, `docker compose build frontend`, `docker compose up -d` as before. The database and web
server images (postgres, nginx) still come from Docker Hub unless they are already on the machine.

The running `api` container also needs internet access, to reach Google Drive and your mail server. Once the build works,
check it from inside Docker (`container: 200` is good):
```
docker run --rm node:22-slim node -e 'fetch("https://www.googleapis.com/discovery/v1/apis").then(r=>console.log("container:",r.status)).catch(e=>console.log("container FAILED:",e.cause?.code||e.message))'
```

### 5. Linux (without Docker)

*Starting from a GitHub download? [1. Quick installation](#1-quick-installation-windows-or-linux-no-docker) is the short version of this section, with the
same steps for Windows and Linux. This section does the same thing by hand, one program at a time, and adds the details.
A GitHub copy needs **step 1b** before anything else works.*

Written for Kali / Debian / Ubuntu (**on Windows, use [3. Windows (without Docker)](#3-windows-without-docker)**); other systems differ only in how PostgreSQL is installed. You need **Node.js 22 or newer**
(`node -v`) and **PostgreSQL 16 or newer**, running on this machine. You will use two terminal windows.

**0. Check the machine** (optional, takes a few seconds; it changes nothing and says what to fix)
```
bash scripts/preflight.sh
```

**1. Install the programs**
```
sudo apt update && sudo apt install -y postgresql curl
sudo systemctl enable --now postgresql

# Only if `node -v` does not already print v22 or higher:
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
# close the terminal and open a new one, then:
nvm install 22
```

**1b. A copy from GitHub only: install the libraries and build the web app** (once; terminal 1, inside the unpacked folder, one
command at a time). A GitHub copy is the source only, with neither the libraries nor the built web app, and every later step
needs them. It needs internet access to npm and takes a few minutes:
```
npm ci --omit=dev
npm ci --prefix frontend
npm run build --prefix frontend
```
Do **not** put `sudo` in front of these (or any `npm` command here): it makes `node_modules` belong to root, and later steps run
as you then fail with "permission denied". If you already did, fix it with `sudo chown -R "$USER": .` in the project folder. A closing
line such as "NN packages are looking for funding — run `npm fund`" is a normal notice that npm prints when it succeeds; ignore it.

**Skip this if the folder already has a `node_modules` folder** (a ready-made download for 64-bit Intel/AMD or ARM Linux): the
libraries and the built web app are inside, nothing needs downloading, and `npm ci` would delete them and need the internet. If it
stops with `ECONNRESET` or `ERR_SSL_WRONG_VERSION_NUMBER`, your network is blocking npm's download server: see the troubleshooting
section above (it has the fix, including a mirror).

**2. Create the settings file** (terminal 1, inside the unpacked folder)
```
npm run setup          # writes .env with fresh random secrets; back this file up
```

**3. Create the database** (still terminal 1)
```
set -a; . ./.env; set +a        # loads the values from .env into this terminal
sudo -u postgres psql -c "ALTER USER postgres PASSWORD '$POSTGRES_PASSWORD';"
sudo -u postgres createdb evidenceportal
export DATABASE_URL="postgres://postgres:$POSTGRES_PASSWORD@127.0.0.1:5432/evidenceportal"
npm run db:setup               # creates the tables, the restricted portal_app role, and the ISO 27001 control list
```
If `psql` cannot connect, check which port PostgreSQL is on with `pg_lsclusters` and use that number instead of 5432.
A line such as `could not change directory to "/home/you/Downloads/…": Permission denied` before `ALTER ROLE` is harmless: the
`postgres` account is not allowed to look inside your home folder, and nothing needs it to. It appears with every `sudo -u postgres`
command; what matters is that `ALTER ROLE` and, for `createdb`, no error follows. (If a `NOTICE: empty string is not a valid password`
appears, the first line did not load `.env`: run it again in this terminal, then repeat the `ALTER USER` line.)

**4. Create the first administrator** (still terminal 1; they become the owner of the installation)
```
ORG_NAME="Your Firm" ORG_DOMAIN=yourfirm.example ADMIN_EMAIL=you@yourfirm.example npm run db:bootstrap-admin
```
It prints a one-time link ending in `/accept-invite?token=…`. Keep it for step 7.

This step needs the `DATABASE_URL` from step 3 (the database owner, `postgres`). Do it **before** step 5, whose `export` switches to the
restricted `portal_app` role. If it stops with `permission denied for table orgs`, that switch has already happened in this terminal: it
created nothing, so set the owner's address again (`export DATABASE_URL="postgres://postgres:$POSTGRES_PASSWORD@127.0.0.1:5432/evidenceportal"`
after `set -a; . ./.env; set +a`) and re-run the command above, then continue with step 5.

**5. Start the API** (terminal 1). From here on it connects as the restricted `portal_app` role, not as the database owner:
```
export DATABASE_URL="postgres://portal_app:$APP_DB_PASSWORD@127.0.0.1:5432/evidenceportal"
npm start
```
Leave it running. It prints `Evidence portal API listening on :3000` when it is ready. Emails (invitations, password resets) are printed in this window
until you set up a mail server under Server settings.

**6. Start the web app** (terminal 2, in the unpacked folder)
```
node scripts/serve-web.mjs
```
This needs nothing but Node: it serves the ready-built web app that comes in `frontend/dist`. (Someone changing the web app's
code uses `cd frontend && npm ci && npm run dev` instead.)

**7. Open it.** In a browser *on the same machine*, paste the link from step 4 (it begins `http://localhost:5173/…`),
choose a password, and sign in. Use the address `http://localhost:5173` exactly — not `127.0.0.1` — because the API only
accepts requests from the address in `APP_BASE_URL`. Use a current browser (Chrome or Edge 111+, Firefox 128+, Safari 16.4+): an older one
cannot read the portal's colours and shows a half-blank page (the sidebar looks empty), with a notice at the top saying so. Then open **Server settings** for mail, malware scanning and Google Drive.

**Starting it again later:** in terminal 1 run `set -a; . ./.env; set +a`, then the two lines from step 5; in terminal 2
run `node scripts/serve-web.mjs`. Steps 2–4 are only done once.

**Opening it from another computer** (for example the VM's address from your host machine; not tried by the author): rebuild
the web app for the API's address (`cd frontend && npm ci && VITE_API_BASE_URL=http://<address>:3000 npm run build`), start
it with `WEB_HOST=0.0.0.0 node scripts/serve-web.mjs`, and set `APP_BASE_URL` and `CORS_ALLOWED_ORIGINS` in `.env` to the
address people type in the browser. Doing everything inside the VM avoids all of this.

## Your first client, end to end

Once you are signed in, this is the order that works. (The web app calls a client a **tenant**.) Every step is done on screen.

1. **Choose where the evidence goes.** Left-hand menu **Integrations** → **This server's disk** → **Use this server's disk**
   (the folder is the one named in "What to back up"; the portal prints it when it starts). Google Drive and S3 are in
   [Where evidence is kept](#where-evidence-is-kept-google-drive-this-servers-disk-or-s3).
2. **Add the client.** **Tenants** → *Tenant name* and *Allowed email domain* (the domain its people use, for example
   `northwind.example`) → **Add tenant**. Only people at that domain can be invited to that client.
3. **Create the client's evidence folder.** Back on **Integrations**, press **Create folder on this server's disk** for that client.
4. **Optional, for a real trial: set up email** under **Server settings**. Until you do, every invitation and reset email is **printed in
   the portal's window** instead of being sent. Those links work like passwords, so do not run a real deployment that way.
5. **Add your own people** (other auditors) under **Users**: email, role, **Invite**. A person can be given one of the built-in
   roles or one of your [custom roles](#who-can-do-what-roles-and-custom-roles).
6. **Give each auditor their clients.** Only the **organisation admin** sees every client. A lead auditor, auditor, read-only or
   dashboard-only user sees **only the clients assigned to them**, and until you assign one they see none (an empty list is
   not a fault). On **Tenants**, press **Auditors** next to the client, choose the person and press **Assign to** (the client's name follows). The same panel
   lists who is assigned already and has a **Remove** button.
7. **Invite the client's people.** On **Tenants**, press **People** next to the client, type the person's work email, choose
   what they are and press **Invite to** (the client's name follows). The choices are **Client lead** (sees every control and hands them out),
   **Contributor** (only the controls assigned to them), **Viewer** (read-only) and **Client dashboard** (the dashboard only),
   and below those any [custom role](#who-can-do-what-roles-and-custom-roles) you have made for a client's people. Their email must
   end in the domain you gave the client in step 2, or the page says the domain isn't allowed. Inviting is done by you, the audit
   firm, so you decide who from the client can sign in and what each may do; the same panel lets you change a person's access
   later (**Access**) or switch them off. The invitation link is printed in the portal's window (or emailed, once mail is set up);
   the person opens it, chooses a password, and lands on **My controls**.

Then, as an auditor, open the client's **Dashboard**: the client's first audit cycle is created from the ISO 27001:2022 template
on first open (a client's own people see "not set up yet" until then). From there the client's lead assigns controls to their people
(**My controls → Assign**), they upload evidence, and you review it; the [demo's tour](#the-live-demo) shows that loop.

## The live demo

`https://arjun-1404.github.io/iso27k-evidence/` is this repository's own web app, built with `npm run build:demo`
instead of `npm run build`. The difference is one switch: instead of calling the API over the network, the page
answers its own API calls from a small pretend server written in TypeScript (`frontend/src/demo/`). The screens, the
buttons and the rules you see are the real ones. The server behind them is not.

- **Sign in:** one click as the lead auditor, organisation admin, auditor, client lead or client contributor of a
  fictional audit firm ("Harbourview Assurance") and its fictional clients. Their password is `demo-password-123`;
  the sign-in page also has the ordinary form.
- **A guided tour (demo only):** the **Take the 3-minute tour** button opens a checklist: the client uploads and submits
  evidence, the auditor accepts it, the dashboard moves, the audit log records it, plus a bonus step to turn on two-step
  sign-in. The steps tick themselves, and **Switch to Priya Shah / Declan Walsh** buttons sign you in as the right person.
  A step ticks only when the thing really happened (a refused action ticks nothing). The real app has no tour.
- **Your changes are yours alone.** They live in your browser tab (session storage), survive a page reload, and are
  gone when the tab closes. **Reset demo** (top of the page) puts the sample data back at any time. Nobody else can
  see what you do, and nothing is stored on any server.
- **Files you upload** are kept in memory for as long as the page stays open; after a reload they download as a
  placeholder PDF. The sample evidence files are placeholders too.
- **Two-step sign-in is real code, not a mock-up**: it uses the same one-time-code maths as the real server (checked
  against the RFC 6238 test vectors), so an authenticator app should accept the demo's QR code (not tried with a real
  phone yet).
- **Not in the demo:** email (the screens that would send one say so), the malware scanner, connecting Google Drive or
  S3 (the demo only pretends to use the server's own disk), and the server settings page.

**What the demo does *not* prove.** The pretend server re-implements the real server's rules (who may see and do what,
which status changes are allowed, the lock on a closed audit cycle, sign-in limits, two-step policy) in about
2,700 lines of TypeScript, and its tests spell those rules out. But in a real installation those rules are enforced
by PostgreSQL itself (row-level security, constraints and triggers), and **nothing in the demo exercises that**. If
you want to know how secure the real thing is, read `db/migrations/` and run `npm run verify`, not the demo. The demo's
copy of the ISO 27001:2022 control list is checked against the real one by a test. The rest could drift from the real
server over time; the checks that the two agree are written by hand, not generated.

**Publishing your own copy of the demo** (for example on a fork): put the repository on GitHub, then Settings → Pages
→ Build and deployment → Source: **GitHub Actions**. The workflow `.github/workflows/pages.yml` runs on every push to
`main`: it tests the demo, builds it, checks that the real app has none of it, and publishes
`https://<your-user>.github.io/<your-repo>/`. To try it locally: `cd frontend && npm ci && npm run build:demo &&
npx vite preview --outDir dist-demo`. If you rename the repository, change the "Get the code" address with the
`VITE_DEMO_REPO_URL` build variable (default: `https://github.com/Arjun-1404/iso27k-evidence`), and the address that
link previews use for the demo's picture with `VITE_DEMO_SITE_URL` (default: `https://arjun-1404.github.io/iso27k-evidence/`).

**Link previews.** The demo's page carries a picture and a line of text (`og:image`, `og:title`), so a pasted link shows a
card on LinkedIn, Slack and in messages. The picture is `frontend/demo-assets/share-card.png` (1200 × 630) and only the
demo build includes it; `docs/social-preview.png` (1280 × 640) is the same card for GitHub: upload it under the
repository's Settings → General → Social preview. LinkedIn and others remember a link's card, so after changing the picture,
refresh it with LinkedIn's [Post Inspector](https://www.linkedin.com/post-inspector/).

## Server settings: email, scanning and Google Drive, from the web app

The mail server, the malware scanner and the Google Drive app are set up in the web app, under **Server settings**,
instead of in `.env`. One set for the whole installation (every audit firm using this server shares them), and only
the installation's **owner** sees the page.

- **Who is the owner?** The first administrator created with `db:bootstrap-admin`. There is exactly one. To hand it
  over: `docker compose run --rm -e ADMIN_EMAIL=new-owner@yourorg.example migrate npm run db:grant-platform-owner`
  (the new owner must be an active organisation admin). On an installation upgraded from an earlier version, the
  earliest-created active administrator becomes the owner automatically.
- **What is set there:** the mail server (host, port, encryption, login, From address); the ClamAV scanner (host,
  port, time limit, largest file); and the Google Cloud app (client ID, client secret, redirect address) that "Connect
  Google Drive" signs people in through. Each card has a status — *Set up here*, *Not set up*, or *locked* — and the
  email and scanner cards have a **test** button.
- **Changes apply at once.** The next email, upload or Google sign-in uses the new values; there is no restart. (If you
  run several copies of the API, the others pick the change up within about five seconds.)
- **What still lives in `.env`:** `DATABASE_URL` and the passwords, `JWT_SECRET`, `SECRET_ENCRYPTION_KEY`, the public
  addresses, CORS and `TRUST_PROXY`. Those are needed before the database can be read, or are what unlocks the
  secrets stored in it, so they cannot be kept in it.
- **`.env` wins.** If a group is set in `.env` (as in older installs), the page shows its values, marks them *locked*
  and refuses to change them, so there is never a doubt about which one the server is using. Remove those lines from
  `.env` and restart once to manage that group in the web app instead.
- **Secrets are write-only.** The mail password and the Google client secret are encrypted with
  `SECRET_ENCRYPTION_KEY` before they are stored and are **never sent back to a browser**: the page only says that
  one is saved, and leaving the field empty keeps it. Without the key, the page says so and refuses to store them
  (the scanner, which has no secret, can still be set up).
- **Saving asks for your password again** (and a code, if you use two-step sign-in). Mail settings decide where
  password-reset links are sent, so a borrowed session must not be able to change them. Typing mistakes are reported
  *before* the password is checked, so they never count toward the sign-in lockout.
- **The test buttons are narrow on purpose.** "Send me a test email" goes only to the owner's own address — nothing in
  the request can choose another recipient. "Check the scanner" sends the standard EICAR antivirus test string
  and passes only if the scanner reports it as a virus, so a scanner that answers but catches nothing is called out.
- **Everything is audited, without the values.** The tamper-evident audit log records that the owner saved or removed a
  group and which *fields* changed (`host`, `password`...) — never what they were changed to.
- **If what was saved can't be used** (the encryption key was changed, or the data is damaged), the group counts as *not
  set up* with the reason shown on the card — it is never used half-way. If the database can't be reached for a moment,
  the last values that loaded keep working.
- **Trust.** The owner chooses which hosts the server connects to for mail and scanning, so the owner is fully
  trusted with respect to the server itself — that is why there is exactly one, why saving needs the password again,
  and why every change is in the audit log.

## The dashboard

The first page for the audit firm, and one click away for the client. It is the same screen in the real app and in the demo.

- **Audit readiness:** how much of what applies has been accepted, as one large figure (accepted controls out of
  *applicable* ones, so a control marked not applicable never counts against anyone).
- **Needs attention:** what to act on first. The audit firm sees overdue, rejected and waiting for review; the client sees
  overdue, rejected and still needing evidence. A line with nothing in it says so instead of disappearing.
- **Where the controls stand:** one bar and the same numbers as a list, across the six statuses. Rejected is the only red.
  Controls marked **not applicable** are listed under the bar, apart from it, and are not counted in it.
- **Controls at a glance:** a tile for every control, grouped by clause and Annex A theme and shaded by status. The legend
  narrows the grid to one status, hovering or focusing a tile names the control, and pressing a tile opens that control
  (the audit firm on **Controls**, the client's people on **My controls**). **View as table** gives the same counts as
  rows. People who are shown no controls (a role limited to the dashboard) see no grid; a contributor sees only the controls
  assigned to them, and the grid says so. A control marked not applicable has a colour of its own, a violet hatched tile
  marked ⊘ (it is not red, because red means "rejected"), and has its own entry in the legend.
- **Progress by section:** one meter per section.

No colour is ever the only signal: every shade has a name in the legend, in the tile's label and in the table view, and
rejected tiles carry a mark (✕) as well as their red, and not-applicable tiles a mark (⊘) as well as their hatching. The shades come from one colour scale checked for colour-blind readers.

## Audit cycles (one audit per year, per client)

A client can have any number of audit cycles: the first certification audit, then a surveillance audit each year, and
so on. Each cycle is its own complete set of controls, status and evidence, started fresh from the template; earlier
cycles stay exactly as they were.

- **Starting one:** a lead auditor or an organisation admin presses **New audit cycle** next to the cycle chooser on the
  Controls or Dashboard page, picks the template and gives it a name.
- **Switching:** everyone with more than one cycle gets a chooser (**Audit cycle**) on Controls, Dashboard and My
  controls. The choice is remembered per client, per browser; without a choice the newest cycle is shown.
- **Where the files go:** in your storage, each client's folder holds one folder per cycle, which holds one folder per
  control: `Client / ISO 27001 audit 2027 [1a2b3c4d] / A.8.5 / the files`. The short code at the end of the cycle's
  folder name comes from its id, so two cycles with the same name can never share a folder. If you rename or move these
  folders by hand in Drive, new uploads for that control keep going to the folder the portal already recorded.

A finished cycle can be *closed* so that it stays exactly as it was signed off — see the next section.

## What applies, due dates, and closing a control yourself

These are decisions for the audit firm, made on the **Controls** page or in a control's panel (press its row). The client is
never made to deal with a control that doesn't concern them.

- **Applicable: Yes / No.** The **Applicable** column is a drop-down for a **lead auditor** or an **organisation admin**
  (an auditor sees the answer but can't change it). Choosing **No** asks *why it doesn't apply* (at least 3 characters)
  before anything changes; the reason is kept with the control. From then on the client's people no longer see that
  control on **My controls**, nothing is asked of them, it can't be reminded about or reviewed, and it doesn't count towards
  progress (readiness is accepted out of *applicable* controls). On the dashboard it has its own colour (see
  [The dashboard](#the-dashboard)). Choosing **Yes** brings it back. Clauses 4 to 10 are mandatory and always apply: they
  have no choice. The **Reason** link next to a **No** changes the reason.
- **Due dates.** Open a control: **Due date** → pick a day → **Save** (or **Clear**). A control that is not applicable has none.
- **Closing a control without waiting for the client.** An **organisation admin**, **lead auditor** or **auditor** can accept a
  control the client never submitted evidence for: something seen on site, said in an interview, or already held. On the
  row press **Close…**, or open the control and press **Close without client evidence**, write the reason and
  **Confirm close**. The control becomes **Accepted** with no file, the reason is added to the control's comments (so the
  client can see why it was closed, unless the closer's role may not comment) and `control.close` is written to the audit
  log with the reason. A reason of at least 3 characters is required. It works from not started, awaiting evidence and
  rejected. It says plainly why when it can't be done: the control is marked not applicable (there is nothing to close),
  it is already accepted, the client has submitted evidence (review it and accept or reject it instead), or the audit
  cycle is closed.
- **Where the rules live:** in the database (`db/migrations/016_firm_close_and_custom_roles.sql`), not only in the screens.
  Closing is allowed only when a "close" review with a reason has been written in the same step, so no other way of
  changing a control can skip the evidence rule.

## Closing an audit cycle

When an audit is signed off, a **lead auditor** or an **organisation admin** presses **Close audit cycle** on the
Controls page. A short explanation appears first (and a count of any applicable controls that were not accepted, which
stay as they are); **Yes, close it** then makes the cycle read-only.

- **What stops:** every change to the cycle. No evidence can be uploaded or removed, no control can be reviewed,
  marked not applicable, given a different requirement or due date, reminded about, assigned or unassigned, no
  comment or finding can be added, and the cycle cannot be renamed. The screens take those buttons away and say why;
  if a page was opened before the cycle was closed, the server refuses the change in plain words
  ("This audit cycle is closed, so it can no longer be changed…"), the page shows that message, and (after a reminder or
  a submit) updates itself to show the closed notice; otherwise a reload does.
- **What still works:** looking at everything (controls, evidence records, comments, the dashboard, the audit log), and
  the evidence integrity check. The check still *notices* a stored file that was changed or has gone missing since,
  flags the file and writes the finding to the audit log (marked as being on a closed cycle), but it leaves the
  control's status alone: the sign-off stays as it was. Reopening is how you put it back under review.
- **Reopening:** the same two roles press **Reopen audit cycle** and must give a reason (3 to 1000 characters).
  Everything works again straight away. Other cycles of the same client, and other clients, are never affected.
- **The record:** closing writes `audit.closed` (who, which cycle, how many applicable controls and how many accepted)
  and reopening writes `audit.reopened` (who, the reason, and when and by whom it had been closed) to the
  tamper-evident audit log. The database writes both entries itself, in the same step, so neither can happen unlogged.
- **Where the rule lives:** in the database (`db/migrations/014_close_audit_cycle.sql`, using triggers), not only in the
  screens, so it holds however a change arrives — through the web app, a future API route or a script. The only
  way to change the status is the two functions `audit_close` and `audit_reopen`; the application's database role has no
  permission to write it directly. Uploads are refused before anything is created in your storage, and a file that was
  sent while the cycle was being closed is not recorded (it stays in your storage folder).
- **Not covered:** the files themselves sit in your Google Drive, and closing does **not** make that folder read-only
  there. Anyone with edit rights in Drive can still change or delete a file directly; the integrity check will then
  flag it. Locking the Drive folder is not built (it could not be tested here without a real Drive).
- **An archived client:** its cycles can't be closed or reopened (restore the client first), like every other change.

## Who can do what: roles and custom roles

Every person has one **built-in role**. The audit firm's side: **Organisation admin** (runs everything and sees every
client), **Lead auditor** (runs the audits of the clients assigned to them: what applies, due dates, requirements, people,
closing cycles), **Auditor** (reviews evidence and sends reminders), **Read-only reviewer** and **Dashboard only**. The
client's side: **Client lead**, **Contributor**, **Viewer** and **Client dashboard**. The **Roles** page (organisation admin only)
lists them all with a line on what each is for.

When a built-in role can do too much for someone, make a **custom role**: the same role with some abilities taken away, and a name
of your own. Examples: a *Junior auditor* (an auditor who can review but not send reminders), or a *Contributor who can only
upload* (no comments).

- **Making one:** **Roles** → *New custom role*: a name, the role it is based on, and the abilities as tick boxes. Everything the
  base role can do starts ticked; **untick what should be taken away**. Only an organisation admin makes, changes or deletes them.
  Changing one takes effect at once for everyone who has it. The base role can't be changed afterwards. A role can't be deleted
  while someone has it, and names are unique.
- **Giving one:** to your own staff under **Users → Access**; to a client's people under **Tenants → People → Access**, or
  when inviting them (the role list shows the built-in roles, then your custom ones). Only the audit firm hands them out: a client
  lead can't give or lift a restriction, and nobody can change their own access. The organisation admin role can't be
  restricted or changed this way.
- **What can be taken away:** *Review controls* (accept, reject, close), *Send reminders*, *Set applicable / not applicable*,
  *Set due dates*, *Change evidence requirements*, *Assign controls*, *Invite and manage people*, *Comment*, *Close and
  reopen audit cycles* and *Upload and submit evidence*. Each base role has only some of these to begin with (a contributor
  can only lose *Upload* and *Comment*); the tick boxes show just those.
- **It can only take away, never add.** A custom role is a built-in role with less: the person is still that built-in role
  underneath, so every existing rule applies to them and a custom role can't be used to reach anything their built-in role
  couldn't. This is also why the organisation admin isn't customisable: a custom role able to edit custom roles could give
  itself its abilities back.
- **What the person sees:** the buttons they can't use are hidden. That is courtesy only: the database refuses the action
  in any case (`app_allows()` in `016_firm_close_and_custom_roles.sql`), with a plain message.
- **A client lead can still invite contributors and viewers on their own** (it is not removed, to keep working as before). If
  you would rather invite all of a client's people yourself, give the client lead a custom role without *Invite and manage
  people*.
- Every invitation, change of access and role change is written to the audit log (`user.invited`, `user.access_changed`,
  `role.created`, `role.updated`, `role.deleted`).

## Giving controls to your client's people

A client's **contributor** only sees the controls assigned to them, so someone has to assign them. Client leads see every
control, and lead auditors and organisation admins can assign on a client's behalf.

- **Many at once:** on the **Controls** page (lead auditor / organisation admin), the **Assign controls** panel gives one
  person all the applicable controls, or all those of one section (for example "A.8 Technological controls"), in one
  step. Up to 200 at a time, all or nothing; controls the person already has are left alone and reported ("12
  controls assigned (3 already were)").
- **One at a time:** open a control; **Assigned to** lists who has it, with a **Remove** button and a chooser to add
  someone. Client leads do the same from **My controls → Assign**.
- **Who can be chosen:** contributors and client leads whose account is active or invited (not switched off). The
  database refuses anyone else, whatever the screen offers. If the client has no such people yet, invite them first on
  **Tenants → People**.
- Every assignment and removal is written to the audit log (`control.assigned` / `control.unassigned`).

## Where evidence is kept: Google Drive, this server's disk, or S3

Each organisation (the audit firm) chooses **one** place for its evidence, in the web app under **Settings → Integrations**.
All three work the same for the people using the portal; what differs is where the bytes end up.

| | Google Drive | This server's disk | S3-compatible storage |
|---|---|---|---|
| Where files go | the firm's own Drive | a folder on the machine the portal runs on | a bucket on Amazon S3, MinIO, Ceph, Wasabi, Backblaze B2, Cloudflare R2… |
| Set up by | the installation owner (Google app, see below), then an org admin connects | the installation owner sets `LOCAL_STORAGE_DIR`, then an org admin switches it on | an org admin enters the bucket details (needs `SECRET_ENCRYPTION_KEY` on the server) |
| Uploads travel | browser → Google directly | browser → the portal → the disk | browser → the portal → the bucket |
| Downloads | through the portal | through the portal | through the portal |

**The choice is fixed once the first evidence file exists.** A recorded file only means something in the storage it was put in,
so the database itself refuses to switch afterwards (it is not only a greyed-out button). Until then an admin can switch freely;
switching clears the evidence folders already created for tenants (the page asks first), and they are created again in the new place.
SharePoint appears on the page as "coming later".

### This server's disk

For an organisation that runs the portal on its own server and wants the evidence to stay there.

1. The installation owner sets `LOCAL_STORAGE_DIR` in `.env` to an **absolute** folder that exists and that the portal can write
   to (`D:/EvidenceFiles`, `/var/lib/evidence-portal/files`), and restarts. With Docker Compose use `LOCAL_STORAGE_DIR=/data/evidence`
   — that folder is the `evidence-files` volume. On Windows with the launcher, if nothing is set the files go to
   `%USERPROFILE%\EvidencePortal\files` (deliberately outside the portal's own folder, which a newer version replaces).
   The launcher prints the folder when it starts.
2. An org admin opens **Settings → Integrations → This server's disk → Use this server's disk**, then creates each tenant's folder.
3. Each organisation gets its own sub-folder (`<org name> [<id prefix>]`), each tenant and control a folder below that.

**Back this folder up: it *is* the evidence.** The database holds only names, sizes and checksums. Restoring the database without the
folder (or the other way round) leaves records pointing at nothing. Put the folder on a disk you already back up, and restrict
who can read it at the operating-system level — anyone who can read the folder can read the evidence.

How it protects the files: names are checked so nothing can escape the folder (`..`, absolute paths, drive letters, device names,
symlinks out of it are refused); a file is never replaced once stored (a second upload with the same name gets `(2)`);
each file's SHA-256 is recorded at upload and checked again later, so a file edited on the disk is flagged as *changed since
acceptance*; files the scanner flags are moved to a `_quarantine` folder rather than deleted.

### S3-compatible storage

1. Create a bucket and an access key that can **list, read, write and delete** objects in it (nothing else is needed). Use a key
   made for this portal, not an administrator's.
2. The installation owner needs `SECRET_ENCRYPTION_KEY` in `.env` (the same key Google Drive uses; `node scripts/init-env.mjs`
   makes one). The secret access key is stored encrypted with it and is never shown again.
3. As an org admin: **Settings → Integrations → S3-compatible storage → Set up**. Fill in:
   - *Service address* — leave empty for Amazon S3; for anything else the service's URL (`https://minio.example.com:9000`).
   - *Region* — for Amazon S3 the bucket's region; many self-run services accept any value (`us-east-1` is fine).
   - *Bucket*, *Folder inside the bucket* (optional), *Access key ID*, *Secret access key*.
   - *Path-style addresses* — tick for MinIO and most services you run yourself; leave unticked for Amazon S3.
   Press **Test connection** first (nothing is saved), then **Save and use S3 storage**.
4. Create each tenant's folder on the same page.

Things to know:
- **Private addresses are refused by default.** A MinIO on `10.x.x.x`, `192.168.x.x` or `localhost` is rejected so that one
  organisation on a shared installation cannot point the server at things inside its network. If the installation is your own, set
  `STORAGE_ALLOW_PRIVATE_ADDRESSES=true` in `.env`. Cloud-metadata addresses (`169.254.x.x`) are refused whatever this says.
- **Once evidence exists** only the access keys can be replaced; the bucket, folder and address are fixed.
- **Files up to 25 MB** (the portal's upload cap) are held in memory for the length of one upload.
- **Nothing is overwritten.** Each write asks the service to refuse an existing name ("only if nothing is there") and the portal
  checks first as well, for services that don't support that.
- **Back up the bucket** (versioning or replication) as you would any evidence store.

### Downloading evidence

Every file listed on a control has a **Download** button. The portal fetches the file from the storage with the person's own
session (so the usual access rules apply) and always sends it as a download of unknown type — never as a page the browser
might display or run, because evidence is whatever people uploaded. Each download is written to the audit log (`evidence.downloaded`).

## Connecting Google Drive

If the organisation chooses Google Drive, the evidence files live in *its own* Drive, not ours. The organisation connects its
own account once, and from then on every upload and integrity check runs against that account. (This is one of three
choices; see [Where evidence is kept](#where-evidence-is-kept-google-drive-this-servers-disk-or-s3).)

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials), enable the **Google
   Drive API**. Set up the **OAuth consent screen** (now called *Google Auth Platform*): audience **External**
   (or **Internal** if every user is in your own Google Workspace), and while the app is in **Testing**, add every Google
   account that will click Connect under **Audience → Test users** — *without that, Google answers "Access blocked"*.
   Then create an OAuth client of type *Web application* and add `<API_PUBLIC_URL>/oauth/google/callback` as an authorised
   redirect URI (for a test on one computer: `http://localhost:3000/oauth/google/callback`, character for character —
   `localhost`, not `127.0.0.1`, no trailing slash).
   An External app left in Testing also makes Google expire the saved connection after about 7 days; publish the consent
   screen (the `drive.file` permission this app asks for is a narrow one) or reconnect.
2. As the installation's owner, open **Server settings → Google Drive app**, paste the client ID and secret and the
   redirect address (the card suggests the right one), and save. (The older way still works: set
   `GOOGLE_OAUTH_*` and `SECRET_ENCRYPTION_KEY` in `.env` and restart — see [Server settings](#server-settings-email-scanning-and-google-drive-from-the-web-app).)
   Leave them unset and Drive features simply answer "not configured"; the rest of the app still works.
3. Sign in as an org admin, open **Settings → Integrations**, and click **Connect Google Drive**. Approve
   access on Google's screen; you land back on that page with the connection shown as active.
4. For each client (tenant), press **Create folder in Google Drive** next to its name on the same page. The app creates a folder
   named *Evidence Portal – <client>* in the connected Drive and files that client's uploads under it.

Why step 4 exists: the app asks Google for only the narrow `drive.file` permission, which means it can
see **only files and folders it created itself** — it cannot browse, read or change anything else in the
Drive. That is a deliberate privacy choice, and the consequence is that it can't be pointed at a folder
you made by hand; it makes its own.

**If Google shows "Access blocked":** the line under it says why. *Error 403: access_denied* / "developer-approved testers" →
the Google account you chose on that screen is not in **Test users** (above). *Error 400: redirect_uri_mismatch* → the address
in Google's client and the one in Server settings differ by even one character, or Google has not yet applied a change you
just saved (wait a few minutes). *invalid_client* → the client ID is wrong or from another project. *invalid_request* → the
client is not of type *Web application*. "Blocked by your administrator" → a Google Workspace admin restricts which apps that
account may use; try another account. The address bar of Google's page shows the `redirect_uri` and `client_id` this portal sent.

**If "Create folder in Google Drive" answers "Storage error: Drive permission denied (403)…":** the rest of the message gives
Google's reason and the fix. The usual cause is that the **Google Drive API was not enabled** in step 1 (signing in works
without it; any Drive request is refused): Google Cloud console → *APIs & Services* → *Library* → *Google Drive API* →
*Enable*, wait a minute, try again. Otherwise the Drive permission was unticked on Google's screen (disconnect, connect
again, leave it ticked), or the connected account's Drive is full.

The refresh token Google hands back is encrypted (AES-256-GCM) before it is stored, and never leaves the
server. If an admin later revokes access from their Google account, the next upload attempt notices,
marks the connection as revoked, writes it to the audit log, and the Integrations page offers
**Reconnect**.

## Email (invitations and reminders)

The portal sends four kinds of email: invitations (a link to set a password), evidence reminders, password-reset
links, and [security notices](#security-notice-emails) about changes to someone's own sign-in. It speaks
plain SMTP, so any provider works — Microsoft 365, Google Workspace, Amazon SES, Postmark, SendGrid, or your
own mail server. The owner enters the server, From address and, if the provider needs a login, the username and
password under **Server settings → Email** (or sets `SMTP_HOST`, `EMAIL_FROM`, `SMTP_USER` / `SMTP_PASSWORD` in
`.env` — see `.env.example`). The connection must be encrypted: STARTTLS by default, or implicit TLS
with `SMTP_SECURITY=tls`. If the server doesn't offer encryption, nothing is sent and the password is never
transmitted — it does not quietly fall back to plain text.

- **Not configured?** The portal still runs, but emails are *not sent*: they are printed to the server log, and
  startup says so loudly. Invite links work like passwords, so don't run a real deployment that way.
- **Mail server down?** A new invite is still saved and the page says the email didn't go out — press **Resend
  invite** once mail works. A *resend* or a *reminder* that can't be delivered changes nothing (the old invite
  link keeps working; the control's once-a-day reminder allowance isn't used up).
- **Safe by construction:** plain text only, recipients must be simple addresses, anything that could inject
  extra headers or recipients is refused, and failure logs never contain addresses or the message body (which
  holds the sign-in link).
- **To try it without a real mail account:** put `SMTP_HOST=mailpit`, `SMTP_PORT=1025`, `SMTP_SECURITY=none`
  and `EMAIL_FROM=noreply@portal.local` in `.env` and run `docker compose --profile dev-mail up`. Every email
  then appears at http://localhost:8025. For trying things out only.

## Forgotten passwords

The sign-in page has a **Forgot password?** link. The person enters their email and, if an account exists, gets
a link that works **once** and expires after **1 hour**. Opening it lets them choose a new password; they are then
sent back to sign in (holding a reset link is never by itself enough to hold a session).

- **Nobody can tell who has an account.** The answer to "send me a link" is identical whether the address is
  known, unknown, disabled, still waiting on an invite, or asking too often — and it doesn't wait for the mail
  server, so the one slow step (SMTP) can't give a real account away. (The few milliseconds of database work for
  a real account are not hidden; the per-address request limit makes measuring them at scale impractical.) If the
  email can't be sent, that is written to the server log (without the address or the link) and the visitor sees
  nothing different.
- **The database enforces the rules**, not just the application: 1-hour life, single use, at most **3 links per
  account per hour** (so the form can't be used to flood someone's inbox), and using one link voids the
  account's others. Only a hash of each link's secret is stored, and the app's database role can't read the table.
- **A reset ends old sessions.** Anyone signed in before the reset — including someone who had learnt the old
  password — is signed out on their next request. A disabled account's sessions stop working immediately too. It
  also clears any login lockout. (Sessions are compared to the second, so one started in the *same* second as the
  reset can survive it.) This costs the API one small indexed lookup per request.
- **Invited but never signed up?** There is no password to reset yet. They use the invite email, or an admin
  presses **Resend invite**; the page tells them so.
- Both steps are written to the tamper-evident audit log (`user.password_reset_requested`, `user.password_reset`).

### Request limits and reverse proxies

The signed-out endpoints (sign in, accept invite, forgot password, reset password) also limit how often one
address can call them: 60 sign-in attempts and 10 reset requests per 15 minutes. That is flood protection;
the real brute-force defences are the per-account lockout and the per-account reset limit above, which live in the
database. Counters are kept in the API process's memory, so with several API replicas each counts separately.

If you put a reverse proxy (nginx, Caddy, a cloud load balancer...) in front of the API, set **`TRUST_PROXY`** to
the number of proxies in front (usually `1`). Otherwise every visitor looks like the proxy and shares one
allowance. The portal notices an `X-Forwarded-For` header arriving while `TRUST_PROXY` is `0` and says so in the
log. It must be a count, never "true": believing every forwarded address would let a visitor pick their own.
Leave it at `0` when browsers connect to the API directly (the default Docker Compose setup).

## Malware scanning (ClamAV)

Every uploaded file is streamed from your storage into a ClamAV daemon before it is recorded as evidence;
infected files are refused. Only the file's bytes go to ClamAV — never its name.

1. Run ClamAV: with Compose, start with `docker compose --profile scanning up` (it needs about 2 GB of memory, and
   downloads virus signatures on first start — give it a few minutes). Or use a `clamd` you already run. Without Docker,
   see [ClamAV without Docker](#clamav-without-docker-windows-and-linux) below.
2. As the installation's owner, open **Server settings → Malware scanning**, enter the host (`clamav` with Compose,
   `127.0.0.1` for a `clamd` on the same computer) and save (it asks for your password), then press **Check the scanner**.
   (Or set `CLAMD_HOST` / `CLAMD_PORT` in `.env` and restart.)

**Check the scanner** asks clamd whether it is alive and then sends it the standard EICAR antivirus test string, straight
from memory (nothing is written to a disk, so antivirus software on the computer does not react). It says the scanner is
working only if clamd answers *and* flags the test string.

**Test it with a real upload.** Make a text file whose only content is the EICAR line (the 68 characters on
https://www.eicar.org/download-anti-malware-testfile/), upload it as a contributor to any control and press confirm: the
upload is refused with "flagged by malware scanning", nothing is recorded, and the audit log has an `evidence.infected`
entry. Then upload an ordinary file: it is accepted and its scan result reads "clean". Windows Defender (and most antivirus
programs) delete the EICAR file the moment it is saved; create it in a folder you have excluded in Windows Security →
Virus & threat protection → Manage settings → Exclusions, and remove the exclusion afterwards.

### ClamAV without Docker (Windows and Linux)

The portal only needs a `clamd` it can reach over TCP (default port 3310); it does not care how it was started.
- *Linux:* `sudo apt install -y clamav-daemon clamav-freshclam`, then in `/etc/clamav/clamd.conf` add
  `TCPSocket 3310` and `TCPAddr 127.0.0.1` and restart it (`sudo systemctl restart clamav-daemon`; on Debian and Ubuntu
  systemd may open the port itself, in which case also restart `clamav-daemon.socket`, or run
  `sudo dpkg-reconfigure clamav-daemon` and choose TCP). The first start waits until `freshclam` has downloaded the
  signatures. *Run by hand with `clamd -c <config file>` and those two lines, it worked with the portal; the systemd
  variants have not been tried.*
- *Windows:* download the 64-bit Windows package from https://www.clamav.net/downloads (the installer, or the zip) into
  e.g. `C:\ClamAV`. In PowerShell, in that folder, as administrator:
  ```
  copy conf_examples\clamd.conf.sample clamd.conf
  copy conf_examples\freshclam.conf.sample freshclam.conf
  notepad clamd.conf
  notepad freshclam.conf
  ```
  In **both** files delete the line that says `Example`. In `clamd.conf` make sure these lines are present and not
  commented out (use `127.0.0.1`, because `localhost` can resolve to an address clamd is not listening on):
  `TCPSocket 3310`, `TCPAddr 127.0.0.1`, and a `LogFile` pointing into `C:\ClamAV`. In `freshclam.conf` make sure
  `DatabaseDirectory` points to a folder that exists (e.g. `C:\ClamAV\database`). Then download the signatures and start the
  daemon:
  ```
  .\freshclam.exe
  .\clamd.exe
  ```
  `clamd.exe` prints a few lines and then appears to hang: that is it running; leave the window open. To have it start with
  Windows, run `.\clamd.exe --install` once as administrator and start the **ClamAV ClamD** service from `services.msc`;
  run `.\freshclam.exe` regularly (a scheduled task) to keep the signatures current. *The author has not run ClamAV on
  Windows; the settings above are ClamAV's own, and "Check the scanner" tells you at once whether they worked.*
- ClamAV needs roughly 1–2 GB of memory while it holds the signatures.

- **Infected file?** It is refused, never recorded as evidence, and **moved out of the evidence folder**, never deleted for
  good: into the **trash of your Google Drive**, into a `_quarantine` folder inside the server's evidence folder, or into a
  `_quarantine/` prefix in your S3 bucket, depending on where evidence is kept. The person uploading is told
  what happened, and the **audit log** gets an `evidence.infected` entry saying who uploaded which file to which
  control and whether it was moved. If Drive can't be reached at that moment, the upload is still refused and the
  person is told to delete the file from the folder themselves; the audit log entry says it was *not* quarantined.
- **Not configured?** Files are recorded as **"skipped"** — never "clean" — so a reviewer can see nothing checked
  them. Startup says so.
- **ClamAV down?** Uploads are *refused* with a retryable error ("scanning is unavailable, try again in a few
  minutes") rather than recorded unchecked. The file is already in your storage, so the user simply confirms again
  once ClamAV is back.
- **Files over 25 MB** (ClamAV's default stream limit, and the portal's own upload cap) are recorded as
  "unscannable" so they get a manual look. Raise `StreamMaxLength` in `clamd.conf` and `CLAMD_MAX_FILE_MB` together
  if you need more.

## Two-step sign-in (authenticator app)

Everyone can turn on a second step under **Security** in the left-hand menu: after the password, sign-in asks for
the 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy...).
Turning it on means entering the password again, scanning a QR code (or typing the key), and entering the first
code; the portal then shows **ten recovery codes, once**. Each recovery code signs you in one time if the phone
is lost.

- **It needs `SECRET_ENCRYPTION_KEY`** (the same key Google Drive uses, `openssl rand -hex 32`). The authenticator
  secret is stored encrypted with it, and the database never sees the secret in the clear. Without the key the
  Security page says two-step sign-in isn't available and nobody can turn it on. **Back the key up, and don't
  change it:** a different key can't decrypt the stored secrets, so every authenticator code would stop working
  (recovery codes and an admin reset still do).
- **It fails closed.** If an account has it on but the server can't check codes (no key, or the wrong one), the
  answer is an error — never a way in. A recovery code is a complete second proof that needs no key, so it still works.
- **The database enforces the rules**, so no application bug can weaken them: a code works **once** (the same code
  is refused even within its 30 seconds; a phone clock up to 30 seconds out is forgiven), **five wrong codes lock
  two-step sign-in for the account for 15 minutes** (wrong authenticator codes, wrong or already-used recovery
  codes, and replays all count; while locked even a correct code is refused), recovery codes are stored only as
  hashes, are single-use and belong to one account, and every change is in the tamper-evident audit log
  (`user.mfa_enabled`, `user.mfa_disabled`, `user.mfa_recovery_codes_regenerated`, `user.mfa_recovery_code_used`,
  `user.mfa_locked`, `user.mfa_reset`). Neither table can be read or written by the app's database role.
- **Taking protection away needs two proofs.** Turning it off, or getting new recovery codes, asks for the password
  *and* a code — so a borrowed, still-open browser session isn't enough. Wrong passwords there count toward the
  same lock-out as the sign-in page.
- **The password step alone proves nothing.** An account with it on gets back a five-minute challenge, not a
  session; the challenge is signed with a different key and issuer from sessions, so it can't be used as one (and
  the reverse). A correct password doesn't clear the failed-attempt count — only finishing the second step does.
  **Resetting a password by email does not skip the second step.**
- **Lost phone, with recovery codes:** sign in with a recovery code, then turn two-step off and on again under Security.
- **Lost phone, no recovery codes:** an organisation admin presses **Reset two-step** next to the person on the Users
  page (it asks to confirm). That switches it off for them, signs them out everywhere, and is audited. Only org
  admins can, never for themselves, never outside their organisation. **Keep at least two org admins.** If the only
  admin loses both phone and codes, there's no way back inside the app; as the database owner you can run
  `DELETE FROM user_mfa WHERE user_id = (SELECT id FROM users WHERE email = '...');`,
  `DELETE FROM mfa_recovery_codes WHERE user_id = (SELECT id FROM users WHERE email = '...');` and
  `UPDATE users SET sessions_valid_after = now() WHERE email = '...';` (the last signs them out everywhere).
- **A trade-off you should know about:** because wrong codes lock the account for 15 minutes, someone who already
  knows a person's password can keep them out of two-step sign-in by deliberately guessing wrong. The lock isn't
  extended by hammering, and it needs the password first; the alternative (no lock) would let the same person
  guess the 6-digit code. Choosing safety over availability here is deliberate.
- **Single sign-on accounts** (no password in this portal) are told two-step is managed by their identity provider.
- Admins see a **Two-step on/off** label next to each person on the Users page; nobody else is told who has it.

## Changing your password, and requiring two-step sign-in for everyone

**Changing your own password** is under **Security** → **Password**. It asks for the current password (and a code,
if two-step sign-in is on), and the new one twice. Two things happen that are worth knowing:

- **Every other session you have is signed out** — your phone, another browser, anyone who had borrowed your
  password. The page you are on carries on without a break (the server hands it a fresh session). Sessions are
  ended by the database comparing each token's issue time with the moment of the change, to the second; a session
  started in the *same second* as a change survives it. That is a deliberate limit of the approach, not a bug.
- **The wrong current password counts toward the same five-attempts lock-out as the sign-in page**, so a borrowed
  open browser can't be used to guess it. The one-time code is only spent once the cheap checks pass: a typo in the
  new password, or choosing the same password, never costs you a code.
- Accounts that sign in through a single sign-on provider have no password here and are told so.
- It is written to the audit log as `user.password_changed` (no password material).

**Requiring two-step sign-in** is a setting for organisation admins, under **Security** → **Organisation policy**:

| Setting | Who must use two-step sign-in |
| --- | --- |
| Off (default) | Nobody; everyone may choose. |
| Staff only | Everyone in your organisation; your clients' people are not required to. |
| Everyone | Staff and your clients' people. |

How it behaves, and the trade-offs you are choosing:

- **Someone it covers who hasn't set it up** can still sign in with their password, but the server refuses
  everything except setting two-step sign-in up (`403 MFA_SETUP_REQUIRED`), and the web app keeps them on the
  Security page until they have. The rule is checked on **every request** by the database, so switching it on (or
  off) takes effect for people who are already signed in. The cost is one small extra query per request.
- **The server can't fail open.** If that check can't reach the database, the request fails with a server error; it
  is never waved through.
- **People it covers can't turn their own two-step sign-in off.** If someone loses their phone and recovery codes, an
  organisation admin presses **Reset two-step** on the Users page; the person then sets it up again.
- **An admin can only switch the rule on once their own two-step sign-in is on**, so you can't lock yourself out by
  switching it on. Switching it **off** is always allowed. **Keep at least two organisation admins**: if the only
  admin is reset and loses the phone, only direct database access can unstick them.
- **It needs `SECRET_ENCRYPTION_KEY`** (as two-step sign-in itself does). The page won't let you switch the rule on
  without it. If the key is lost later, anyone who hasn't set up yet is blocked until it is restored, and anyone
  who has can still sign in with a recovery code; an admin who is already enrolled can switch the rule off that way.
- **Single sign-on accounts and disabled accounts are never covered** (the provider handles it for the former), and
  the "X of Y have set it up" counts leave them out. The counts are numbers only; nobody is named.
- Every change is written to the audit log as `org.mfa_policy_changed` (with the old and new setting).

## Security notice emails

When something happens to someone's own sign-in that could be the first sign of a takeover, the portal emails **the
address on their account**, so the real owner finds out even if the person who did it wasn't them. A notice is sent
when:

| Event | Subject |
| --- | --- |
| The password is changed (Security page) | Your Evidence Portal password was changed |
| The password is reset with an emailed link | Your Evidence Portal password was reset |
| Two-step sign-in is turned on | Two-step sign-in was turned on for your Evidence Portal account |
| Two-step sign-in is turned off | Two-step sign-in was turned off for your Evidence Portal account |
| A new set of recovery codes is created | New recovery codes were created for your Evidence Portal account |
| A recovery code is used (to sign in, or to confirm a change) | A recovery code was used on your Evidence Portal account |
| An administrator resets someone's two-step sign-in | Your Evidence Portal two-step sign-in was reset |

Each says what happened and when (in UTC, spelled out), what to do if it wasn't them (a link to reset the password,
and "tell the administrator of your organisation"), and that the portal will never ask for a password or code by
email. A recovery-code notice also says how many codes are left, and suggests a new set when three or fewer remain.

The rules these keep, each pinned down by `tests/44-security-notices-http.test.ts`:

- **They never contain a secret.** No password, link token, authenticator secret, recovery code, password hash or
  internal account id, and no other person's name: an administrator's reset says "an administrator", not which one.
- **Only after the change really happened.** A wrong password, a wrong or already-used code, a weak or unchanged
  password, a refused request (not signed in, not an admin, the organisation requires two-step), or an administrator
  resetting someone who had nothing to reset, sends nothing. Starting to set up two-step sign-in sends nothing
  either; finishing it does.
- **Only to the address on file, and only for an active account.** Disabled and not-yet-accepted accounts get none.
  Only the person it happened to is told; the administrator who did a reset is not mailed.
- **A mail problem never reaches the person.** Notices are sent in the background after the answer is already on its
  way: a mail server that is down, slow or rejecting the message never slows, fails or changes the response, and the
  change is not undone. A failure is logged as `[email] security notice (<kind>): …`, never with the address.
  On shutdown the server waits up to five seconds for notices still in flight.

Trade-offs worth knowing:

- **Best-effort, not guaranteed.** If the server crashes in the instant after a change, or the mail server is down,
  that notice is lost. The change itself is still in the audit log, which is the record of truth.
- **No notice for lock-outs or failed sign-ins.** Anyone can type wrong passwords for someone else's address, so
  mailing on those would let a stranger flood a person's inbox.
- **Without SMTP configured, notices are printed to the server log** like every other email. They hold nothing
  secret, but they do name the account's address in the "to" line the log prints; configure SMTP on a real deployment.
- **Admins are not told when the organisation's two-step rule is switched** (it is in the audit log), and a notice
  goes only to the one address on file: if an attacker already controls that mailbox, a notice reaches them too.
  Reset links already have that property; use a mailbox with its own two-step sign-in.

## Security

**Reporting a problem.** Please report a vulnerability privately, not as a public issue: see [SECURITY.md](SECURITY.md)
(GitHub's *Report a vulnerability* button on the repository's Security tab).

**What has been checked.** In November 2026 the author reviewed the code for weaknesses, scanned it for secrets, and
tried the running server from the outside, with the OWASP Top 10 as the checklist. It is a thorough self-review, **not
an independent penetration test**: before holding a client's real evidence, have someone else test your installation.
The review found, and this version fixes:

- The API and the web app sent no security headers. Both now send a strict Content-Security-Policy, no-framing,
  no-sniffing, no-referrer and no-cache headers (the API) and HSTS when the request came over HTTPS. The Docker web app
  (`frontend/nginx/`) and `scripts/serve-web.mjs` send the same ones, and a test keeps them identical.
- Malformed or oversized JSON, and an id that was not an id, gave a 500. They now give a 400 or 413 with a fixed message.
- Sign-in revealed which addresses have accounts: an unknown address answered in 2 ms instead of about 250 ms, and only
  real accounts were ever locked. Unknown addresses now cost the same time and lock in the same way.
- Passwords like `password1234`, `Password1234!` or twelve `a`s were accepted. A password built on a common word, a keyboard or
  alphabet run, or a few repeated characters is now refused, and so is one over 72 characters (what bcrypt can use).
- The portal started happily with the example secrets from `.env.example`. It now refuses to start with the example or a
  short `JWT_SECRET`, or with the example database password, and the migration command refuses the example
  `POSTGRES_PASSWORD` / `APP_DB_PASSWORD`.
- Only HS256 is accepted for session tokens (the algorithm is pinned instead of left to the token), and `.env` files
  are kept out of the web app's Docker build.

**What was looked for and not found:** SQL built from user input (every query is parameterised; the few that assemble SQL
only join fixed column names), HTML injection (the web app never inserts raw HTML), path traversal in the disk storage and
the web server, forged or `alg=none` tokens, cross-site request forgery (sign-in uses a header token, not cookies), server-side
request forgery through the S3 address (private, link-local and metadata addresses are refused, again at connect time),
secrets in the code, the logs or the web app, and known-vulnerable libraries in what the portal ships (`npm audit`).

**Known limits, left as they are**

- The session token is kept in the browser's local storage, so a script injected into the page could read it. The web app
  inserts no raw HTML and its Content-Security-Policy blocks inline and outside scripts, which is what stands in the way.
  The token lasts 12 hours and stops working when the account is disabled or its password is reset.
- A person who knows an address can lock that account for 15 minutes by typing wrong passwords. That is the price of lockout.
- Request limits and the unknown-address lock are kept in the API's memory: several API copies count separately, and a restart forgets them.
- Without `SMTP_HOST`, invitation and reset links are printed to the server log (the startup log says so). Never run that way
  for real use: anyone who can read the log can use the links.
- The Docker images run their programs as the image's default user (root in the API image). A bug in the portal would
  therefore have more reach than it needs; running containers read-only and as an unprivileged user is a good hardening step.
- A `dev` dependency (`picomatch`, used only by the test tools) has a published advisory with no patched version. It is not
  in the shipped portal.

**Before real use**

1. Generate the secrets with `npm run setup` (or the Docker command in [Installation](#installation)).
2. Serve it over HTTPS and set `APP_BASE_URL` and `CORS_ALLOWED_ORIGINS` to the real address.
3. Behind a reverse proxy, set `TRUST_PROXY`; otherwise the per-address limits see only the proxy.
4. Set up email (`SMTP_HOST`) and, if evidence comes from outside your organisation, malware scanning.
5. Turn on [two-step sign-in](#two-step-sign-in-authenticator-app) for staff at least, and back up the database, the evidence
   storage and the `SECRET_ENCRYPTION_KEY`.
6. Keep the portal, Node, PostgreSQL and the container images up to date.

## Structure

```
db/migrations/        SQL migrations (schema, RLS policies, triggers). Numbered, additive, never edited
                       after being applied — a schema change is a new migration file.
db/seed/               The ISO 27001:2022 control catalogue, as JSON.
src/storage/           StorageProvider interface + three real providers: GoogleDriveProvider, LocalDiskProvider
                       (localDisk.ts) and S3Provider (s3.ts), plus two test doubles, the Google OAuth client,
                       encrypted token handling, and the per-organisation resolver (resolver.ts) that turns "this
                       user's org" into a ready-to-use provider. safeNames.ts keeps file and folder names safe,
                       addressGuard.ts refuses S3 addresses inside a private network (unless allowed),
                       uploadTokens.ts signs the short-lived link used to upload through the portal.
src/services/storageSettings.ts  Choosing and connecting a storage (disk, S3), and the lock once evidence exists.
src/email/, src/scan/, src/auth/
                       Same pattern: one interface (types.ts), real implementations, fakes for tests.
                       email: SmtpEmailSender (real) + a log-only fallback. scan: ClamAvScanner (real, clamd's
                       TCP protocol) + FakeClamd, a strict stand-in daemon. auth: JwtTokenVerifier for the
                       built-in login, alongside the documented-but-untestable Auth0/OIDC option.
src/wiring.ts          Chooses the real email sender / scanner when configured, and a clearly-labelled
                       fallback when not.
src/http/middleware/   CORS, auth, camelCase, the per-address request limiter (rateLimit.ts) and the security headers
                       every API answer carries (securityHeaders.ts).
src/secretsCheck.ts    Refuses the example secrets from .env.example and weak ones at start-up.
src/auth/phantomLockout.ts
                       Makes an address with no account cost the same time and lock the same way as a real one.
frontend/nginx/        The web app's nginx settings and security headers (the Docker route).
SECURITY.md            How to report a vulnerability privately, what is in scope, and how to run it safely.
src/auth/totp.ts, mfaToken.ts
                       Authenticator codes (RFC 6238, written against node:crypto alone and checked against the
                       RFC's own test vectors), recovery codes, and the five-minute "password accepted" challenge.
src/auth/sessionCheck.ts  Asks the database whether a still-unexpired session token is still good (account
                       disabled, or password reset/changed since it was issued).
src/http/middleware/mfaPolicy.ts
                       Enforces the organisation's two-step policy on every signed-in request (fails closed).
src/services/folderNames.ts  Names of the per-audit-cycle folders in the firm's storage.
src/services/roles.ts  Custom roles: a built-in role with some permissions taken away (never added).
src/services/platformSettings.ts, driveConnect.ts, oauthState.ts
                       The Server settings page's storage, and connecting an organisation's Google Drive (the signed
                       state that ties the Google redirect back to the person who started it).
src/services/audits.ts  Starting, closing and reopening audit cycles. The rules themselves (who may, the
                       lock on a closed cycle) are in db/migrations/014_close_audit_cycle.sql.
src/services/users.ts  Inviting people, and assigning controls (one, or many at once) with plain-language refusals.
src/settings/          Server settings stored in the database (mail, scanner, Google): runtime lookup with caching,
                       the live wrappers that pick up a change without a restart, and validation.
scripts/verify.mjs     `npm run verify`, the one-command check. scripts/init-env.mjs is `npm run setup`.
scripts/check-demo-build.mjs
                       Checks the real web app contains none of the live demo, and the demo is complete and can be
                       served from any folder (part of `npm run verify`).
frontend/src/demo/     The live demo's pretend server and its sample data (see "The live demo"). Loaded only by
                       `npm run build:demo`.
.github/               CI workflow, weekly deliberate-breakage workflow, the GitHub Pages workflow that publishes
                       the live demo (pages.yml), Dependabot.
src/services/account.ts  Changing your own password (ends your other sessions, hands back a fresh one).
src/services/notices.ts  Security notice emails: the wording (pure, tested directly) and the background notifier
                       the services call after a change has been made.
src/services/          Business logic as plain functions (pool, userId, ...args) => result. No HTTP
                       here — usable from the Express app, a worker, or a CLI equally.
src/http/               Express routes. Thin: parse input, call a service, return it. All error
                       handling goes through one mapper (src/errors.ts) so the database's own rules
                       (role checks, status transitions, domain restrictions) come back as clean HTTP
                       responses without any route needing to know about them individually.
src/db/*-cli.ts         Command-line entrypoints: db:migrate, db:seed, db:bootstrap-admin (creates the
                        very first org and admin, since there's no public sign-up by design).
src/index.ts            Public exports — import from here, not from internal file paths.
src/server.ts           Real wiring for a deployment. Built-in auth, password reset, the Google Drive
                        connection, per-organisation storage access, SMTP email and ClamAV scanning are
                        live (the last two switch on when configured); external OIDC and SharePoint are
                        the remaining optional pieces, each behind a small interface.
tests/                  See below.
```

## Why it's built this way

Every external dependency (storage provider, email, malware scanner, auth) is an interface in its own
`types.ts`, with at least one real implementation and one fake. Nothing in `src/services` or `src/http`
imports a concrete implementation directly — they take the interface as a parameter. That's what makes
each piece replaceable on its own:

- Add SharePoint by writing a `SharePointProvider` that implements `StorageProvider` (as the disk and S3 providers do) and
  adding it to the resolver and the Integrations page. Google Drive, the disk and S3 were each added that way.
- Use a different scanner or mail API by writing a `Scanner` / `EmailSender` implementation. Same.
- Add Auth0/OIDC by writing a `TokenVerifier` implementation and swapping it in `server.ts`. The
  built-in email+password login keeps working for anyone who doesn't need that.
- The database enforces every security and business rule that matters (tenant isolation, roles, status
  transitions, account lockout) — see `db/migrations/`. The service layer above it is deliberately
  thin, so a bug in application code can't bypass a rule the database already guarantees.

## Checking the whole project: `npm run verify`

```
npm run verify                 # about 7 minutes (nine checks)
npm run verify -- --mutation   # also the deliberate-breakage checks (about an hour)
```

One command that runs everything that can be checked automatically: the types, every server test, every web app test,
the web app's production build, the live demo's build (plus a check that the real web app contains none of the demo and that
the demo can be served from any folder), and a security check of the libraries the project depends on (`npm audit`; skipped with
a clear note if you're offline). Each check prints one line; a failing check shows the end of its output and the others
still run, so one go shows everything that's wrong. The exit code is 0 only if nothing failed. It installs the libraries
first if they are missing.

The same command runs in GitHub on every change (`.github/workflows/ci.yml`), the deliberate-breakage checks run there
weekly (`mutation.yml`), and Dependabot (`.github/dependabot.yml`) opens a pull request when a library, a GitHub Action or
the Docker base image has a new version. Both need the project to be on GitHub; if you only keep it on your own computer,
`npm run verify` is all you need.

The tests start their own throwaway database, using the `embedded-postgres` package for your computer. That was only
run on Linux; macOS and Windows should work (the package has builds for both and the test setup picks the right one) but
that hasn't been confirmed. If it doesn't start on your machine, run `npm run verify` in Docker or on a Linux machine.

## Running the tests

```
npm test
```

Starts a real, throwaway PostgreSQL instance (via the `embedded-postgres` dev dependency — nothing
external, no Docker needed), runs every migration against it, and runs all tests against that real
database. Nothing here is mocked at the database layer.

`scripts/mutation-check.py` is a second layer: it deliberately breaks one security rule at a time — a database
rule in a copy of the migrations, or application code in a throwaway copy of the project — and confirms the test
suite notices. Run it with `python3 scripts/mutation-check.py` after changing any RLS policy, trigger, constraint
or security-relevant code, or pass some text to run only the breakages that mention it (e.g.
`python3 scripts/mutation-check.py rateLimit`). A breakage only counts as caught if tests actually ran and failed;
a run that never got as far as running tests is reported as broken, not as a success. It takes a while (it runs
the tests once per breakage), so don't run it alongside the normal test suite. The frontend has its own,
quicker one: `python3 scripts/frontend-mutation-check.py`.

## What isn't tested here, and why

The environment this was built in had no network access to Google, Microsoft, or any external identity provider.
`GoogleDriveProvider` is tested against `FakeDriveApi`, and the OAuth handshake and token refresh against
`FakeGoogleOAuthApi`; both speak the real request/response shapes, so the adapters' own logic (folder
caching, retries, pagination, error mapping, the code exchange, refresh and revocation handling) is
genuinely exercised. What isn't and can't be tested here is an actual round trip to `googleapis.com` with
real credentials — do one by hand (steps above) before relying on it. The built-in auth path (password hashing, invite tokens,
JWT issuance and verification, account lockout, password reset and session revocation) has no such excuse and is
fully tested end to end, including over real HTTP against a real server process — see `tests/16-auth-service.test.ts`,
`tests/17-auth-http.test.ts`, `tests/34-password-reset-db.test.ts`, `tests/36-password-reset-http.test.ts`,
`tests/38-mfa-db.test.ts`, `tests/39-totp.test.ts`, `tests/40-mfa-http.test.ts`,
`tests/41-security-policy-db.test.ts`, `tests/42-change-password-http.test.ts`, `tests/43-mfa-policy-http.test.ts`,
`tests/44-security-notices-http.test.ts`, `tests/70-security-hardening.test.ts` (the fixes from the [security review](#security)) and
`tests/33-real-server-email-and-scan.test.ts`.

**Disk and S3 storage** are tested for real, not against fakes: the disk provider on a real filesystem (path escapes, symlinks,
exclusive create, integrity, quarantine) and the S3 provider against a real S3 server (moto) over HTTP, through the whole path
from signed upload link to download and audit log. What that cannot show:
- **Amazon S3 itself, MinIO, Wasabi, Backblaze B2, Cloudflare R2…** — moto speaks the S3 protocol, but each service has its own
  quirks (permissions, region names, support for "write only if absent"). Press **Test connection** against yours, upload a file,
  and download it again before relying on it. Messages for a wrong key or bucket name are tested against error shapes, not every service.
- **Browser upload to Google Drive** — the portal now tells Google which page the upload comes from, which Google needs for
  browser uploads; only the fake Drive checks that. Do one real upload through the browser after connecting Drive.
- **The Docker volume for `evidence-files`** and the Windows default folder have not been run on real Docker / Windows.
- **Very slow or stalled uploads** to the portal's `/uploads` address are not specially timed out; put a reverse proxy with a
  request timeout in front of a public installation.

Two-step sign-in is tested with the RFC 6238 published test vectors, and the QR code is decoded back with a real QR
decoder to prove it holds exactly the address an authenticator app needs. What isn't tested here is a *real phone
app* scanning it — after deploying, turn two-step on for your own account and sign in once with your own phone.

Email is tested against a real SMTP server running locally (so STARTTLS, AUTH and the SMTP conversation are
real, including the refusal to send without TLS); malware scanning against `FakeClamd`, which speaks clamd's
real protocol over a real socket and rejects malformed streams. The scanner client was also run once, by hand, against a
*real* ClamAV 1.5.4 daemon on Linux (loaded with a one-line signature for the EICAR test string): it answered the ping, flagged
the EICAR string, passed ordinary files, reported a file over the size cap as unscannable, and refused to guess when no daemon
was listening. What the tests cannot show is how a *particular* provider (Microsoft 365, SES, ...) or ClamAV with the
full signature set on *your* machine behaves — after deploying, send yourself an invite and use **Check the scanner**
and the EICAR upload test above to confirm both ends.

**The live demo** (see [The live demo](#the-live-demo)) is a separate, simulated implementation of the server's rules, so it
is not evidence about the real server, and it can drift from it. What was checked: its own tests (about 170, including the guided tour, driving the real
web app's screens and its real API client against it: every role, review, upload and download, closing a cycle, two-step
sign-in with RFC 6238 vectors, lock-outs, the sample data against the real ISO 27001:2022 list), a build check that the real
web app contains none of it, and manual runs in real Chromium (served from a sub-folder, the way GitHub Pages serves it, at
laptop width and an emulated 390 px phone screen, with no sideways scrolling, console errors or requests to any other
address). Those browser runs used a throwaway Playwright script that is not part of this repository. The redesigned dashboard, the controls grid and the tour were checked the same way (14 November 2026) as the lead auditor, the client lead and a client contributor, with the tour's two person-switching buttons and a tile opening its control. What was not: Safari,
Firefox and a real phone. The Pages workflow has since run on GitHub (13 November 2026) and published the site.

Also worth knowing, found while writing the demo and left as it is: a read-only client user (viewer) can start an upload on the
real server and is only refused when the file is recorded; and the server's emails, its default storage folder name and the authenticator-app label still say
"Evidence Portal" rather than the repository's new name.

**The name.** `iso27k-evidence` is the name of the GitHub repository; whether it is free on npm or as a domain has not
been checked. Check before relying on it.

## Not yet built

- **The evidence integrity check has no screen.** The server can run it (`POST /audits/:id/integrity-check`), but there is no
  button for it in the web app yet and nothing runs it on a schedule.
- **A rejected control's reason isn't shown to the client** on **My controls**. It is recorded with the rejection and the
  auditor can also comment on the control, which the client does see.
- Passkeys / security keys. (Text-message codes are deliberately not offered: they are the weakest option.)
- A per-person "trusted device" memory for two-step sign-in (every sign-in asks for the code).
- Making a closed audit cycle's folder read-only in Google Drive itself (see
  [Closing an audit cycle](#closing-an-audit-cycle)). The portal-side lock is built and tested.
- SharePoint (planned next), and real external OIDC (Auth0 etc.) — OIDC has a tested fake standing in.
- Live round trips to Google and a real mail provider: each is tested against fakes that speak the real protocol, but
  neither has been run against the real thing with real credentials. This includes the Drive trash call used to quarantine
  infected files. The ClamAV client has been run once against a real daemon on Linux (see Testing), not on Windows.
- Building and running the Docker images (see the note under [4. Linux (with Docker)](#4-linux-with-docker)).
- Running the tests on macOS or Windows. On GitHub's Linux machines, `npm run verify` (the Verify workflow, including the
  S3 tests against a real moto server) and the Live demo workflow both passed on 13 November 2026; the weekly
  deliberate-breakage workflow (`mutation.yml`) has not been run there yet.
- An independent security review / penetration test. The author's own review is described under [Security](#security).
