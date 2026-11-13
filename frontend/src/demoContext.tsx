import { createContext, useContext, type ReactNode } from "react";

/**
 * What the live demo adds to the app. It is provided only when the demo is running (see main.tsx); in a real
 * installation nothing provides it and the app is exactly as it always was. Kept tiny, and free of any demo data, so that
 * the real build carries none of the demo.
 */
export interface DemoMode {
  /** Shown on the sign-in page: one-click sign-in as each of the made-up people. */
  signInPanel: ReactNode;
}

const DemoContext = createContext<DemoMode | null>(null);

export const DemoModeProvider = DemoContext.Provider;

/** The demo's additions, or null when this is not the demo. */
export function useDemoMode(): DemoMode | null {
  return useContext(DemoContext);
}
