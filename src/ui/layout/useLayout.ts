/**
 * useLayout — ergonomic React hook that composes the low-level layout actions
 * on `uiPreferencesStore` with "current document" inference from
 * `persistenceStore`. Most UI call sites use this; tests and the Settings
 * editor reach for the explicit `*For(mode, ...)` store actions instead.
 */

import { useMemo } from 'react';
import { useUIPreferencesStore } from '../../store/uiPreferencesStore';
import { usePersistenceStore } from '../../store/persistenceStore';
import { LAYOUT_PRESETS, resolvePanelState } from './modes';
import type { DockSide, LayoutMode, PanelId, PanelState } from './types';

/** Effective layout for the currently open document. */
export function useActiveLayoutMode(): LayoutMode {
  const defaultMode = useUIPreferencesStore((s) => s.layout.defaultMode);
  const perDoc = useUIPreferencesStore((s) => s.layout.perDoc);
  const docId = usePersistenceStore((s) => s.currentDocumentId);
  if (docId && perDoc[docId]) return perDoc[docId];
  return defaultMode;
}

/** Effective panel state under the active layout, with user overrides applied. */
export function useActivePanelState(panel: PanelId): PanelState {
  const mode = useActiveLayoutMode();
  const override = useUIPreferencesStore((s) => s.layout.modeOverrides[mode][panel]);
  return useMemo(() => resolvePanelState(mode, panel, override), [mode, panel, override]);
}

/**
 * Bundled actions that infer the active mode / current doc from store state at
 * call time. Returned object is stable across renders because the wrapped
 * store actions are stable.
 */
export function useLayoutActions(): {
  setActiveLayout: (mode: LayoutMode) => void;
  setPanelDock: (panel: PanelId, dock: DockSide) => void;
  setPanelVisible: (panel: PanelId, visible: boolean) => void;
  togglePanelVisible: (panel: PanelId) => void;
  setPanelWidth: (panel: PanelId, width: number) => void;
  togglePin: (panel: PanelId) => void;
} {
  const setLayoutForDoc = useUIPreferencesStore((s) => s.setLayoutForDoc);
  const setDefaultLayout = useUIPreferencesStore((s) => s.setDefaultLayout);
  const setPanelDockFor = useUIPreferencesStore((s) => s.setPanelDockFor);
  const setPanelVisibleFor = useUIPreferencesStore((s) => s.setPanelVisibleFor);
  const setPanelWidthFor = useUIPreferencesStore((s) => s.setPanelWidthFor);
  const togglePinFor = useUIPreferencesStore((s) => s.togglePinFor);

  return useMemo(
    () => ({
      setActiveLayout(mode: LayoutMode) {
        const docId = usePersistenceStore.getState().currentDocumentId;
        if (docId) {
          setLayoutForDoc(docId, mode);
        } else {
          // No doc open — treat the choice as the new global default so a
          // later doc-open lands in the user's chosen layout.
          setDefaultLayout(mode);
        }
      },
      setPanelDock(panel: PanelId, dock: DockSide) {
        const mode = readActiveMode();
        setPanelDockFor(mode, panel, dock);
      },
      setPanelVisible(panel: PanelId, visible: boolean) {
        const mode = readActiveMode();
        setPanelVisibleFor(mode, panel, visible);
      },
      togglePanelVisible(panel: PanelId) {
        const mode = readActiveMode();
        const { layout } = useUIPreferencesStore.getState();
        const preset = LAYOUT_PRESETS[mode][panel];
        const override = layout.modeOverrides[mode][panel];
        const current = override?.visible ?? preset.visible;
        setPanelVisibleFor(mode, panel, !current);
      },
      setPanelWidth(panel: PanelId, width: number) {
        const mode = readActiveMode();
        setPanelWidthFor(mode, panel, width);
      },
      togglePin(panel: PanelId) {
        const mode = readActiveMode();
        togglePinFor(mode, panel);
      },
    }),
    [setLayoutForDoc, setDefaultLayout, setPanelDockFor, setPanelVisibleFor, setPanelWidthFor, togglePinFor]
  );
}

/**
 * Read the active mode from store state without subscribing — used inside
 * action callbacks where re-rendering on every layout change is unwanted.
 */
function readActiveMode(): LayoutMode {
  const { layout } = useUIPreferencesStore.getState();
  const docId = usePersistenceStore.getState().currentDocumentId;
  if (docId && layout.perDoc[docId]) return layout.perDoc[docId];
  return layout.defaultMode;
}

/** Re-export the preset table for components that need to enumerate panels. */
export { LAYOUT_PRESETS };
