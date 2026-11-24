// The dashboard's building blocks, on their own: the readiness ring, the status bar, the "needs attention" list, the
// section meters and the controls grid. The page that assembles them is tested in pages/DashboardPage.test.tsx.

import { describe, expect, it } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { ControlStatus, ControlSummary, Dashboard } from "../../api/types";
import { ReadinessRing } from "./ReadinessRing";
import { StatusBar } from "./StatusBar";
import { NeedsAttention } from "./NeedsAttention";
import { SectionMeters } from "./SectionMeters";
import { ControlHeatmap } from "./ControlHeatmap";
import { formatPct, NA_LOOK, STATUS_LABEL, STATUS_LOOK, STATUS_ORDER } from "./statusStyle";

const dash = (over: Partial<Dashboard> = {}): Dashboard => ({
  total: 117, applicable: 112, notApplicable: 5, accepted: 54, overdue: 0, completionPct: 48.2,
  byStatus: [], bySection: [], ...over,
});

function control(id: string, over: Partial<ControlSummary> = {}): ControlSummary {
  return {
    id, kind: "annex", section: "A.5 Organizational controls", controlRef: `A.5.${id}`, title: `Control ${id}`,
    effectiveEvidence: "", effectiveFileSpec: {}, isOverridden: false, applicable: true, naJustification: null,
    status: "not_started", dueDate: null, requirementChangedAt: null, fileCount: 0, ...over,
  };
}

const inRouter = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe("formatPct", () => {
  it("keeps one decimal when there is one, and none when there is not", () => {
    expect(formatPct(48.2)).toBe("48.2");
    expect(formatPct(50)).toBe("50");
    expect(formatPct(0)).toBe("0");
    expect(formatPct(100)).toBe("100");
  });
});

describe("the status colours", () => {
  it("cover every status, in a fixed order, with a name for each and exactly one red", () => {
    expect(new Set(STATUS_ORDER).size).toBe(6);
    for (const s of STATUS_ORDER) {
      expect(STATUS_LABEL[s]).toBeTruthy();
      expect(STATUS_LOOK[s].fill).toMatch(/^#[0-9a-f]{6}$/i);
    }
    const reds = STATUS_ORDER.filter((s) => { const h = STATUS_LOOK[s].fill; return parseInt(h.slice(1, 3), 16) > 180 && parseInt(h.slice(3, 5), 16) < 100; });
    expect(reds).toEqual(["rejected"]);
  });
});

describe("the not-applicable colour", () => {
  it("is its own colour: not the red of a rejected control, and not any status colour", () => {
    expect(NA_LOOK.edge).not.toBe(STATUS_LOOK.rejected.fill);
    for (const status of STATUS_ORDER) {
      expect(NA_LOOK.edge).not.toBe(STATUS_LOOK[status].fill);
      expect(NA_LOOK.ink).not.toBe(STATUS_LOOK[status].ink);
    }
  });
});

describe("ReadinessRing", () => {
  it("says the figure in words for a screen reader, and shows it in big type", () => {
    render(<ReadinessRing accepted={54} applicable={112} completionPct={48.2} />);
    expect(screen.getByRole("img", { name: "48.2 percent complete: 54 of 112 applicable controls accepted" })).toBeInTheDocument();
    expect(screen.getByText("48.2")).toBeInTheDocument();
    expect(screen.getByText(/applicable controls accepted/)).toHaveTextContent("54 of 112 applicable controls accepted");
  });

  it("draws no fill at zero, and clamps nonsense into 0 to 100", () => {
    const { container, rerender } = render(<ReadinessRing accepted={0} applicable={112} completionPct={0} />);
    expect(container.querySelectorAll("svg circle")).toHaveLength(1); // the track only
    rerender(<ReadinessRing accepted={112} applicable={112} completionPct={140} />);
    expect(screen.getByRole("img", { name: /^100 percent complete/ })).toBeInTheDocument();
    rerender(<ReadinessRing accepted={0} applicable={0} completionPct={-5} />);
    expect(screen.getByRole("img", { name: /^0 percent complete/ })).toBeInTheDocument();
  });
});

describe("StatusBar", () => {
  const byStatus: Dashboard["byStatus"] = [
    { status: "accepted", count: 54 }, { status: "submitted", count: 6 }, { status: "awaiting_evidence", count: 30 },
    { status: "not_started", count: 20 }, { status: "rejected", count: 2 },
  ];

  it("names every part of the bar with its count and share, and lists all six states, the empty one greyed", () => {
    render(<StatusBar byStatus={byStatus} />);
    const bar = screen.getByRole("img", { name: /^Status of 112 applicable controls:/ });
    expect(bar).toHaveAccessibleName(expect.stringContaining("Accepted 54 (48%)"));
    expect(bar).toHaveAccessibleName(expect.stringContaining("Rejected 2 (2%)"));
    expect(bar).not.toHaveAccessibleName(expect.stringContaining("Under review")); // none: not in the bar's name
    for (const label of Object.values(STATUS_LABEL)) expect(screen.getByText(label)).toBeInTheDocument(); // but listed below
    expect(bar.children).toHaveLength(5); // a state with none draws no segment
  });

  it("lists the controls marked not applicable under the bar, apart from it, and says nothing when there are none", () => {
    const { rerender } = render(<StatusBar byStatus={byStatus} notApplicable={5} />);
    const row = screen.getByText(/Not applicable/).closest("p")!;
    expect(row).toHaveTextContent("(not counted above)");
    expect(row).toHaveTextContent("5");
    expect(screen.getByRole("img", { name: /^Status of 112 applicable controls:/ })).not.toHaveAccessibleName(expect.stringContaining("Not applicable"));
    rerender(<StatusBar byStatus={byStatus} notApplicable={0} />);
    expect(screen.queryByText(/Not applicable/)).not.toBeInTheDocument();
  });

  it("still counts a status it has never heard of, and copes with nothing at all", () => {
    const { rerender } = render(<StatusBar byStatus={[{ status: "archived" as unknown as ControlStatus, count: 3 }]} /* a status from a newer server */ />);
    expect(screen.getByText("archived")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /archived 3 \(100%\)/ })).toBeInTheDocument();
    rerender(<StatusBar byStatus={[]} />);
    expect(screen.getByRole("img", { name: "No applicable controls yet" })).toBeInTheDocument();
  });
});

describe("NeedsAttention", () => {
  it("tells the audit firm what is waiting for them, with the words and not just a colour", () => {
    render(<NeedsAttention auditorSide dashboard={dash({ overdue: 4, byStatus: [{ status: "rejected", count: 2 }, { status: "submitted", count: 5 }, { status: "under_review", count: 1 }] })} />);
    expect(screen.getByText("4 overdue")).toBeInTheDocument();
    expect(screen.getByText("2 rejected, back with the client")).toBeInTheDocument();
    expect(screen.getByText("6 waiting for review")).toBeInTheDocument();
    expect(screen.queryByText(/still need evidence/)).not.toBeInTheDocument();
    expect(screen.queryByText("All clear for now.")).not.toBeInTheDocument();
  });

  it("tells the client what still needs evidence instead", () => {
    render(<NeedsAttention auditorSide={false} dashboard={dash({ overdue: 1, byStatus: [{ status: "awaiting_evidence", count: 30 }, { status: "rejected", count: 3 }, { status: "submitted", count: 5 }] })} />);
    expect(screen.getByText("1 overdue")).toBeInTheDocument();
    expect(screen.getByText("3 rejected, needs a new upload")).toBeInTheDocument();
    expect(screen.getByText("30 still need evidence")).toBeInTheDocument();
    expect(screen.queryByText(/waiting for review/)).not.toBeInTheDocument();
  });

  it("when there is nothing to act on, says so calmly rather than going blank", () => {
    render(<NeedsAttention auditorSide dashboard={dash()} />);
    expect(screen.getByText("Nothing is overdue")).toBeInTheDocument();
    expect(screen.getByText("Nothing has been rejected")).toBeInTheDocument();
    expect(screen.getByText("Nothing is waiting for review")).toBeInTheDocument();
    expect(screen.getByText("All clear for now.")).toBeInTheDocument();
  });
});

describe("SectionMeters", () => {
  const sections = [
    { section: "A.5 Organizational controls", applicable: 37, accepted: 20 },
    { section: "A.6 People controls", applicable: 8, accepted: 8 },
    { section: "A.7 Physical controls", applicable: 0, accepted: 0 },
  ];

  it("gives each section a meter with its own figures, and no division by zero", () => {
    render(<SectionMeters sections={sections} />);
    const m = screen.getByRole("meter", { name: "A.5 Organizational controls: 20 of 37 accepted" });
    expect(m).toHaveAttribute("aria-valuenow", "20");
    expect(m).toHaveAttribute("aria-valuemax", "37");
    expect((m.firstElementChild as HTMLElement).style.width).toMatch(/^54\.05/);
    const empty = screen.getByRole("meter", { name: "A.7 Physical controls: 0 of 0 accepted" });
    expect((empty.firstElementChild as HTMLElement).style.width).toBe("0%");
  });

  it("marks a finished section with a tick as well as a full bar", () => {
    render(<SectionMeters sections={sections} />);
    const rows = screen.getAllByRole("listitem");
    expect(rows[1]!.querySelector("svg")).not.toBeNull(); // A.6 is complete
    expect(rows[0]!.querySelector("svg")).toBeNull();
    expect(rows[2]!.querySelector("svg")).toBeNull(); // nothing applicable is not "complete"
  });
});

describe("ControlHeatmap", () => {
  const controls: ControlSummary[] = [
    control("1", { status: "accepted" }),
    control("2", { status: "accepted" }),
    control("3", { status: "rejected", fileCount: 1, dueDate: "2026-12-01" }),
    control("4", { status: "awaiting_evidence" }),
    control("5", { applicable: false }),
    control("6", { section: "A.8 Technological controls", controlRef: "A.8.1", title: "Endpoint devices", status: "submitted", fileCount: 2 }),
  ];
  const hrefFor = (c: ControlSummary) => `/controls?control=${c.id}`;

  it("draws nothing for a person who is shown no controls", () => {
    const { container } = inRouter(<ControlHeatmap controls={[]} hrefFor={hrefFor} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("makes one tile per control, grouped by section with each section's own count", () => {
    inRouter(<ControlHeatmap controls={controls} hrefFor={hrefFor} />);
    expect(screen.getAllByRole("link")).toHaveLength(6);
    expect(screen.getByRole("heading", { name: /A\.5 Organizational controls/ })).toHaveTextContent("2 of 4 accepted");
    expect(screen.getByRole("heading", { name: /A\.8 Technological controls/ })).toHaveTextContent("0 of 1 accepted");
  });

  it("names each tile in words, so nothing depends on its colour", () => {
    inRouter(<ControlHeatmap controls={controls} hrefFor={hrefFor} />);
    expect(screen.getByRole("link", { name: "A.5.3 · Control 3 · Rejected · 1 file · due 2026-12-01" })).toHaveAttribute("href", "/controls?control=3");
    expect(screen.getByRole("link", { name: "A.8.1 · Endpoint devices · Submitted · 2 files" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "A.5.5 · Control 5 · Not applicable" })).toHaveAttribute("data-status", "na");
    expect(screen.getByRole("link", { name: /A\.5\.3/ })).toHaveTextContent("✕ A.5.3"); // rejected carries a mark besides its red
  });

  it("a tile with nowhere to go is a plain picture, not a link", () => {
    inRouter(<ControlHeatmap controls={controls} hrefFor={(c) => (c.applicable ? hrefFor(c) : null)} />);
    expect(screen.getAllByRole("link")).toHaveLength(5);
    expect(screen.getByRole("img", { name: "A.5.5 · Control 5 · Not applicable" })).toBeInTheDocument();
  });

  it("marks a not-applicable tile with a symbol as well as its own colour, and the legend can narrow the grid to those", async () => {
    inRouter(<ControlHeatmap controls={controls} hrefFor={hrefFor} />);
    const tile = screen.getByRole("link", { name: /A\.5\.5/ });
    expect(tile).toHaveTextContent("⊘ A.5.5");
    expect(tile).toHaveAttribute("data-status", "na");
    const legend = screen.getByRole("list", { name: "Filter by status" });
    const na = within(legend).getByRole("button", { name: /Not applicable 1/ });
    await userEvent.click(na);
    expect(tile.className).not.toMatch(/opacity-20/);
    expect(screen.getByRole("link", { name: /A\.5\.1/ }).className).toMatch(/opacity-20/);
  });

  it("names the control under the pointer or the keyboard focus", async () => {
    inRouter(<ControlHeatmap controls={controls} hrefFor={hrefFor} />);
    expect(screen.getByText(/Hover or focus a tile/)).toBeInTheDocument();
    await userEvent.hover(screen.getByRole("link", { name: /A\.5\.4/ }));
    expect(screen.getByText("A.5.4 · Control 4 · Awaiting evidence · 0 files")).toBeInTheDocument();
    await userEvent.unhover(screen.getByRole("link", { name: /A\.5\.4/ }));
    expect(screen.getByText(/Hover or focus a tile/)).toBeInTheDocument();
    act(() => screen.getByRole("link", { name: /A\.5\.1/ }).focus()); // the legend's buttons come first in tab order, so focus the tile directly
    expect(screen.getByText("A.5.1 · Control 1 · Accepted · 0 files", { selector: "p" })).toBeInTheDocument();
  });

  it("the legend lists only the states that occur, with their counts, and narrows the grid to one on a click", async () => {
    inRouter(<ControlHeatmap controls={controls} hrefFor={hrefFor} />);
    const legend = screen.getByRole("list", { name: "Filter by status" });
    expect(within(legend).getAllByRole("button")).toHaveLength(5); // not under review: none of those
    expect(within(legend).queryByRole("button", { name: /Under review/ })).not.toBeInTheDocument();
    const accepted = within(legend).getByRole("button", { name: /Accepted 2/ });
    await userEvent.click(accepted);
    expect(accepted).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("link", { name: /A\.5\.1/ }).className).not.toMatch(/opacity-20/);
    expect(screen.getByRole("link", { name: /A\.5\.3/ }).className).toMatch(/opacity-20/); // the others fade, they do not vanish
    await userEvent.click(accepted);
    expect(accepted).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("link", { name: /A\.5\.3/ }).className).not.toMatch(/opacity-20/);
  });

  it("has a table view with the same counts, and can go back", async () => {
    inRouter(<ControlHeatmap controls={controls} hrefFor={hrefFor} />);
    await userEvent.click(screen.getByRole("button", { name: "View as table" }));
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Controls by section and status" });
    const a5 = within(table).getByRole("row", { name: /A\.5 Organizational controls/ });
    // accepted, under review, submitted, awaiting evidence, not started, rejected, not applicable, total
    expect(within(a5).getAllByRole("cell").map((c) => c.textContent)).toEqual(["2", "0", "0", "1", "0", "1", "1", "5"]);
    const a8 = within(table).getByRole("row", { name: /A\.8 Technological controls/ });
    expect(within(a8).getAllByRole("cell").map((c) => c.textContent)).toEqual(["0", "0", "1", "0", "0", "0", "0", "1"]);
    await userEvent.click(screen.getByRole("button", { name: "View as tiles" }));
    expect(screen.getAllByRole("link")).toHaveLength(6);
  });

  it("says so when this person can see only some of the audit's controls", () => {
    const some: ControlSummary[] = [control("1"), control("2")];
    const { rerender } = inRouter(<ControlHeatmap controls={some} hrefFor={hrefFor} visibleOfTotal={117} />);
    expect(screen.getByText("Showing the 2 controls you can see.")).toBeInTheDocument();
    rerender(<MemoryRouter><ControlHeatmap controls={some} hrefFor={hrefFor} visibleOfTotal={2} /></MemoryRouter>);
    expect(screen.queryByText(/you can see/)).not.toBeInTheDocument();
  });
});

// A type check that the six statuses really are the whole union (a new status added to the API would fail to compile here).
const _all: Record<ControlStatus, true> = { not_started: true, awaiting_evidence: true, submitted: true, under_review: true, accepted: true, rejected: true };
void _all;
