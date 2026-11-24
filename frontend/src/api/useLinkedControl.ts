import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import type { ControlSummary } from "./types";

/**
 * Lets another page link straight to one control: an address ending in `?control=<id>` (the dashboard's tiles use this).
 * Once the page's controls have loaded, `onFound` is called once with that control, and the parameter is dropped from the
 * address so that closing what it opened, or reloading, does not open it again. An id that is not in the list (another
 * audit cycle, or not visible to this person) is quietly ignored.
 */
export function useLinkedControl(controls: ControlSummary[] | null, onFound: (control: ControlSummary) => void): void {
  const [params, setParams] = useSearchParams();
  const wanted = params.get("control");
  const handled = useRef<string | null>(null);
  const callback = useRef(onFound);
  useEffect(() => { callback.current = onFound; }); // the latest callback, kept where React allows it (not during render)

  useEffect(() => {
    if (!wanted || !controls || handled.current === wanted) return;
    handled.current = wanted;
    const found = controls.find((c) => c.id === wanted);
    if (found) callback.current(found);
    setParams((p) => { const next = new URLSearchParams(p); next.delete("control"); return next; }, { replace: true });
  }, [wanted, controls, setParams]);
}
