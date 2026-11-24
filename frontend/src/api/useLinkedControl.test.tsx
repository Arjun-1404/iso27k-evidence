// The deep link a dashboard tile uses: `?control=<id>` on the controls pages.

import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { useLinkedControl } from "./useLinkedControl";
import type { ControlSummary } from "./types";

const c = (id: string): ControlSummary => ({
  id, kind: "annex", section: "A.5", controlRef: `A.5.${id}`, title: id, effectiveEvidence: "", effectiveFileSpec: {},
  isOverridden: false, applicable: true, naJustification: null, status: "not_started", dueDate: null, requirementChangedAt: null, fileCount: 0,
});

function Probe({ controls, onFound }: { controls: ControlSummary[] | null; onFound: (c: ControlSummary) => void }) {
  useLinkedControl(controls, onFound);
  const loc = useLocation();
  return <p data-testid="where">{loc.pathname + loc.search}</p>;
}

const at = (route: string, controls: ControlSummary[] | null, onFound = vi.fn()) => {
  render(<MemoryRouter initialEntries={[route]}><Probe controls={controls} onFound={onFound} /></MemoryRouter>);
  return { onFound };
};

describe("useLinkedControl", () => {
  it("finds the control the address points at, tells the page once, and takes the parameter out of the address", () => {
    const { onFound } = at("/controls?control=2", [c("1"), c("2")]);
    expect(onFound).toHaveBeenCalledTimes(1);
    expect(onFound).toHaveBeenCalledWith(expect.objectContaining({ id: "2" }));
    expect(screen.getByTestId("where").textContent).toBe("/controls");
  });

  it("keeps any other parameters in the address", () => {
    at("/controls?audit=a1&control=1", [c("1")]);
    expect(screen.getByTestId("where").textContent).toBe("/controls?audit=a1");
  });

  it("waits for the controls to load, and does not use up the link before they have", async () => {
    const onFound = vi.fn();
    function Loading() {
      const [list, setList] = useState<ControlSummary[] | null>(null);
      return <><button onClick={() => setList([c("1")])}>load</button><Probe controls={list} onFound={onFound} /></>;
    }
    render(<MemoryRouter initialEntries={["/controls?control=1"]}><Loading /></MemoryRouter>);
    expect(onFound).not.toHaveBeenCalled();
    expect(screen.getByTestId("where").textContent).toBe("/controls?control=1"); // still there: nothing has been used up yet
    await userEvent.click(screen.getByRole("button", { name: "load" }));
    expect(onFound).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("where").textContent).toBe("/controls");
  });

  it("quietly ignores an id that is not in the list, and still clears the address", () => {
    const { onFound } = at("/controls?control=nope", [c("1")]);
    expect(onFound).not.toHaveBeenCalled();
    expect(screen.getByTestId("where").textContent).toBe("/controls");
  });

  it("does nothing at all when the address has no control in it", () => {
    const { onFound } = at("/controls", [c("1")]);
    expect(onFound).not.toHaveBeenCalled();
    expect(screen.getByTestId("where").textContent).toBe("/controls");
  });
});
