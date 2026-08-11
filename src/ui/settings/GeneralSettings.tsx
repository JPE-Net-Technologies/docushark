/**
 * General Settings component for the Settings sheet.
 *
 * Contains:
 * - Default style profile
 * - Show/hide static properties
 * - Hide default style profiles
 * - Minimap + layer-click focus
 *
 * (The connector routing default moved to last-used memory, set from the
 * canvas toolbar's connector dropdown — there's no knob for it here anymore.)
 *
 * On the shared tile system (JP-253), same as Appearance. The four checkboxes
 * become toggle tiles: a checkbox plus a separate label plus a hint below was
 * three elements to say one thing.
 */

import { useMemo } from 'react';
import { Crosshair, Eye, EyeOff, Map, Palette, RotateCcw, Shapes, Monitor } from 'lucide-react';
import { useSettingsStore } from '../../store/settingsStore';
import { useStyleProfileStore } from '../../store/styleProfileStore';
import { RichSelect, type RichSelectItem } from '../components/RichSelect';
import { ActionTile, CustomTile, TileGroup, ToggleTile } from '../tiles/Tile';
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

  const activeProfileName =
    styleProfileItems.find((i) => i.value === (defaultStyleProfileId ?? ''))?.label ?? 'None';

  return (
    <div className="general-settings">
      <h3 className="settings-section-title">General</h3>

      <TileGroup title="Shapes" icon={Shapes}>
        <CustomTile
          wide
          icon={Palette}
          label="Default style profile"
          value={activeProfileName}
          hint="New shapes are created with this style applied."
        >
          <RichSelect
            value={defaultStyleProfileId ?? ''}
            onChange={handleStyleProfileChange}
            items={styleProfileItems}
            ariaLabel="Default Style Profile"
            className="settings-select"
            align="end"
          />
        </CustomTile>
      </TileGroup>

      <TileGroup title="Display" icon={Monitor}>
        <ToggleTile
          icon={Eye}
          label="Static properties"
          checked={showStaticProperties}
          onCheckedChange={setShowStaticProperties}
          hint="Show read-only properties (like ID) in the Property Panel."
        />

        <ToggleTile
          icon={EyeOff}
          label="Hide default style profiles"
          checked={hideDefaultStyleProfiles}
          onCheckedChange={setHideDefaultStyleProfiles}
          hint="Show only your custom profiles in the Property Panel."
        />

        <ToggleTile
          icon={Map}
          label="Minimap"
          checked={showMinimap}
          onCheckedChange={setShowMinimap}
          hint="Experimental. Helps navigate large canvases."
        />

        <ToggleTile
          icon={Crosshair}
          label="Auto-focus on layer click"
          checked={layerClickFocusShape}
          onCheckedChange={setLayerClickFocusShape}
          hint="Pan the camera to a shape when you click it in the Layers panel."
        />
      </TileGroup>

      <TileGroup title="Reset" icon={RotateCcw}>
        <ActionTile
          danger
          icon={RotateCcw}
          label="Reset settings"
          value="Back to defaults"
          onClick={() => {
            if (confirm('Reset all settings to defaults?')) {
              resetSettings();
            }
          }}
          hint="Everything on this tab, restored to its shipped value."
        />
      </TileGroup>
    </div>
  );
}
