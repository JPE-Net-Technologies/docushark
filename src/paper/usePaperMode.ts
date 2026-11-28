/**
 * When Paper Mode shows (DSK-48): it's a view of the prose, so it needs the
 * Relaxed layout with the prose shown (Write or Split), and a screen wide
 * enough for a page. The choice itself is remembered per device.
 */

import { useSessionStore } from '../store/sessionStore';
import { useUIPreferencesStore } from '../store/uiPreferencesStore';
import { useBreakpoint } from '../ui/layout/useBreakpoint';
import { useActiveLayoutMode } from '../ui/layout/useLayout';
import { useMobileAdaptation } from '../ui/layout/useMobileAdaptation';

/** Whether Paper Mode can be turned on here. */
export function usePaperModeAvailable(): boolean {
  const mode = useActiveLayoutMode();
  const focus = useSessionStore((s) => s.relaxedFocus);
  const { band } = useBreakpoint();
  const { mobileActive } = useMobileAdaptation();
  return mode === 'relaxed' && focus !== 'diagram' && band !== 'narrow' && !mobileActive;
}

/** Whether Paper Mode is on and can show. */
export function usePaperModeActive(): boolean {
  const on = useUIPreferencesStore((s) => s.paperMode);
  return usePaperModeAvailable() && on;
}
