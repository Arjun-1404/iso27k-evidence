import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useApi } from "./ApiProvider";
import { useAuth } from "../auth/AuthProvider";

/** `null` = still finding out. */
const OwnerContext = createContext<boolean | null>(false);

/**
 * Whether the signed-in person is the owner of this installation (the one person who can change the mail, scanner and
 * Google settings for everyone). Only an organisation admin can be the owner, so nobody else is asked. If the answer
 * can't be had, the answer is "no": the menu item is just hidden, and the server enforces the real rule anyway.
 */
export function PlatformOwnerProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const { user } = useAuth();
  const mightBeOwner = user?.role === "org_admin";
  const userId = user?.userId;
  const [state, setState] = useState<{ userId: string | undefined; owner: boolean } | null>(null);

  useEffect(() => {
    if (!mightBeOwner) return;
    let cancelled = false;
    api.getPlatformOwner()
      .then((r) => { if (!cancelled) setState({ userId, owner: r.owner === true }); })
      .catch(() => { if (!cancelled) setState({ userId, owner: false }); });
    return () => { cancelled = true; };
  }, [api, mightBeOwner, userId]);

  // An answer belongs to one person: never carry it over to whoever signs in next.
  const value = !mightBeOwner ? false : state !== null && state.userId === userId ? state.owner : null;
  return <OwnerContext.Provider value={value}>{children}</OwnerContext.Provider>;
}

/** `true` / `false`, or `null` while it is still being found out. Without the provider, always `false`. */
export function usePlatformOwner(): boolean | null {
  return useContext(OwnerContext);
}
