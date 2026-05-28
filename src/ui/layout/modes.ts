/**
 * Preset panel arrangement for each layout mode. These are the defaults a user
 * sees before applying any customization; user deltas are stored separately in
 * `LayoutState.modeOverrides` and merged on top via `resolvePanelState`.
 *
 * The table is intentionally small. If a row needs special rendering rules
 * (e.g. fly-out vs docked), that lives on the consuming component — this file
 * is data only.
 */

import type { LayoutMode, LayoutPanelMap, PanelId, PanelState } from './types';

/**
 * Whether a layout renders unpinned panels as fly-outs. Layouts not listed
 * here render panels as fixed-dock children of the canvas area.
 */
export const FLYOUT_LAYOUTS: readonly LayoutMode[] = ['designer', 'technician'] as const;

/** Does this layout use the fly-out model for unpinned panels? */
export function isFlyoutLayout(mode: LayoutMode): boolean {
  return FLYOUT_LAYOUTS.includes(mode);
}

/**
 * Hard-coded panel arrangement for each layout. `pinned` is set on Power so
 * panels render docked even though Power happens not to use the fly-out model
 * — keeping the flag truthful makes downstream logic uniform.
 */
export const LAYOUT_PRESETS: Record<LayoutMode, LayoutPanelMap> = {
  relaxed: {
    document: { dock: 'left', visible: true, order: 0, width: 320 },
    properties: { dock: 'right', visible: false, order: 0, width: 240 },
    layers: { dock: 'right', visible: true, order: 0 },
  },
  designer: {
    document: { dock: 'left', visible: false, order: 0, width: 320 },
    properties: { dock: 'right', visible: true, order: 0, width: 240 },
    layers: { dock: 'right', visible: true, order: 1 },
  },
  technician: {
    document: { dock: 'left', visible: true, order: 0, width: 320 },
    properties: { dock: 'right', visible: true, order: 0, width: 240 },
    layers: { dock: 'right', visible: true, order: 1 },
  },
  power: {
    document: { dock: 'left', visible: true, order: 0, width: 320 },
    properties: { dock: 'right', visible: true, order: 0, width: 240, pinned: true },
    layers: { dock: 'right', visible: true, order: 1, pinned: true },
  },
};

/**
 * Merge a layout's preset with the user's per-mode overrides to get the
 * effective state for a panel. Override fields shadow preset fields one key
 * at a time; missing override entries leave the preset intact.
 */
export function resolvePanelState(
  mode: LayoutMode,
  panel: PanelId,
  override: PanelState | undefined
): PanelState {
  const preset = LAYOUT_PRESETS[mode][panel];
  if (!override) return preset;
  return { ...preset, ...override };
}

/** Human-readable label for a layout mode (UI display). */
export const LAYOUT_LABELS: Record<LayoutMode, string> = {
  relaxed: 'Relaxed',
  designer: 'Designer',
  technician: 'Technician',
  power: 'Power',
};

/** One-line description shown alongside the layout in the selector dropdown. */
export const LAYOUT_DESCRIPTIONS: Record<LayoutMode, string> = {
  relaxed: 'Writing-first. Canvas one tap away.',
  designer: 'Diagram-first. Document one tap away.',
  technician: 'Balanced split. Panels fly out on demand.',
  power: 'Everything visible. Tightest density.',
};
