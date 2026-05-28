/**
 * Adaptive budget — turns the raw `platform.device` hints into concrete,
 * typed scalars the editor reads to degrade gracefully on constrained
 * devices (per Final OSS App Design §5). Each hint maps to one axis:
 *
 *  - `prefersReducedMotion` / `isLowPower` → animation budget (`reduceMotion`)
 *  - `isLowPower`                          → collab broadcast cadence (`cursorBroadcastMs`)
 *  - `isTouch`                             → grab-zone size (`hitTargetScale`)
 *
 * Detection is **boot-time**: touch and power are sampled once at module load
 * (they effectively never change mid-session), so the snapshot is memoized.
 * The one exception is motion — the OS "reduce motion" toggle is live, so we
 * listen for `prefers-reduced-motion` changes and re-derive on the fly. CSS
 * can express the media-query half directly, but not the `isLowPower` half, so
 * we mirror the resolved `reduceMotion` onto a `data-reduced-motion` root
 * attribute that `adaptive-motion.css` keys off.
 *
 * Browser-native only (reads `device`, which uses `matchMedia` / `navigator`),
 * so this tree-shakes identically into both the Tauri and PWA shells.
 */

import { device } from './device';

export interface AdaptiveBudget {
  /** Skip non-essential animation (OS reduce-motion or a low-power device). */
  reduceMotion: boolean;
  /** Throttle interval (ms) for awareness/cursor broadcasts to the relay. */
  cursorBroadcastMs: number;
  /** Multiplier for invisible grab zones — larger on coarse pointers. */
  hitTargetScale: number;
}

/** Broadcast cadence on a low-power device (~8 fps) — eases relay chatter. */
const CONSTRAINED_CURSOR_MS = 120;
/** Broadcast cadence otherwise (~30 fps cap) — still real-time, less noise. */
const DEFAULT_CURSOR_MS = 33;
/** Grab-zone enlargement on coarse pointers (handles, snap, drag threshold). */
const TOUCH_HIT_TARGET_SCALE = 1.6;

function deriveBudget(): AdaptiveBudget {
  return {
    reduceMotion: device.prefersReducedMotion() || device.isLowPower(),
    cursorBroadcastMs: device.isLowPower() ? CONSTRAINED_CURSOR_MS : DEFAULT_CURSOR_MS,
    hitTargetScale: device.isTouch() ? TOUCH_HIT_TARGET_SCALE : 1,
  };
}

function applyReducedMotionAttr(reduce: boolean): void {
  if (typeof document === 'undefined') return;
  if (reduce) {
    document.documentElement.dataset['reducedMotion'] = 'true';
  } else {
    delete document.documentElement.dataset['reducedMotion'];
  }
}

let budget: AdaptiveBudget = deriveBudget();
applyReducedMotionAttr(budget.reduceMotion);

/** The current boot-time budget snapshot. Cheap to call (returns the memo). */
export function getAdaptiveBudget(): AdaptiveBudget {
  return budget;
}

/**
 * Re-derive the budget and re-apply the root attribute. Called by the live
 * motion listener; also the seam tests drive after mocking `device`.
 */
export function refreshAdaptiveBudget(): AdaptiveBudget {
  budget = deriveBudget();
  applyReducedMotionAttr(budget.reduceMotion);
  return budget;
}

// Live motion: the OS reduce-motion setting can flip mid-session. Re-derive
// when it does (touch/power stay frozen at boot, by design).
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (typeof motionQuery.addEventListener === 'function') {
    motionQuery.addEventListener('change', () => {
      refreshAdaptiveBudget();
    });
  }
}
