/**
 * CapacityRing (JP-477) — the rail's storage readout.
 *
 * A donut whose arcs carry the metered shares (documents / files /
 * configuration) around a single track, with the fill percentage at its
 * centre. It replaces the stacked pair of 5px bars plus a three-item text
 * legend that had grown to a third of the sidebar's foot: the ring says the
 * same thing in a quarter of the height, and the shares stay *visible* as arcs
 * rather than being dropped — the named byte counts move to the tooltip and
 * the full Storage view.
 *
 * Honesty rules the geometry:
 *  - No quota (unknown or unmetered) means no fraction to draw. The ring goes
 *    to an idle track and the centre reads "—" rather than implying empty.
 *  - Shares that don't sum to the headline number aren't drawn as shares (see
 *    `resolveShares`); the ring falls back to one continuous fill.
 *  - A tiny-but-nonzero share is floored to a visible sliver, but the floor is
 *    paid for out of the largest share, so the ring's outer edge still lands on
 *    the true fill percentage.
 */

import type { CSSProperties } from 'react';

/** One metered share of the total. `bytes` may be 0 — it simply won't draw. */
export interface CapacitySegment {
  key: string;
  /** Human label, used in the tooltip. */
  label: string;
  bytes: number;
}

export interface CapacityRingProps {
  used: number | null;
  quota: number | null;
  /** Per-category breakdown. Omit for a single continuous fill. */
  segments?: CapacitySegment[] | null;
  /** At or over quota — the whole ring goes to the danger colour. */
  over?: boolean;
  /** Usage hasn't resolved yet. */
  pending?: boolean;
  /** Outer diameter in px. */
  size?: number;
}

/** Arc units are percentages of the circle (`pathLength={100}`). */
const TRACK_LENGTH = 100;
/** Smallest arc that still reads as a slice rather than a rendering artifact. */
const MIN_VISIBLE_ARC = 1.4;

/**
 * Turn byte shares into drawable arcs.
 *
 * Each share becomes its percentage of the *quota*. Nonzero shares below
 * `MIN_VISIBLE_ARC` are raised to it — configuration is routinely kilobytes
 * against gigabytes and would otherwise round away to nothing — and the
 * borrowed length is taken back off the largest arc so the ring's outer edge
 * still ends at the true fill.
 */
export function toArcs(
  segments: CapacitySegment[],
  quota: number,
): { key: string; length: number }[] {
  const raw = segments.map((s) => ({
    key: s.key,
    length: s.bytes > 0 ? Math.min(TRACK_LENGTH, (s.bytes / quota) * TRACK_LENGTH) : 0,
  }));

  const trueTotal = raw.reduce((sum, a) => sum + a.length, 0);
  const boosted = raw.map((a) =>
    a.length > 0 && a.length < MIN_VISIBLE_ARC ? { ...a, length: MIN_VISIBLE_ARC } : a,
  );
  const borrowed = boosted.reduce((sum, a) => sum + a.length, 0) - trueTotal;
  if (borrowed <= 0) return boosted;

  // Repay from the largest arc, but never shrink it below the visible floor —
  // a ring a fraction of a percent long is a fair price for not lying about
  // which categories exist.
  let largest = 0;
  for (let i = 1; i < boosted.length; i += 1) {
    if (boosted[i]!.length > boosted[largest]!.length) largest = i;
  }
  const target = boosted[largest]!.length - borrowed;
  boosted[largest] = { ...boosted[largest]!, length: Math.max(MIN_VISIBLE_ARC, target) };
  return boosted;
}

export function CapacityRing({
  used,
  quota,
  segments = null,
  over = false,
  pending = false,
  size = 46,
}: CapacityRingProps) {
  const metered = used !== null && quota !== null && quota > 0;
  const pct = metered ? Math.max(0, Math.min(100, (used / quota) * 100)) : null;

  // Shares are suppressed at cap so the danger state reads as one unambiguous
  // "full" signal rather than a tricolour ring that happens to be red.
  const drawSegments = metered && !over && segments && segments.length > 0;
  const arcs = drawSegments ? toArcs(segments, quota) : [];

  const centre = pending ? '···' : pct === null ? '—' : `${Math.round(pct)}`;
  const label = pending
    ? 'Storage usage is still being calculated'
    : pct === null
      ? 'Storage usage — no allowance reported'
      : `Storage ${Math.round(pct)} percent full`;

  // Stroke geometry: the radius is derived so the ring's outer edge sits flush
  // with the box regardless of `size`.
  const stroke = Math.max(4, Math.round(size * 0.13));
  const radius = (size - stroke) / 2;

  let offset = 0;
  return (
    <span
      className={`dh-ring${over ? ' dh-ring--over' : ''}${pending ? ' dh-ring--pending' : ''}`}
      style={{ '--dh-ring-size': `${size}px` } as CSSProperties}
      role="img"
      aria-label={label}
    >
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true">
        {/* Rotated so arcs start at 12 o'clock and run clockwise. */}
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`} fill="none" strokeWidth={stroke}>
          <circle
            className="dh-ring-track"
            cx={size / 2}
            cy={size / 2}
            r={radius}
            pathLength={TRACK_LENGTH}
          />
          {drawSegments
            ? arcs.map((arc) => {
                const dash = `${arc.length} ${TRACK_LENGTH}`;
                const dashOffset = -offset;
                offset += arc.length;
                return arc.length > 0 ? (
                  <circle
                    key={arc.key}
                    className={`dh-ring-arc dh-ring-arc--${arc.key}`}
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    pathLength={TRACK_LENGTH}
                    strokeDasharray={dash}
                    strokeDashoffset={dashOffset}
                  />
                ) : null;
              })
            : pct !== null && (
                <circle
                  className="dh-ring-arc dh-ring-arc--all"
                  cx={size / 2}
                  cy={size / 2}
                  r={radius}
                  pathLength={TRACK_LENGTH}
                  strokeDasharray={`${pct} ${TRACK_LENGTH}`}
                />
              )}
        </g>
      </svg>
      <span className="dh-ring-centre" aria-hidden="true">
        {centre}
        {pct !== null && !pending && <span className="dh-ring-pct">%</span>}
      </span>
    </span>
  );
}

export default CapacityRing;
