/**
 * Settings store for application-wide settings.
 *
 * Stores user preferences for default behaviors, display options, etc.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Connector routing mode options.
 */
export type ConnectorRoutingMode = 'straight' | 'orthogonal';

/**
 * Settings state.
 */
export interface SettingsState {
  /** Default connector routing mode */
  defaultConnectorType: ConnectorRoutingMode;
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
  /** Set default connector type */
  setDefaultConnectorType: (type: ConnectorRoutingMode) => void;
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
 * Persist migration. v0→v1 flipped the default new-connector routing from
 * 'orthogonal' to 'straight'; move stored installs that still carry the old
 * default forward so the change actually takes effect. A user who deliberately
 * picks 'orthogonal' after v1 stores it at version 1, so this never clobbers a
 * real choice — it only rewrites the stale v0 default.
 */
export function migrateSettings(
  persisted: unknown,
  version: number
): Partial<SettingsState> {
  const state = (persisted ?? {}) as Partial<SettingsState>;
  if (version < 1 && state.defaultConnectorType === 'orthogonal') {
    return { ...state, defaultConnectorType: 'straight' };
  }
  return state;
}

const initialState: SettingsState = {
  defaultConnectorType: 'straight',
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
 * const { defaultConnectorType, setDefaultConnectorType } = useSettingsStore();
 *
 * // Get current setting
 * console.log(defaultConnectorType); // 'orthogonal'
 *
 * // Update setting
 * setDefaultConnectorType('straight');
 * ```
 */
export const useSettingsStore = create<SettingsState & SettingsActions>()(
  persist(
    (set, get) => ({
      // State
      ...initialState,

      // Actions
      setDefaultConnectorType: (type: ConnectorRoutingMode) => {
        set({ defaultConnectorType: type });
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
      // v1: the default new-connector routing flipped orthogonal → straight.
      version: 1,
      migrate: (persisted, version) => migrateSettings(persisted, version),
      partialize: (state) => ({
        defaultConnectorType: state.defaultConnectorType,
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
