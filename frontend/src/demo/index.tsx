// The live demo's front door: main.tsx calls startDemo() (only when built with VITE_DEMO=true) and gets back the address
// to give the app as its API, the pieces to show on the sign-in page and across the top, and nothing else. Everything the
// demo needs is loaded from here, so a normal build never contains any of it.

import type { ReactNode } from "react";
import { DemoBackend } from "./backend";
import { DemoBanner } from "./DemoBanner";
import { DemoSignInPanel } from "./DemoSignInPanel";
import { installDemoFetch } from "./install";
import type { DemoMode } from "../demoContext";

/** An address that can never resolve (".invalid" is reserved for that): if the demo's wrapper ever failed to catch a request, it would fail loudly instead of reaching a real server. */
export const DEMO_API_BASE_URL = "https://api.demo.invalid";

const DEFAULT_REPO_URL = "https://github.com/Arjun-1404/iso27k-evidence";

/** Forgets what the browser remembers about who was signed in and which client was open. */
function forgetRememberedChoices(): void {
  try {
    localStorage.removeItem("evidence-portal-session");
    localStorage.removeItem("selectedTenantId");
    for (const key of Object.keys(localStorage)) if (key.startsWith("selectedAudit:")) localStorage.removeItem(key);
  } catch { /* private window or blocked site data: nothing was remembered */ }
}

export interface RunningDemo {
  apiBaseUrl: string;
  mode: DemoMode;
  banner: ReactNode;
  backend: DemoBackend;
  /** Puts the browser's own fetch back (used by tests; the page never needs it). */
  stop: () => void;
}

export interface StartOptions {
  /** How "Reset demo" reloads the page; replaceable so a test does not have to reload the test page. */
  reload?: () => void;
  /** The pretend network delay in milliseconds (default 80); tests use 0. */
  latencyMs?: number;
}

export function startDemo(opts: StartOptions = {}): RunningDemo {
  document.title = "ISO 27001 evidence portal · live demo";
  const backend = new DemoBackend();
  const stop = installDemoFetch(backend, { baseUrl: DEMO_API_BASE_URL, latencyMs: opts.latencyMs ?? 80 });

  const reset = () => {
    backend.reset();
    forgetRememberedChoices();
    window.location.hash = "#/login";
    (opts.reload ?? (() => window.location.reload()))();
  };

  const repoUrl = (import.meta.env.VITE_DEMO_REPO_URL as string | undefined) || DEFAULT_REPO_URL;
  return {
    apiBaseUrl: DEMO_API_BASE_URL,
    mode: { signInPanel: <DemoSignInPanel /> },
    banner: <DemoBanner onReset={reset} repoUrl={repoUrl} />,
    backend,
    stop,
  };
}
