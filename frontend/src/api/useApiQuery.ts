import { useCallback, useEffect, useState } from "react";
import { ApiError } from "./client";

export interface QueryState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/** Runs `fn` whenever `deps` change, exposing loading/error/data. `fn` receives an AbortSignal that
 *  is aborted if the component unmounts or `deps` change again before it resolves — this both cancels
 *  the now-pointless network request and, together with the `cancelled` guard below, guarantees state
 *  is never set from a stale response. `fn` is expected to be stable across renders that don't change
 *  `deps` (wrap it in useCallback at the call site if needed). */
export function useApiQuery<T>(fn: (signal: AbortSignal) => Promise<T>, deps: React.DependencyList): QueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const load = useCallback(() => {
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fn(controller.signal)
      .then((result) => { if (!cancelled) setData(result); })
      .catch((e) => {
        if (cancelled || (e instanceof DOMException && e.name === "AbortError")) return;
        setError(e instanceof ApiError ? e.message : "Something went wrong. Please try again.");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  useEffect(() => load(), [load]);

  return { data, loading, error, refetch: () => setTick((t) => t + 1) };
}
