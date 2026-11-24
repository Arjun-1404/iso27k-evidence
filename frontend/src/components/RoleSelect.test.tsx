import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RoleSelect, builtInValue, customValue, describeChoice, parseRoleValue, valueOfUser } from "./RoleSelect";
import { AbilityChecklist, deniedFrom, keptFrom } from "./AbilityChecklist";
import type { CustomRole, RoleCatalog } from "../api/types";

const CUSTOM: CustomRole[] = [
  { id: "r1", name: "Uploader", description: null, baseRole: "contributor", denied: ["comment"], memberCount: 1 },
  { id: "r2", name: "Open book", description: null, baseRole: "tenant_lead", denied: [], memberCount: 0 },
];
const CATALOG: RoleCatalog = {
  permissions: [
    { key: "upload", label: "Upload and submit evidence", hint: "Add evidence files." },
    { key: "comment", label: "Comment", hint: "Add comments." },
    { key: "review", label: "Review controls", hint: "Accept or reject." },
  ],
  baseRoles: [
    { role: "contributor", side: "client", allowed: ["upload", "comment"] },
    { role: "auditor", side: "firm", allowed: ["review", "comment"] },
  ],
};

describe("role choices", () => {
  it("a choice is 'role:<role>' or 'custom:<id>', and a person's current choice follows their custom role", () => {
    expect(builtInValue("viewer")).toBe("role:viewer");
    expect(customValue("r1")).toBe("custom:r1");
    expect(parseRoleValue("role:contributor")).toEqual({ role: "contributor" });
    expect(parseRoleValue("custom:r1")).toEqual({ customRoleId: "r1" });
    expect(valueOfUser({ role: "contributor", customRoleId: null })).toBe("role:contributor");
    expect(valueOfUser({ role: "contributor", customRoleId: "r1" })).toBe("custom:r1");
  });

  it("describes what a choice can't do, in words", () => {
    expect(describeChoice("role:viewer", CUSTOM)).toMatch(/look at the client's controls/);
    expect(describeChoice("custom:r1", CUSTOM)).toBe("Like a contributor, but can't: comment.");
    expect(describeChoice("custom:r2", CUSTOM)).toBe("Like a client lead, with nothing taken away.");
    expect(describeChoice("custom:gone", CUSTOM)).toBe("");
  });

  it("lists the built-in roles and, below them, the custom ones with the role they are based on", () => {
    render(<RoleSelect label="Role" value="role:contributor" onChange={() => {}} builtIn={["tenant_lead", "contributor"]} custom={CUSTOM} />);
    const select = screen.getByLabelText("Role");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Client lead", "Contributor", "Uploader (contributor)", "Open book (client lead)"]);
    expect(screen.getByText(/Uploads evidence for the controls/)).toBeInTheDocument();
  });

  it("shows no custom group when there are none, and reports a change", async () => {
    const onChange = vi.fn();
    render(<RoleSelect label="Role" value="role:contributor" onChange={onChange} builtIn={["tenant_lead", "contributor"]} custom={[]} />);
    expect(screen.queryByRole("group", { name: "Custom roles" })).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Role"), "role:tenant_lead");
    expect(onChange).toHaveBeenCalledWith("role:tenant_lead");
  });
});

describe("AbilityChecklist", () => {
  it("lists only what the base role can do, ticked when kept", () => {
    render(<AbilityChecklist catalog={CATALOG} base="contributor" kept={new Set(["upload"])} idPrefix="t" />);
    expect(screen.getByLabelText(/Upload and submit evidence/)).toBeChecked();
    expect(screen.getByLabelText(/Comment/)).not.toBeChecked();
    expect(screen.queryByLabelText(/Review controls/)).not.toBeInTheDocument();
  });

  it("reports the abilities kept as they are ticked and unticked", async () => {
    const onChange = vi.fn();
    render(<AbilityChecklist catalog={CATALOG} base="contributor" kept={new Set(["upload", "comment"])} onChange={onChange} idPrefix="t" />);
    await userEvent.click(screen.getByLabelText(/Comment/));
    expect([...onChange.mock.calls[0]![0]]).toEqual(["upload"]);
  });

  it("converts between 'kept' and 'taken away'", () => {
    expect([...keptFrom(CATALOG, "contributor", ["comment"])]).toEqual(["upload"]);
    expect(deniedFrom(CATALOG, "contributor", new Set(["upload"]))).toEqual(["comment"]);
    expect(deniedFrom(CATALOG, "contributor", new Set(["upload", "comment"]))).toEqual([]);
  });
});
