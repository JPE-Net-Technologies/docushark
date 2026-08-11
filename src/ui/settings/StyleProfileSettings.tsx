/**
 * Style Profile Settings component for the Settings sheet.
 *
 * What gets captured when a new style profile is created from a shape.
 * On the shared tile system (JP-253).
 */

import { Info, Palette, Tag, Type } from 'lucide-react';
import { useSettingsStore } from '../../store/settingsStore';
import { StatusTile, TileGroup, ToggleTile } from '../tiles/Tile';
import './StyleProfileSettings.css';

export function StyleProfileSettings() {
  const saveIconStyleToProfile = useSettingsStore((state) => state.saveIconStyleToProfile);
  const setSaveIconStyleToProfile = useSettingsStore((state) => state.setSaveIconStyleToProfile);
  const saveLabelStyleToProfile = useSettingsStore((state) => state.saveLabelStyleToProfile);
  const setSaveLabelStyleToProfile = useSettingsStore((state) => state.setSaveLabelStyleToProfile);

  return (
    <div className="style-profile-settings">
      <h3 className="settings-section-title">Style Profiles</h3>

      <p className="settings-description">
        What gets captured when you create a new style profile from a shape.
      </p>

      <TileGroup title="Properties to include" icon={Palette}>
        <ToggleTile
          icon={Tag}
          label="Icon style"
          checked={saveIconStyleToProfile}
          onCheckedChange={setSaveIconStyleToProfile}
          hint="Icon ID, size and padding."
        />

        <ToggleTile
          icon={Type}
          label="Label style"
          checked={saveLabelStyleToProfile}
          onCheckedChange={setSaveLabelStyleToProfile}
          hint="Label font size, color, background and offset."
        />

        <StatusTile
          icon={Info}
          label="Scope"
          value="New profiles only"
          hint="Existing profiles keep the properties they were saved with, whatever these are set to now."
        />
      </TileGroup>
    </div>
  );
}
