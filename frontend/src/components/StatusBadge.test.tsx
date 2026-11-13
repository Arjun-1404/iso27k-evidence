import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "./StatusBadge";

describe("StatusBadge", () => {
  it("renders the label for each status", () => {
    render(<StatusBadge status="awaiting_evidence" />);
    expect(screen.getByText("Awaiting evidence")).toBeInTheDocument();
  });

  it("shows N/A when na is true, regardless of the status value", () => {
    render(<StatusBadge status="accepted" na />);
    expect(screen.getByText("N/A")).toBeInTheDocument();
    expect(screen.queryByText("Accepted")).not.toBeInTheDocument();
  });
});
