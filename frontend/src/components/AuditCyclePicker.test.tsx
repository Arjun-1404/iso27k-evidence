import { describe, it, expect, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server, http, json, apiError, API_BASE } from "../test/mswServer";
import { renderApp, AUDITOR_USER } from "../test/renderApp";
import { AuditCyclePicker } from "./AuditCyclePicker";
import type { AuditSummary, TemplateSummary } from "../api/types";

const audit = (id: string, name: string, over: Partial<AuditSummary> = {}): AuditSummary =>
  ({ id, name, status: "in_progress", templateVersion: "2022", createdAt: "2026-03-01T10:00:00.000Z", closedAt: null, closedBy: null, ...over });
const A = audit("a2", "2027 surveillance", { createdAt: "2027-02-10T09:00:00.000Z" });
const B = audit("a1", "2026 certification", { createdAt: "2026-03-01T10:00:00.000Z" });
const TEMPLATES: TemplateSummary[] = [
  { id: "t-custom", framework: "ISO 27001", version: "2022-custom", name: "Our tailored template", isPlatformDefault: false },
  { id: "t-default", framework: "ISO 27001", version: "2022", name: "ISO 27001:2022 (platform default)", isPlatformDefault: true },
];

function show(props: Partial<Parameters<typeof AuditCyclePicker>[0]> = {}) {
  const onSelect = vi.fn(); const onCreated = vi.fn();
  renderApp(<AuditCyclePicker tenantId="t1" audits={[A, B]} current={A} canCreate={false} onSelect={onSelect} onCreated={onCreated} {...props} />, { user: AUDITOR_USER });
  return { onSelect, onCreated };
}
const mockTemplates = () => server.use(http.get(`${API_BASE}/templates`, () => json(TEMPLATES)));

describe("AuditCyclePicker", () => {
  it("shows nothing when there is one cycle and nobody to start another", () => {
    const { container } = renderApp(<AuditCyclePicker tenantId="t1" audits={[A]} current={A} canCreate={false} onSelect={() => {}} onCreated={() => {}} />, { user: AUDITOR_USER });
    expect(container).toBeEmptyDOMElement();
  });

  it("shows nothing when there are no cycles and nobody to start one", () => {
    const { container } = renderApp(<AuditCyclePicker tenantId="t1" audits={[]} current={null} canCreate={false} onSelect={() => {}} onCreated={() => {}} />, { user: AUDITOR_USER });
    expect(container).toBeEmptyDOMElement();
  });

  it("lists the cycles with their start date, the current one selected", () => {
    show();
    const select = screen.getByLabelText("Audit cycle");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["2027 surveillance · 2027-02-10", "2026 certification · 2026-03-01"]);
    expect(select).toHaveValue("a2");
  });

  it("marks a closed cycle", () => {
    show({ audits: [A, audit("a1", "Old one", { status: "closed" })] });
    expect(within(screen.getByLabelText("Audit cycle")).getAllByRole("option")[1]).toHaveTextContent("Old one · 2026-03-01 · closed");
  });

  it("choosing another cycle tells the page which", async () => {
    const { onSelect } = show();
    await userEvent.selectOptions(screen.getByLabelText("Audit cycle"), "a1");
    expect(onSelect).toHaveBeenCalledWith("a1");
  });

  it("has no 'New audit cycle' button for someone who can't start one", () => {
    show();
    expect(screen.queryByRole("button", { name: "New audit cycle" })).not.toBeInTheDocument();
  });

  it("offers the button, and the chooser, to someone who can — even with a single cycle", () => {
    show({ audits: [A], canCreate: true });
    expect(screen.getByLabelText("Audit cycle")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New audit cycle" })).toBeInTheDocument();
  });

  it("offers only the button when the client has no cycle yet", () => {
    show({ audits: [], current: null, canCreate: true });
    expect(screen.queryByLabelText("Audit cycle")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New audit cycle" })).toBeInTheDocument();
  });

  describe("starting a new cycle", () => {
    const open = async () => {
      const handlers = show({ canCreate: true });
      await userEvent.click(screen.getByRole("button", { name: "New audit cycle" }));
      const form = await screen.findByRole("region", { name: "New audit cycle" });
      await waitFor(() => expect(within(form).getAllByRole("option").length).toBeGreaterThan(0));
      return { ...handlers, form };
    };

    it("explains that earlier cycles are left alone", async () => {
      mockTemplates();
      const { form } = await open();
      expect(form).toHaveTextContent(/Earlier cycles and their evidence stay exactly as they are/);
    });

    it("preselects the platform's default template and suggests a name for this year", async () => {
      mockTemplates();
      const { form } = await open();
      expect(within(form).getByLabelText("Template")).toHaveValue("t-default");
      expect(within(form).getByLabelText("Name")).toHaveValue(`ISO 27001 audit ${new Date().getFullYear()}`);
    });

    it("creates the cycle with the chosen template and typed name, then hands it to the page and closes", async () => {
      mockTemplates();
      let body: unknown = null;
      const created = audit("a3", "2028 recertification", { createdAt: "2028-01-05T00:00:00.000Z" });
      server.use(http.post(`${API_BASE}/tenants/t1/audits`, async ({ request }) => { body = await request.json(); return json(created, 201); }));
      const { form, onCreated } = await open();
      await userEvent.selectOptions(within(form).getByLabelText("Template"), "t-custom");
      const name = within(form).getByLabelText("Name");
      await userEvent.clear(name);
      await userEvent.type(name, "  2028 recertification  ");
      await userEvent.click(within(form).getByRole("button", { name: "Create" }));
      await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
      expect(body).toEqual({ templateId: "t-custom", name: "2028 recertification" });
      expect(screen.queryByRole("region", { name: "New audit cycle" })).not.toBeInTheDocument();
    });

    it("keeps the typed name when the template is changed afterwards", async () => {
      mockTemplates();
      const { form } = await open();
      const name = within(form).getByLabelText("Name");
      await userEvent.clear(name);
      await userEvent.type(name, "My own name");
      await userEvent.selectOptions(within(form).getByLabelText("Template"), "t-custom");
      expect(name).toHaveValue("My own name");
    });

    it("cannot be created with a blank name", async () => {
      mockTemplates();
      const { form } = await open();
      await userEvent.clear(within(form).getByLabelText("Name"));
      expect(within(form).getByRole("button", { name: "Create" })).toBeDisabled();
      await userEvent.type(within(form).getByLabelText("Name"), "   ");
      expect(within(form).getByRole("button", { name: "Create" })).toBeDisabled();
    });

    it("shows the reason when it fails, stays open, and can be tried again", async () => {
      mockTemplates();
      let calls = 0;
      server.use(http.post(`${API_BASE}/tenants/t1/audits`, () => (++calls === 1 ? apiError(403, "FORBIDDEN", "You don't have access to do that.") : json(audit("a3", "x"), 201))));
      const { form, onCreated } = await open();
      await userEvent.click(within(form).getByRole("button", { name: "Create" }));
      expect(await within(form).findByRole("alert")).toHaveTextContent("You don't have access to do that.");
      expect(onCreated).not.toHaveBeenCalled();
      expect(within(form).getByRole("button", { name: "Create" })).toBeEnabled();
      await userEvent.click(within(form).getByRole("button", { name: "Create" }));
      await waitFor(() => expect(onCreated).toHaveBeenCalled());
    });

    it("cancelling closes the form and creates nothing", async () => {
      mockTemplates();
      let posted = false;
      server.use(http.post(`${API_BASE}/tenants/t1/audits`, () => { posted = true; return json({}, 201); }));
      const { form, onCreated } = await open();
      await userEvent.click(within(form).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("region", { name: "New audit cycle" })).not.toBeInTheDocument();
      expect(posted).toBe(false);
      expect(onCreated).not.toHaveBeenCalled();
    });

    it("says so when the templates can't be loaded, and cannot create", async () => {
      server.use(http.get(`${API_BASE}/templates`, () => apiError(500, "INTERNAL", "Something went wrong.")));
      show({ canCreate: true });
      await userEvent.click(screen.getByRole("button", { name: "New audit cycle" }));
      const form = await screen.findByRole("region", { name: "New audit cycle" });
      expect(await within(form).findByRole("alert")).toHaveTextContent("Something went wrong.");
      expect(within(form).getByRole("button", { name: "Create" })).toBeDisabled();
      await userEvent.type(within(form).getByLabelText("Name"), "My own name"); // a name doesn't help without a template
      expect(within(form).getByRole("button", { name: "Create" })).toBeDisabled();
    });
  });
});
