import { createContext, useContext, useMemo, type ReactNode } from "react";
import { ApiClient } from "./client";
import { useAuth } from "../auth/AuthProvider";
import type { AuthClient } from "../auth/types";

const ApiContext = createContext<ApiClient | null>(null);

export function ApiProvider({ baseUrl, authClient, children }: { baseUrl: string; authClient: AuthClient; children: ReactNode }) {
  const { setMfaSetupRequired } = useAuth();
  const api = useMemo(
    () => new ApiClient({
      baseUrl,
      getToken: () => authClient.getToken(),
      onUnauthorized: () => authClient.logout(),
      onMfaSetupRequired: () => setMfaSetupRequired(true),
    }),
    [baseUrl, authClient, setMfaSetupRequired],
  );
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiClient {
  const ctx = useContext(ApiContext);
  if (!ctx) throw new Error("useApi must be used inside an ApiProvider");
  return ctx;
}

// Re-exported so pages only need one import for "am I signed in" checks alongside API calls.
export { useAuth };
