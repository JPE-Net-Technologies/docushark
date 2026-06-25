/**
 * useMobileAdaptation — the single seam gating the experimental mobile chrome
 * (JP-332). Builds on `useBreakpoint` (touch + viewport band) and two persisted
 * flags on `uiPreferencesStore` (`mobilePreviewAccepted`, `forceDesktopSite`).
 *
 * Two derived booleans, deliberately distinct:
 *
 * - `isMobile`     — a touch device at a `narrow` viewport. The gate uses this
 *                    to decide whether to *prompt*: real phones, not a narrowed
 *                    desktop window (desktop has no coarse pointer).
 * - `mobileActive` — render the mobile chrome *now*: accepted, not opted out, on
 *                    a touch device, and not a `wide` viewport. Slices 2–5
 *                    consume only this. It holds through the `medium` band too,
 *                    so a phone rotating portrait↔landscape (which crosses the
 *                    640px boundary) keeps one consistent shell instead of
 *                    thrashing between mobile and desktop chrome mid-session.
 *
 * The predicate is a pure function (`shouldAdaptToMobile`) so it is unit-tested
 * without React, alongside `useBreakpoint.test.ts` / `modes.test.ts`.
 */

import { useBreakpoint, type BreakpointState } from './useBreakpoint';
import { useUIPreferencesStore } from '../../store/uiPreferencesStore';

export interface MobileAdaptation {
  /** Touch device at a narrow viewport — the prompt trigger. */
  isMobile: boolean;
  /** Render the mobile chrome now (gated by acceptance + opt-out). */
  mobileActive: boolean;
  /** The user accepted the experimental mobile preview. */
  accepted: boolean;
  /** The user opted out — force the desktop layout on touch. */
  forceDesktop: boolean;
}

/** A touch device at a narrow viewport (the prompt trigger). Pure. */
export function isMobileViewport(bp: BreakpointState): boolean {
  return bp.isTouch && bp.band === 'narrow';
}

/**
 * Should the mobile chrome render? Accepted + not opted out, on a touch device,
 * and not a `wide` viewport. Holds through `medium` (phone/tablet landscape) so
 * an orientation change doesn't swap the whole shell mid-session. Pure.
 */
export function shouldAdaptToMobile(
  bp: BreakpointState,
  accepted: boolean,
  forceDesktop: boolean,
): boolean {
  return accepted && !forceDesktop && bp.isTouch && bp.band !== 'wide';
}

/** Reactive mobile-adaptation state — the single seam every mobile slice reads. */
export function useMobileAdaptation(): MobileAdaptation {
  const bp = useBreakpoint();
  const accepted = useUIPreferencesStore((s) => s.mobilePreviewAccepted);
  const forceDesktop = useUIPreferencesStore((s) => s.forceDesktopSite);
  return {
    isMobile: isMobileViewport(bp),
    mobileActive: shouldAdaptToMobile(bp, accepted, forceDesktop),
    accepted,
    forceDesktop,
  };
}
