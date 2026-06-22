/**
 * Settings store for application-wide settings.
 *
 * Stores user preferences for default behaviors, display options, etc.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ConnectorType, ERDCardinality } from '../shapes/Shape';

/**
 * Connector routing mode options.
 */
export type ConnectorRoutingMode = 'straight' | 'orthogonal';

/**
 * The style applied to the next connector drawn with the connector tool. This
 * is **last-used memory**, not a configured setting — the toolbar connector
 * dropdown (and drawing) update it, and new connectors inherit it. There is no
 * settings-panel knob for it (the old "Default Connector Type" select was
 * dropped in favour of this).
 */
export interface ConnectorDrawStyle {
  /** Routing: straight or orthogonal (right-angle). */
  routingMode: ConnectorRoutingMode;
  /** Semantic marker style: plain arrows, ERD crow's-foot, or UML class. */
  connectorType: ConnectorType;
  /** Start-endpoint cardinality (ERD presets); 'none' otherwise. */
  startCardinality: ERDCardinality;
  /** End-endpoint cardinality (ERD presets); 'none' otherwise. */
  endCardinality: ERDCardinality;
}

export const DEFAULT_CONNECTOR_STYLE: ConnectorDrawStyle = {
  routingMode: 'straight',
  connectorType: 'default',
  startCardinality: 'none',
  endCardinality: 'none',
};

/**
 * Settings state.
 */
export interface SettingsState {
  /** Last-used connector style applied to newly drawn connectors. */
  lastConnector: ConnectorDrawStyle;
  /** Default style profile ID to apply to new shapes (null = none) */
  defaultStyleProfileId: string | null;
  /** Show static/read-only properties in PropertyPanel */
  showStaticProperties: boolean;
  /** Hide default (built-in) style profiles in the profile list */
  hideDefaultStyleProfiles: boolean;
  /** Include icon style when saving to style profiles */
  saveIconStyleToProfile: boolean;
  /** Include label style when saving to style profiles */
  saveLabelStyleToProfile: boolean;
  /** Show minimap for canvas navigation */
  showMinimap: boolean;
  /** Auto-focus camera on shape when clicking layer item */
  layerClickFocusShape: boolean;
  /** Grid opacity (0-100, percentage) */
  gridOpacity: number;
  /** Animation duration for camera transitions in ms (0 = instant) */
  animationDuration: number;
}

/**
 * Settings actions.
 */
export interface SettingsActions {
  /** Patch the last-used connector style (merges into the current style). */
  setLastConnector: (patch: Partial<ConnectorDrawStyle>) => void;
  /** Set default style profile ID */
  setDefaultStyleProfileId: (profileId: string | null) => void;
  /** Toggle showing static properties */
  toggleShowStaticProperties: () => void;
  /** Set showing static properties */
  setShowStaticProperties: (show: boolean) => void;
  /** Toggle hiding default style profiles */
  toggleHideDefaultStyleProfiles: () => void;
  /** Set hiding default style profiles */
  setHideDefaultStyleProfiles: (hide: boolean) => void;
  /** Toggle saving icon style to profiles */
  toggleSaveIconStyleToProfile: () => void;
  /** Set saving icon style to profiles */
  setSaveIconStyleToProfile: (save: boolean) => void;
  /** Toggle saving label style to profiles */
  toggleSaveLabelStyleToProfile: () => void;
  /** Set saving label style to profiles */
  setSaveLabelStyleToProfile: (save: boolean) => void;
  /** Toggle minimap visibility */
  toggleShowMinimap: () => void;
  /** Set minimap visibility */
  setShowMinimap: (show: boolean) => void;
  /** Toggle layer click focus shape */
  toggleLayerClickFocusShape: () => void;
  /** Set layer click focus shape */
  setLayerClickFocusShape: (focus: boolean) => void;
  /** Set grid opacity */
  setGridOpacity: (opacity: number) => void;
  /** Set animation duration for camera transitions */
  setAnimationDuration: (duration: number) => void;
  /** Reset all settings to defaults */
  resetSettings: () => void;
}

/**
 * Initial state with default values.
 */
/**
 * Persist migration.
 * - v0→v1 flipped the default new-connector routing from 'orthogonal' to
 *   'straight' (the stale v0 default), without clobbering a deliberate v1 choice.
 * - v1→v2 replaced the routing-only `defaultConnectorType` field with the richer
 *   `lastConnector` style (routing + semantic type + ERD cardinality). The old
 *   routing folds into `lastConnector.routingMode`.
 */
export function migrateSettings(
  persisted: unknown,
  version: number
): Partial<SettingsState> {
  const state = (persisted ?? {}) as Record<string, unknown>;
  if (version < 2) {
    const legacyRouting = state['defaultConnectorType'];
    // v0's stale 'orthogonal' default flips to 'straight'; a deliberate
    // 'orthogonal' stored at v1 is preserved.
    const routingMode: ConnectorRoutingMode =
      legacyRouting === 'orthogonal' && version >= 1 ? 'orthogonal' : 'straight';
    const rest = { ...state };
    delete rest['defaultConnectorType'];
    return {
      ...(rest as Partial<SettingsState>),
      lastConnector: { ...DEFAULT_CONNECTOR_STYLE, routingMode },
    };
  }
  return state as Partial<SettingsState>;
}

const initialState: SettingsState = {
  lastConnector: DEFAULT_CONNECTOR_STYLE,
  defaultStyleProfileId: null,
  showStaticProperties: true,
  hideDefaultStyleProfiles: false,
  saveIconStyleToProfile: true,
  saveLabelStyleToProfile: true,
  showMinimap: false,
  layerClickFocusShape: false,
  gridOpacity: 100,
  animationDuration: 300,
};

/**
 * Settings store.
 *
 * Persists application settings to localStorage.
 *
 * Usage:
 * ```typescript
 * const { lastConnector, setLastConnector } = useSettingsStore();
 *
 * console.log(lastConnector.routingMode); // 'straight'
 *
 * // Remember a new last-used style (merges)
 * setLastConnector({ connectorType: 'erd', startCardinality: 'one', endCardinality: 'many' });
 * ```
 */
export const useSettingsStore = create<SettingsState & SettingsActions>()(
  persist(
    (set, get) => ({
      // State
      ...initialState,

      // Actions
      setLastConnector: (patch: Partial<ConnectorDrawStyle>) => {
        set({ lastConnector: { ...get().lastConnector, ...patch } });
      },

      setDefaultStyleProfileId: (profileId: string | null) => {
        set({ defaultStyleProfileId: profileId });
      },

      toggleShowStaticProperties: () => {
        set({ showStaticProperties: !get().showStaticProperties });
      },

      setShowStaticProperties: (show: boolean) => {
        set({ showStaticProperties: show });
      },

      toggleHideDefaultStyleProfiles: () => {
        set({ hideDefaultStyleProfiles: !get().hideDefaultStyleProfiles });
      },

      setHideDefaultStyleProfiles: (hide: boolean) => {
        set({ hideDefaultStyleProfiles: hide });
      },

      toggleSaveIconStyleToProfile: () => {
        set({ saveIconStyleToProfile: !get().saveIconStyleToProfile });
      },

      setSaveIconStyleToProfile: (save: boolean) => {
        set({ saveIconStyleToProfile: save });
      },

      toggleSaveLabelStyleToProfile: () => {
        set({ saveLabelStyleToProfile: !get().saveLabelStyleToProfile });
      },

      setSaveLabelStyleToProfile: (save: boolean) => {
        set({ saveLabelStyleToProfile: save });
      },

      toggleShowMinimap: () => {
        set({ showMinimap: !get().showMinimap });
      },

      setShowMinimap: (show: boolean) => {
        set({ showMinimap: show });
      },

      toggleLayerClickFocusShape: () => {
        set({ layerClickFocusShape: !get().layerClickFocusShape });
      },

      setLayerClickFocusShape: (focus: boolean) => {
        set({ layerClickFocusShape: focus });
      },

      setGridOpacity: (opacity: number) => {
        set({ gridOpacity: Math.max(0, Math.min(100, opacity)) });
      },

      setAnimationDuration: (duration: number) => {
        set({ animationDuration: Math.max(0, Math.min(2000, duration)) });
      },

      resetSettings: () => {
        set(initialState);
      },
    }),
    {
      name: 'docushark-settings',
      // v1: connector routing default flipped orthogonal → straight.
      // v2: `defaultConnectorType` (routing) → `lastConnector` style object.
      version: 2,
      migrate: (persisted, version) => migrateSettings(persisted, version),
      partialize: (state) => ({
        lastConnector: state.lastConnector,
        defaultStyleProfileId: state.defaultStyleProfileId,
        showStaticProperties: state.showStaticProperties,
        hideDefaultStyleProfiles: state.hideDefaultStyleProfiles,
        saveIconStyleToProfile: state.saveIconStyleToProfile,
        saveLabelStyleToProfile: state.saveLabelStyleToProfile,
        showMinimap: state.showMinimap,
        layerClickFocusShape: state.layerClickFocusShape,
        gridOpacity: state.gridOpacity,
        animationDuration: state.animationDuration,
      }),
    }
  )
);
