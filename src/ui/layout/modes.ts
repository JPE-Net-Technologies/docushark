/**
 * Preset panel arrangement for each layout mode. These are the defaults a user
 * sees before applying any customization; user deltas are stored separately in
 * `LayoutState.modeOverrides` and merged on top via `resolvePanelState`.
 *
 * The table is intentionally small. If a row needs special rendering rules
 * (e.g. fly-out vs docked), that lives on the consuming component — this file
 * is data only.
 */

import type { ViewportBand } from '../../platform/device';
import type { LayoutMode, LayoutPanelMap, PanelId, PanelState, RelaxedFocus } from './types';

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
 * Whether Properties renders as a persistent *docked* panel for this mode+state.
 * In Relaxed it NEVER does — Properties is a selection-only overlay there, so a
 * stale `visible`/`pinned` override (e.g. left behind from before it became
 * un-pinnable in Relaxed) must not dock it over the prose, including in `write`
 * focus. Every other mode honors `state.visible`.
 */
export function propertiesDockedVisible(mode: LayoutMode, state: PanelState): boolean {
  if (mode === 'relaxed') return false;
  return state.visible;
}

/**
 * Hard-coded panel arrangement for each layout. `pinned` is set on Power so
 * panels render docked even though Power happens not to use the fly-out model
 * — keeping the flag truthful makes downstream logic uniform.
 */
export const LAYOUT_PRESETS: Record<LayoutMode, LayoutPanelMap> = {
  relaxed: {
    // Writing-first: the document editor is the *primary* region (it fills the
    // flex space, not a fixed sidebar — so no `width` here), properties appear
    // on selection only, and layers stay hidden. Canvas focus is driven by
    // `relaxedFocus` via `resolveRegions`, not by panel docking.
    document: { dock: 'left', visible: true, order: 0 },
    properties: { dock: 'right', visible: false, order: 0, width: 240 },
    layers: { dock: 'right', visible: false, order: 0 },
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

/**
 * Which region owns the dominant (flex) slot for a layout, before focus is
 * applied. Relaxed is writing-first (document primary); every other layout is
 * canvas-first. A future `mobile` mode would return based on `useBreakpoint`.
 */
export function primaryRegion(mode: LayoutMode): 'canvas' | 'document' {
  return mode === 'relaxed' ? 'document' : 'canvas';
}

/** Resolved arrangement of the two main regions for the current frame. */
export interface RegionLayout {
  /** Which region gets the dominant flex slot. */
  primary: 'canvas' | 'document';
  /** Whether the non-primary region is shown as a secondary pane. */
  split: boolean;
}

/**
 * Resolve how the document and canvas regions share the main area, given the
 * layout, the Relaxed focus, and the viewport band. Pure + breakpoint-aware so
 * the same logic powers desktop split views and the single-pane shape a future
 * mobile (PWA) layout needs.
 *
 * - Non-Relaxed layouts always render canvas-primary; the document panel is a
 *   docked sidebar handled by the existing panel machinery (`split: false`
 *   here — the docked path doesn't consult this).
 * - Relaxed maps `relaxedFocus` to regions: `write` → document only, `split` →
 *   document primary + secondary canvas (only when the viewport isn't
 *   `narrow`), `diagram` → canvas primary with the prose tucked away.
 */
export function resolveRegions(
  mode: LayoutMode,
  focus: RelaxedFocus,
  band: ViewportBand
): RegionLayout {
  if (mode !== 'relaxed') {
    return { primary: 'canvas', split: false };
  }
  switch (focus) {
    case 'diagram':
      return { primary: 'canvas', split: false };
    case 'split':
      // A side-by-side split needs horizontal room; collapse to single-pane
      // (prose) on narrow viewports — the mobile-shaped fallback.
      return { primary: 'document', split: band !== 'narrow' };
    case 'write':
    default:
      return { primary: 'document', split: false };
  }
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
