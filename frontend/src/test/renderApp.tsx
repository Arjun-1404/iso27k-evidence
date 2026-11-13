import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../auth/AuthProvider";
import { ApiProvider } from "../api/ApiProvider";
import { TenantProvider } from "../api/TenantProvider";
import { PlatformOwnerProvider } from "../api/PlatformOwnerProvider";
import { FakeAuthClient, type AuthUser } from "../auth/types";
import { API_BASE } from "./mswServer";

export function renderApp(ui: ReactElement, opts: { user?: AuthUser; route?: string } = {}) {
  const authClient = new FakeAuthClient();
  if (opts.user) {
    authClient.registerUser(opts.user);
    // Synchronously seed the session rather than awaiting login(), so the first render already sees it.
    void authClient.login(opts.user.email);
  }
  return {
    authClient,
    ...render(
      <MemoryRouter initialEntries={[opts.route ?? "/"]}>
        <AuthProvider client={authClient}>
          <ApiProvider baseUrl={API_BASE} authClient={authClient}>
            <PlatformOwnerProvider><TenantProvider>{ui}</TenantProvider></PlatformOwnerProvider>
          </ApiProvider>
        </AuthProvider>
      </MemoryRouter>,
    ),
  };
}

export const AUDITOR_USER: AuthUser = { userId: "11111111-1111-1111-1111-111111111111", email: "priya@harbor.test", name: "Priya Nair", role: "lead_auditor" };
export const TENANT_USER: AuthUser = { userId: "22222222-2222-2222-2222-222222222222", email: "sam@brightpath.test", name: "Sam Okafor", role: "contributor", tenantId: "tenant-1" };
