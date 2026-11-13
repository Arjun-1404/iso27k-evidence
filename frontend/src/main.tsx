import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";
import "./index.css";
import App from "./App.tsx";
import { AuthProvider } from "./auth/AuthProvider";
import { ApiProvider } from "./api/ApiProvider";
import { TenantProvider } from "./api/TenantProvider";
import { PlatformOwnerProvider } from "./api/PlatformOwnerProvider";
import { BuiltInAuthClient } from "./auth/builtInAuthClient";
import { DemoModeProvider, type DemoMode } from "./demoContext";
import type { ReactNode } from "react";

async function start() {
  let apiBaseUrl: string = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";
  let demo: { mode: DemoMode; banner: ReactNode } | null = null;

  // The live demo is a different BUILD of this same app (`npm run build:demo`): the pretend server and its sample data
  // are loaded only here, so a normal build contains none of it (a test checks that).
  if (import.meta.env.VITE_DEMO === "true") {
    const { startDemo } = await import("./demo");
    const running = startDemo();
    apiBaseUrl = running.apiBaseUrl;
    demo = { mode: running.mode, banner: running.banner };
  }

  // TODO(production): swap BuiltInAuthClient for Auth0AuthClient (see src/auth/types.ts) for anyone who
  // wants an external identity provider instead of the backend's own email+password login. Both
  // implement the same AuthClient interface, so nothing else in the app needs to change either way.
  const authClient = new BuiltInAuthClient(apiBaseUrl);

  // The demo is a static page on GitHub Pages, which has no server to send every address to index.html, so it keeps the
  // page in the part of the address after "#". A real installation uses ordinary addresses.
  const Router = demo ? HashRouter : BrowserRouter;

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Router>
        <AuthProvider client={authClient}>
          <ApiProvider baseUrl={apiBaseUrl} authClient={authClient}>
            <PlatformOwnerProvider>
              <TenantProvider>
                <DemoModeProvider value={demo?.mode ?? null}>
                  {demo?.banner}
                  <App />
                </DemoModeProvider>
              </TenantProvider>
            </PlatformOwnerProvider>
          </ApiProvider>
        </AuthProvider>
      </Router>
    </StrictMode>,
  );
}

void start();
