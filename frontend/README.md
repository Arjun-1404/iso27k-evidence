# ISO 27001 evidence portal — frontend

A React + TypeScript single-page app (Vite, Tailwind) for the evidence portal's API (see `../README.md`). The same app is
also published as a [live demo](https://arjun-1404.github.io/iso27k-evidence/) that runs entirely in the browser (below).

## Structure

```
src/api/        ApiClient — a plain TypeScript class wrapping fetch, typed against the backend's JSON
                contract (src/api/types.ts). No React import here on purpose: it's reusable from a
                script, a test, or a different UI layer. ApiProvider/useApi expose it to components.
                useApiQuery.ts is the one data-fetching hook every page uses (loading/error/data,
                cancels its request on unmount or when its inputs change).
                useCurrentAudit.ts resolves which audit cycle a page is showing: the person's remembered
                choice for that client (kept in the browser, safely ignored if storage is blocked), else
                the newest. It creates the first one from the default template if an auditor-side caller
                finds none yet, and exposes the list of cycles and a way to switch.
                TenantProvider.tsx is the auditor-side tenant selector (persisted across reloads); a
                tenant-side user's own tenant comes from their session instead.
src/auth/        AuthClient interface, the same pattern as the backend's TokenVerifier: one interface,
                BuiltInAuthClient (the real default: the backend's own email + password sign-in, including
                the second step for accounts with two-step sign-in on — the half-finished sign-in is held
                in memory only, never stored), Auth0AuthClient (optional, a documented TODO, see below)
                and FakeAuthClient that most tests use.
src/components/  Shared UI: AppShell (nav), StatusBadge, RequirementEditor, ControlDetailDrawer,
                UploadModal, RequireAuth (route guard), QrCode (an SVG QR code via qrcode-generator; its
                test decodes the drawing with jsqr to prove an authenticator app can read it).
                ControlAssignment (who has a control, add / remove), BulkAssign (give one person many
                controls or a whole section at once), AuditCyclePicker (switch between a client's
                audit cycles; lead auditors and org admins can start a new one) and AuditCycleLock (the
                "closed" notice, and the Close / Reopen-with-a-reason buttons for lead auditors and org
                admins; every page takes its edit buttons away on a closed cycle). assignment.ts holds the
                rules for who may be offered as an assignee (the database enforces them regardless).
src/pages/       One file per route: Login, AcceptInvite, ForgotPassword and ResetPassword (all public),
                Dashboard, Controls (auditor side), MyControls (tenant side), TenantsUsers (admin),
                Integrations, ServerSettings (the install owner's mail / scanner / Google settings),
                AuditLog, Security (each person's own two-step sign-in settings). When the server stops accepting a signed-in session (it expired,
                or the password was reset elsewhere) the API client signs the person out and they land
                on the sign-in page (see onUnauthorized in api/client.ts).
src/demo/        The live demo's pretend server: a TypeScript class that answers the app's API calls from fictional sample
                data kept in the browser tab (sessionStorage), plus a sign-in panel and a banner. Loaded ONLY when
                the app is built with `npm run build:demo`; main.tsx imports it behind a build-time switch, and
                `npm run verify` checks the normal build contains none of it. It re-implements the real server's rules
                (it is not the real server): rules.test.ts spells each one out, and seed.test.ts compares the sample
                ISO 27001:2022 control list with the real one in ../db/seed/. See "The live demo" in ../README.md.
src/test/        Shared test setup: an MSW server (mocks the API at the HTTP layer, not per-function),
                a renderApp() helper that wraps a component with every provider pre-authenticated as a
                given fake user.
```

## The live demo

```
npm run build:demo                      # writes dist-demo/ (relative links, so it works from any folder)
npx vite preview --outDir dist-demo     # look at it locally
```

`npm run build` is the real app and never contains the demo. The demo build uses hash addresses (`#/controls`) so a plain
static host such as GitHub Pages needs no server settings. Changing the real API's behaviour? Change `src/demo/` to match
(or say in the pull request that it no longer does) and run the tests there: `npx vitest run src/demo`.

## Why it's built this way

Same principle as the backend: every external dependency (the API, auth) is an interface with a real
implementation and a fake, and nothing in `pages/` or `components/` imports a concrete implementation
directly. That's what makes `renderApp()` work — a whole page renders against a fully fake backend
(MSW) and a fully fake identity provider (FakeAuthClient), so tests exercise real component behaviour
end to end without needing either one running for real.

`ApiClient` mirrors the backend's actual JSON shapes (camelCase, via the backend's `camelCaseJson`
middleware) rather than guessing at a contract — `src/api/types.ts` was written by reading the real
route handlers, not assumed.

## Running the tests

```
npm test        # or: npx vitest run
npm run lint    # oxlint
```

From the project root, `npm run verify` runs this together with the server's checks, the production build and the
library audit. `python3 ../scripts/frontend-mutation-check.py` deliberately breaks one behaviour at a time and
confirms these tests notice (see `../CONTRIBUTING.md`).

Every page has at least one test exercising its real data flow against MSW-mocked responses shaped
like the actual API (not simplified stand-ins) — including the full upload round trip
(`MyControlsPage.test.tsx`) and the full accept/reject review flow (`ControlsPage.test.tsx`).

## What isn't tested here, and why

`Auth0AuthClient` (in `src/auth/types.ts`) is a documented stub — a real login flow needs a live
redirect to an identity provider, which this sandbox has no network access to. Every other piece
(`ApiClient`, every page, the upload flow, the review flow) is exercised against realistic mocked data,
the same honesty standard as the backend's `GoogleDriveProvider`.

## Not yet built

- The real Auth0/OIDC wiring described above.
- The Integrations page (`/settings/integrations`) covers Google Drive only; a SharePoint option arrives
  with the SharePoint adapter.
- Making a closed audit cycle's folder read-only in Google Drive. Closing, reopening and the lock inside the
  portal are built; the files in Drive can still be changed there directly.
- Visual polish. This takes its cues from the earlier mockup video but isn't a pixel-perfect
  recreation of it — the priority here was real, working, tested behaviour over visual fidelity.
