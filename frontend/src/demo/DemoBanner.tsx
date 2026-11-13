// The strip across the top of the live demo: says what this is, and offers the way back to the start.

export interface DemoBannerProps {
  onReset: () => void;
  /** Where the real project lives, for people who want to run it themselves. */
  repoUrl: string;
}

export function DemoBanner({ onReset, repoUrl }: DemoBannerProps) {
  return (
    <div role="region" aria-label="About this demo" className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 bg-amber-100 px-4 py-2 text-xs text-amber-900 border-b border-amber-300">
      <p>
        <strong className="font-semibold">Live demo.</strong>{" "}
        Everything here is made up and runs in your browser: nothing is sent anywhere, and it is gone when you close the tab.
      </p>
      <div className="flex items-center gap-3">
        <button type="button" onClick={onReset} className="rounded-md border border-amber-400 bg-white/70 px-2 py-0.5 font-semibold hover:bg-white">Reset demo</button>
        <a href={repoUrl} target="_blank" rel="noreferrer" className="font-semibold underline">Get the code</a>
      </div>
    </div>
  );
}
