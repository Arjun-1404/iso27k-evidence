import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server, http, json, apiError, API_BASE } from "../test/mswServer";
import { renderApp, AUDITOR_USER, TENANT_USER } from "../test/renderApp";
import { AccessProvider, useAccess } from "./AccessProvider";

function Probe() {
  const { can, customRoleName } = useAccess();
  return <p>review:{String(can("review"))} comment:{String(can("comment"))} role:{customRoleName ?? "none"}</p>;
}
const show = (user = AUDITOR_USER) => renderApp(<AccessProvider><Probe /></AccessProvider>, { user });

describe("AccessProvider", () => {
  it("without the provider nothing is hidden", () => {
    renderApp(<Probe />, { user: AUDITOR_USER });
    expect(screen.getByText("review:true comment:true role:none")).toBeInTheDocument();
  });

  it("hides what the person's custom role takes away and says which role it is", async () => {
    server.use(http.get(`${API_BASE}/me/access`, () => json({ role: "auditor", customRole: { id: "r1", name: "Junior auditor" }, denied: ["comment"] })));
    show();
    await waitFor(() => expect(screen.getByText("review:true comment:false role:Junior auditor")).toBeInTheDocument());
  });

  it("a person with no custom role can do everything their role does", async () => {
    server.use(http.get(`${API_BASE}/me/access`, () => json({ role: "lead_auditor", customRole: null, denied: [] })));
    show();
    await waitFor(() => expect(screen.getByText("review:true comment:true role:none")).toBeInTheDocument());
  });

  it("if the answer can't be had, the page shows everything and the server says no where it has to", async () => {
    server.use(http.get(`${API_BASE}/me/access`, () => apiError(500, "INTERNAL", "Unexpected error.")));
    show();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText("review:true comment:true role:none")).toBeInTheDocument();
  });

  it("asks again for a different person, and never lends one person's answer to another", async () => {
    server.use(http.get(`${API_BASE}/me/access`, () => json({ role: "contributor", customRole: { id: "r9", name: "Uploader" }, denied: ["review", "comment"] })));
    const { unmount } = show(TENANT_USER);
    await waitFor(() => expect(screen.getByText("review:false comment:false role:Uploader")).toBeInTheDocument());
    unmount();
    server.use(http.get(`${API_BASE}/me/access`, () => json({ role: "lead_auditor", customRole: null, denied: [] })));
    show(AUDITOR_USER);
    await waitFor(() => expect(screen.getByText("review:true comment:true role:none")).toBeInTheDocument());
  });
});
