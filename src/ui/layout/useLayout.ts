/**
 * useLayout — ergonomic React hook over the low-level layout actions on
 * `uiPreferencesStore`. Layout is app-level (a single active mode for the whole
 * editor), so the active mode is just `layout.defaultMode`. Most UI call sites
 * use these hooks; tests and the Settings editor reach for the explicit
 * `*For(mode, ...)` store actions instead.
 */

import { useMemo } from 'react';
import { useUIPreferencesStore } from '../../store/uiPreferencesStore';
import { LAYOUT_PRESETS, resolvePanelState } from './modes';
import type { DockSide, LayoutMode, PanelId, PanelState } from './types';

/** The single app-level active layout. */
export function useActiveLayoutMode(): LayoutMode {
  return useUIPreferencesStore((s) => s.layout.defaultMode);
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
  const setDefaultLayout = useUIPreferencesStore((s) => s.setDefaultLayout);
  const setPanelDockFor = useUIPreferencesStore((s) => s.setPanelDockFor);
  const setPanelVisibleFor = useUIPreferencesStore((s) => s.setPanelVisibleFor);
  const setPanelWidthFor = useUIPreferencesStore((s) => s.setPanelWidthFor);
  const togglePinFor = useUIPreferencesStore((s) => s.togglePinFor);

  return useMemo(
    () => ({
      setActiveLayout(mode: LayoutMode) {
        // Layout is app-level — switching always sets the single active mode.
        setDefaultLayout(mode);
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
    [setDefaultLayout, setPanelDockFor, setPanelVisibleFor, setPanelWidthFor, togglePinFor]
  );
}

/**
 * Read the active mode from store state without subscribing — used inside
 * action callbacks where re-rendering on every layout change is unwanted.
 */
function readActiveMode(): LayoutMode {
  return useUIPreferencesStore.getState().layout.defaultMode;
}

/** Re-export the preset table for components that need to enumerate panels. */
export { LAYOUT_PRESETS };
