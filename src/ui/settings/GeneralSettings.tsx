/**
 * General Settings component for the Settings modal.
 *
 * Contains:
 * - Default style profile
 * - Show/hide static properties
 * - Hide default style profiles
 *
 * (The connector routing default moved to last-used memory, set from the
 * canvas toolbar's connector dropdown — there's no knob for it here anymore.)
 */

import { useMemo } from 'react';
import { useSettingsStore } from '../../store/settingsStore';
import { useStyleProfileStore } from '../../store/styleProfileStore';
import { RichSelect, type RichSelectItem } from '../components/RichSelect';
import './GeneralSettings.css';

export function GeneralSettings() {
  const defaultStyleProfileId = useSettingsStore((state) => state.defaultStyleProfileId);
  const setDefaultStyleProfileId = useSettingsStore((state) => state.setDefaultStyleProfileId);
  const showStaticProperties = useSettingsStore((state) => state.showStaticProperties);
  const setShowStaticProperties = useSettingsStore((state) => state.setShowStaticProperties);
  const hideDefaultStyleProfiles = useSettingsStore((state) => state.hideDefaultStyleProfiles);
  const setHideDefaultStyleProfiles = useSettingsStore((state) => state.setHideDefaultStyleProfiles);
  const showMinimap = useSettingsStore((state) => state.showMinimap);
  const setShowMinimap = useSettingsStore((state) => state.setShowMinimap);
  const layerClickFocusShape = useSettingsStore((state) => state.layerClickFocusShape);
  const setLayerClickFocusShape = useSettingsStore((state) => state.setLayerClickFocusShape);
  const resetSettings = useSettingsStore((state) => state.resetSettings);

  const profiles = useStyleProfileStore((state) => state.profiles);

  const handleStyleProfileChange = (value: string) => {
    setDefaultStyleProfileId(value === '' ? null : value);
  };

  const styleProfileItems = useMemo<RichSelectItem<string>[]>(
    () => [
      { value: '', label: 'None (Use Tool Defaults)' },
      ...profiles
        .filter((profile) => !hideDefaultStyleProfiles || !profile.id.startsWith('default-'))
        .map((profile) => ({ value: profile.id, label: profile.name })),
    ],
    [profiles, hideDefaultStyleProfiles]
  );

  return (
    <div className="general-settings">
      <h3 className="settings-section-title">General Settings</h3>

      {/* Style Settings */}
      <div className="settings-group">
        <h4 className="settings-group-title">Shapes</h4>

        <div className="settings-row">
          <label className="settings-label">
            Default Style Profile
          </label>
          <RichSelect
            value={defaultStyleProfileId ?? ''}
            onChange={handleStyleProfileChange}
            items={styleProfileItems}
            ariaLabel="Default Style Profile"
            className="settings-select"
            align="end"
          />
          <span className="settings-hint">
            New shapes will be created with this style applied
          </span>
        </div>
      </div>

      {/* Display Settings */}
      <div className="settings-group">
        <h4 className="settings-group-title">Display</h4>

        <div className="settings-row settings-row-checkbox">
          <label className="settings-checkbox-label">
            <input
              type="checkbox"
              className="settings-checkbox"
              checked={showStaticProperties}
              onChange={(e) => setShowStaticProperties(e.target.checked)}
            />
            <span className="settings-checkbox-text">Show Static Properties</span>
          </label>
          <span className="settings-hint">
            Display read-only properties (like ID) in the Property Panel
          </span>
        </div>

        <div className="settings-row settings-row-checkbox">
          <label className="settings-checkbox-label">
            <input
              type="checkbox"
              className="settings-checkbox"
              checked={hideDefaultStyleProfiles}
              onChange={(e) => setHideDefaultStyleProfiles(e.target.checked)}
            />
            <span className="settings-checkbox-text">Hide Default Style Profiles</span>
          </label>
          <span className="settings-hint">
            Only show custom style profiles in the Property Panel
          </span>
        </div>

        <div className="settings-row settings-row-checkbox">
          <label className="settings-checkbox-label">
            <input
              type="checkbox"
              className="settings-checkbox"
              checked={showMinimap}
              onChange={(e) => setShowMinimap(e.target.checked)}
            />
            <span className="settings-checkbox-text">Show Minimap (Experimental)</span>
          </label>
          <span className="settings-hint">
            Display a minimap for navigating large canvases
          </span>
        </div>

        <div className="settings-row settings-row-checkbox">
          <label className="settings-checkbox-label">
            <input
              type="checkbox"
              className="settings-checkbox"
              checked={layerClickFocusShape}
              onChange={(e) => setLayerClickFocusShape(e.target.checked)}
            />
            <span className="settings-checkbox-text">Auto-focus on layer click</span>
          </label>
          <span className="settings-hint">
            Automatically pan camera to shape when clicking in the layer panel
          </span>
        </div>
      </div>

      {/* Reset Settings */}
      <div className="settings-group">
        <h4 className="settings-group-title">Reset</h4>
        <button
          className="settings-reset-btn"
          onClick={() => {
            if (confirm('Reset all settings to defaults?')) {
              resetSettings();
            }
          }}
        >
          Reset to Defaults
        </button>
      </div>
    </div>
  );
}
