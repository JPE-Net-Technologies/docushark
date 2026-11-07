/**
 * Whether a selection opens the Properties panel (DSK-225). With the selection bar
 * on, a selection shows the bar, and the panel waits for More. It then follows the
 * selection until dismissed. With the bar off, every selection opens it, as it
 * always did, and there's nothing to dismiss.
 */
import { useCallback } from 'react';
import { useSessionStore } from '../../store/sessionStore';
import { useSettingsStore } from '../../store/settingsStore';

export function usePropertiesOnSelection() {
  const barOn = useSettingsStore((state) => state.showSelectionBar);
  const requested = useSessionStore((state) => state.propertiesRequested);
  const setRequested = useSessionStore((state) => state.setPropertiesRequested);
  const dismiss = useCallback(() => setRequested(false), [setRequested]);
  return { followsSelection: !barOn || requested, onDismiss: barOn ? dismiss : undefined };
}
