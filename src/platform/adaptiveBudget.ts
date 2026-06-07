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
 * The one exception is motion — both the OS "reduce motion" toggle and the
 * user's in-app Motion preference are live, so we re-derive on either change.
 * `data-reduced-motion` on the root is the *single* authority that
 * `adaptive-motion.css` keys off (this module is its only writer); the CSS no
 * longer also reads `@media (prefers-reduced-motion)` directly, so an explicit
 * "Full" preference can override the OS everywhere.
 *
 * Browser-native only (reads `device`, which uses `matchMedia` / `navigator`),
 * so this tree-shakes identically into both the Tauri and PWA shells.
 */

import { device } from './device';

/**
 * User-facing motion preference (Settings → Appearance → Motion):
 *  - `system`  — follow the OS reduce-motion setting (and low-power heuristic).
 *  - `reduced` — always minimize motion, regardless of OS.
 *  - `full`    — always animate, overriding the OS setting and the low-power
 *               heuristic (an explicit opt-in).
 *
 * Fed in via `setMotionPreference` by the appearance applier so this module
 * stays the single authority over `data-reduced-motion`.
 */
export type MotionPreference = 'system' | 'reduced' | 'full';

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

/** The live user preference; updated via `setMotionPreference`. */
let motionPreference: MotionPreference = 'system';

/** Resolve the effective reduce-motion flag from the preference + device. */
function resolveReduceMotion(): boolean {
  if (motionPreference === 'reduced') return true;
  if (motionPreference === 'full') return false;
  // 'system': honor the OS toggle and the low-power heuristic.
  return device.prefersReducedMotion() || device.isLowPower();
}

function deriveBudget(): AdaptiveBudget {
  return {
    reduceMotion: resolveReduceMotion(),
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

/**
 * Set the user's motion preference and re-derive. Called by the appearance
 * applier on hydration and whenever the Motion setting changes.
 */
export function setMotionPreference(pref: MotionPreference): AdaptiveBudget {
  motionPreference = pref;
  return refreshAdaptiveBudget();
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
