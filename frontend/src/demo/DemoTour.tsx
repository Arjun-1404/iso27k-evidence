import { useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { ApiError } from "../api/client";
import type { DemoBackend } from "./backend";
import { DEMO_PASSWORD } from "./accounts";
import { MAIN_STEPS, TOUR_STEPS, type TourStep } from "./tour";

/**
 * The guided tour: a button in the demo banner that opens a short checklist. The steps tick themselves when the matching
 * thing happens (the pretend server records it), and the two steps that need a different person come with a button that
 * signs in as them and opens the right page, so a visitor never has to remember a password.
 */
export function DemoTour({ backend }: { backend: DemoBackend }) {
  const done = useSyncExternalStore(backend.subscribeTour, backend.tourSnapshot);
  const { logout, login } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mainDone = MAIN_STEPS.filter((s) => done.includes(s.id)).length;
  const finished = mainDone === MAIN_STEPS.length;

  async function switchTo(step: TourStep) {
    const target = step.switchTo!;
    setBusy(step.id);
    setError(null);
    try {
      logout();
      const outcome = await login(target.email, DEMO_PASSWORD);
      // If the person was set up with two-step sign-in in this tab, the sign-in page asks for the code.
      navigate(outcome === "signed-in" ? target.goTo : "/login");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not switch person. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="demo-tour"
        className={`rounded-md border px-2 py-0.5 font-semibold ${mainDone === 0 && !open ? "border-teal-700 bg-teal-700 text-white hover:bg-teal-800" : "border-amber-400 bg-white/70 hover:bg-white"}`}
      >
        {mainDone === 0 ? "Take the 3-minute tour" : `Tour ${mainDone}/${MAIN_STEPS.length}`}
      </button>

      {open && (
        <section
          id="demo-tour"
          aria-label="Guided tour"
          className="absolute right-0 top-full z-40 mt-2 w-[min(24rem,calc(100vw-2rem))] max-h-[calc(100vh-4rem)] overflow-y-auto rounded-xl border border-gray-200 bg-white p-4 text-left text-gray-900 shadow-xl"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">Guided tour</h2>
              <p className="text-xs text-gray-500">{finished ? "You have been through the whole loop." : "The whole story in about three minutes. Steps tick themselves."}</p>
            </div>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close the tour" className="rounded-md px-1.5 text-lg leading-none text-gray-500 hover:bg-gray-100">×</button>
          </div>

          <div className="mt-3 h-1.5 rounded-full bg-teal-100" role="progressbar" aria-label="Tour progress" aria-valuemin={0} aria-valuemax={MAIN_STEPS.length} aria-valuenow={mainDone}>
            <div className="h-full rounded-full bg-teal-600 transition-[width] duration-300" style={{ width: `${(100 * mainDone) / MAIN_STEPS.length}%` }} />
          </div>

          <ol className="mt-4 space-y-3">
            {TOUR_STEPS.map((step, i) => {
              const isDone = done.includes(step.id);
              return (
                <li key={step.id} className="flex gap-3">
                  <span
                    aria-hidden="true"
                    className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${isDone ? "bg-teal-700 text-white" : "border border-gray-300 text-gray-500"}`}
                  >
                    {isDone ? "✓" : step.bonus ? "+" : i + 1}
                  </span>
                  <div className="min-w-0">
                    <h3 className={`text-sm font-semibold ${isDone ? "text-gray-500" : ""}`}>
                      {step.title}
                      {isDone && <>{" "}<span className="sr-only">(done)</span></>}
                    </h3>
                    {!isDone && <p className="mt-0.5 text-xs text-gray-600">{step.how}</p>}
                    {!isDone && step.switchTo && (
                      <button
                        type="button"
                        onClick={() => void switchTo(step)}
                        disabled={busy !== null}
                        className="mt-1.5 rounded-lg border border-teal-600 px-2.5 py-1 text-xs font-semibold text-teal-800 hover:bg-teal-50 disabled:opacity-60"
                      >
                        {step.switchTo.label}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>

          {error && <p role="alert" className="mt-3 text-xs text-red-600">{error}</p>}
          {finished && (
            <p className="mt-4 rounded-lg bg-teal-50 p-3 text-xs text-teal-900">
              That is the whole loop: the client hands evidence over, the auditor decides, and the dashboard and the audit log follow. Try the
              organisation admin or the client contributor next, or press Reset demo to start again.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
