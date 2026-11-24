// How a control's status looks on the dashboard. The four steps of work in progress are ONE hue (the app's teal) that gets
// darker as the work gets closer to done, so a glance across the screen reads as "how full is this". "Not started" is
// deliberately empty, and "rejected" is the one thing that is red, because it is the one thing that needs someone to act.
// The teal steps were run through the colour-blind-safety check for ordered scales (lightness steps down evenly, the lightest
// is visible against white) and every fill has text of enough contrast on it. Every use of these colours is also labelled
// with the status's name, so colour is never the only way to tell them apart.

import type { ControlStatus } from "../../api/types";

/** Left to right in the status bar: done first, then the work still to do, and the exception last. */
export const STATUS_ORDER: readonly ControlStatus[] = ["accepted", "under_review", "submitted", "awaiting_evidence", "not_started", "rejected"];

export const STATUS_LABEL: Record<ControlStatus, string> = {
  not_started: "Not started", awaiting_evidence: "Awaiting evidence", submitted: "Submitted",
  under_review: "Under review", accepted: "Accepted", rejected: "Rejected",
};

export interface StatusLook {
  /** The fill of a bar segment, a swatch or a tile. */
  fill: string;
  /** Text printed on that fill: white or near-black, whichever reads better. */
  ink: string;
  /** Extra classes for a tile whose fill alone would vanish into the page (the empty "not started" tile). */
  edge: string;
}

const WHITE = "#ffffff";
const BLACK = "#0b0b0b";

export const STATUS_LOOK: Record<ControlStatus, StatusLook> = {
  accepted: { fill: "#115e59", ink: WHITE, edge: "" },
  under_review: { fill: "#0f766e", ink: WHITE, edge: "" },
  submitted: { fill: "#0d9488", ink: BLACK, edge: "" },
  awaiting_evidence: { fill: "#14b8a6", ink: BLACK, edge: "" },
  not_started: { fill: "#e5e7eb", ink: "#374151", edge: "" },
  rejected: { fill: "#d03b3b", ink: WHITE, edge: "" },
};

/**
 * "Not applicable" is its own thing, not a sixth step of progress and not a problem: a violet that none of the status colours
 * is near (checked together with the teal, the red and the grey for colour-blind separation), drawn as diagonal stripes with
 * a solid edge so it can't be mistaken for an empty or a filled tile, and always carrying the "⊘" mark or the words.
 */
export const NA_LOOK = { base: "#f5f3ff", stripe: "#c4b5fd", edge: "#7e22ce", ink: "#581c87" } as const;
/** The stripes, as a CSS background. */
export const NA_HATCH = `repeating-linear-gradient(135deg, ${NA_LOOK.stripe} 0, ${NA_LOOK.stripe} 2px, ${NA_LOOK.base} 2px, ${NA_LOOK.base} 6px)`;

/** The unfilled part of a meter: a pale step of the same teal, so "how much of the whole" reads across the full width. */
export const METER_TRACK = "#ccfbf1";
/** The filled part of a meter and of the readiness ring. */
export const METER_FILL = "#0d9488";

/** 48.2 stays 48.2; 50 becomes 50, not 50.0. */
export function formatPct(pct: number): string {
  return Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
}
