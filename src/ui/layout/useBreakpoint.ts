/**
 * useBreakpoint — the single seam for responsive layout decisions.
 *
 * Builds on `platform.device` (which already classifies the viewport into
 * narrow/medium/wide bands and detects coarse pointers) and adds standalone-PWA
 * detection, then makes the result reactive to viewport + capability changes.
 * Layout logic (`resolveRegions`, the Relaxed focus control) consults this so
 * desktop split views and the future dedicated mobile (PWA) layout share one
 * source of truth instead of scattering `matchMedia` reads.
 *
 * jsdom/SSR-safe: every `window`/`matchMedia` access is guarded so the hook
 * (and its pure `readBreakpointState` reader) can run under Vitest.
 */

import { useEffect, useState } from 'react';
import { device, type ViewportBand } from '../../platform/device';

export interface BreakpointState {
  /** Coarse viewport width band (narrow < 640 ≤ medium < 1024 ≤ wide). */
  band: ViewportBand;
  /** Primary input is touch / coarse pointer. */
  isTouch: boolean;
  /** Running as an installed standalone PWA (vs a browser tab). */
  standalone: boolean;
}

/** Is the app running as an installed standalone PWA? */
function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const displayMode =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(display-mode: standalone)').matches
      : false;
  // iOS Safari exposes a legacy non-standard flag instead of display-mode.
  const iosStandalone =
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  return displayMode || iosStandalone;
}

/** Read the current breakpoint state once (pure; no subscription). */
export function readBreakpointState(): BreakpointState {
  return {
    band: device.viewportBand(),
    isTouch: device.isTouch(),
    standalone: isStandalone(),
  };
}

function sameState(a: BreakpointState, b: BreakpointState): boolean {
  return a.band === b.band && a.isTouch === b.isTouch && a.standalone === b.standalone;
}

/** Reactive viewport/capability classification. */
export function useBreakpoint(): BreakpointState {
  const [state, setState] = useState<BreakpointState>(readBreakpointState);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const update = () =>
      setState((prev) => {
        const next = readBreakpointState();
        return sameState(prev, next) ? prev : next;
      });

    window.addEventListener('resize', update);
    const queries = ['(pointer: coarse)', '(display-mode: standalone)']
      .map((q) => (typeof window.matchMedia === 'function' ? window.matchMedia(q) : null))
      .filter((mq): mq is MediaQueryList => mq !== null);
    for (const mq of queries) mq.addEventListener?.('change', update);

    // Re-sync in case the viewport changed between first render and effect.
    update();

    return () => {
      window.removeEventListener('resize', update);
      for (const mq of queries) mq.removeEventListener?.('change', update);
    };
  }, []);

  return state;
}
