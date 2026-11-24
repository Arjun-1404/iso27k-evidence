import { useEffect, useState } from "react";
import { formatPct, METER_FILL, METER_TRACK } from "./statusStyle";

const SIZE = 184;
const STROKE = 12;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * The one number the dashboard leads with: how much of what applies has been accepted. A single ratio against its whole is
 * a meter, so this is a ring-shaped one: a pale track, a thin round-ended fill that draws itself in once, and the figure in
 * the middle in the page's own sans.
 */
export function ReadinessRing({ accepted, applicable, completionPct }: { accepted: number; applicable: number; completionPct: number }) {
  const pct = Math.max(0, Math.min(100, completionPct));
  // Start empty and move to the real value after the first paint, so the ring draws itself in. Anyone who has asked their
  // computer for less motion sees it already in place (the transition is switched off for them in the class below).
  const [shown, setShown] = useState(0);
  useEffect(() => { const id = requestAnimationFrame(() => setShown(pct)); return () => cancelAnimationFrame(id); }, [pct]);

  return (
    <figure className="m-0 flex flex-col items-center">
      <div className="relative" style={{ width: SIZE, height: SIZE }}>
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={`${formatPct(pct)} percent complete: ${accepted} of ${applicable} applicable controls accepted`}>
          <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" stroke={METER_TRACK} strokeWidth={STROKE} />
          {pct > 0 && (
            <circle
              cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" stroke={METER_FILL} strokeWidth={STROKE} strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE} strokeDashoffset={CIRCUMFERENCE * (1 - shown / 100)}
              transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
              className="transition-[stroke-dashoffset] duration-1000 ease-out motion-reduce:transition-none"
            />
          )}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center" aria-hidden="true">
          <div className="flex items-baseline text-gray-900">
            <span className="text-5xl font-semibold leading-none">{formatPct(pct)}</span>
            <span className="ml-0.5 text-xl font-semibold text-gray-500">%</span>
          </div>
          <span className="mt-1 text-xs text-gray-500">complete</span>
        </div>
      </div>
      <figcaption className="mt-3 text-center text-sm text-gray-600">
        <span className="font-semibold text-gray-900">{accepted}</span> of <span className="font-semibold text-gray-900">{applicable}</span> applicable controls accepted
      </figcaption>
    </figure>
  );
}
