// The demo's guided tour: a short checklist that walks a visitor through the one story this product is about (the client
// hands over evidence, the auditor reviews it, the dashboard and the audit log show it). The steps tick themselves: the
// pretend server notices the matching request and records it (see DemoBackend.noteTour), so nothing here guesses from the
// screen, and a step ticks only when the thing it asks for really happened.

import type { Role } from "../api/types";

export type TourStepId = "upload" | "submit" | "review" | "dashboard" | "audit-log" | "two-step";

export interface TourStep {
  id: TourStepId;
  title: string;
  /** What to do, in the words of the screen (button and menu names as they are written there). */
  how: string;
  /** Which made-up person this step is done as, with a button that signs in as them and opens the right page. */
  switchTo?: { email: string; label: string; goTo: string };
  /** Not part of the main story; shown after it and not counted in "n of 5". */
  bonus?: boolean;
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: "upload", title: "The client hands over evidence",
    how: "Switch to Priya Shah, Brightwave's client lead. On My controls, press Upload on a control that has not been started, choose any file and press Upload.",
    switchTo: { email: "priya.shah@brightwave.example", label: "Switch to Priya Shah", goTo: "/my-controls" },
  },
  {
    id: "submit", title: "…and sends it for review",
    how: "Close the upload box and press Submit on the same control. It now waits for an auditor.",
  },
  {
    id: "review", title: "The auditor decides",
    how: "Switch to Declan Walsh, the lead auditor. On Controls (with Brightwave Software selected as the tenant), open a control marked Submitted and press Accept, or Reject and give a reason.",
    switchTo: { email: "declan.walsh@harbourview.example", label: "Switch to Declan Walsh", goTo: "/controls" },
  },
  {
    id: "dashboard", title: "The dashboard moves",
    how: "Open Dashboard. The counts and the completion figure now include what you just did.",
  },
  {
    id: "audit-log", title: "Every step is on the record",
    how: "Open Audit log (the lead auditor and the organisation admin can). It lists who uploaded, submitted and reviewed what, and when.",
  },
  {
    id: "two-step", title: "Bonus: turn on two-step sign-in", bonus: true,
    how: "Open Security and set up an authenticator app. The codes use the same maths as the real server, so a real authenticator app works with the demo's QR code.",
  },
];

/** The steps counted in "n of 5". */
export const MAIN_STEPS: readonly TourStep[] = TOUR_STEPS.filter((s) => !s.bonus);

/** Who looks at a client's evidence from the audit firm's side, and who may read the audit log. */
const LOG_READERS: readonly Role[] = ["org_admin", "lead_auditor"];

/**
 * Which step a successful request completes, if any. `done` is what is already ticked: the dashboard only counts once
 * somebody has reviewed something, because "the dashboard moves" means nothing before that.
 */
export function tourStepFor(method: string, path: string, user: { role: Role; tenantId: string | null } | null, done: readonly TourStepId[]): TourStepId | null {
  if (!user) return null;
  const clientSide = user.tenantId !== null;
  if (method === "POST" && /^\/controls\/[^/]+\/uploads\/confirm$/.test(path)) return clientSide ? "upload" : null;
  if (method === "POST" && /^\/controls\/[^/]+\/submit$/.test(path)) return clientSide ? "submit" : null;
  if (method === "POST" && /^\/controls\/[^/]+\/reviews$/.test(path)) return clientSide ? null : "review";
  if (method === "GET" && /^\/audits\/[^/]+\/dashboard$/.test(path)) return done.includes("review") ? "dashboard" : null;
  if (method === "GET" && path === "/audit-log") return LOG_READERS.includes(user.role) ? "audit-log" : null;
  if (method === "POST" && path === "/auth/mfa/enroll/confirm") return "two-step";
  return null;
}
