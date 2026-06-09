import type { IconDisplayMode } from '../shapes/Shape';

export interface DisplayAsIconToggleProps {
  /** The shape's current icon id (empty/undefined = no icon chosen yet). */
  iconId: string | undefined;
  /** The shape's current icon display mode. */
  displayMode: IconDisplayMode | undefined;
  /** Called with the new display mode when toggled. */
  onChange: (mode: IconDisplayMode) => void;
}

/**
 * Prominent one-click "turn this shape into its icon" control.
 *
 * The capability already exists (`iconDisplayMode: 'icon-only'` hides the box
 * and renders just the vector icon at the shape's bounds), but it's buried as
 * the third option in the Mode dropdown. This surfaces it as the headline
 * action of the Icons section — the discoverability gap called out in *Shapes
 * Design - Core* §2 — so a user can flip any shape into any of the catalog's
 * 1000+ icons in one click. Disabled until an icon is chosen; toggling off
 * returns the shape to the default `inside` mode (icon as decoration on a box).
 */
export function DisplayAsIconToggle({ iconId, displayMode, onChange }: DisplayAsIconToggleProps) {
  const hasIcon = !!iconId;
  const isIconOnly = displayMode === 'icon-only';

  return (
    <label className={`display-as-icon-toggle${hasIcon ? '' : ' is-disabled'}`}>
      <input
        type="checkbox"
        checked={isIconOnly}
        disabled={!hasIcon}
        onChange={(e) => {
          if (!hasIcon) return; // no-op until an icon is chosen
          onChange(e.target.checked ? 'icon-only' : 'inside');
        }}
      />
      <span className="display-as-icon-label">Display as icon</span>
      {!hasIcon && <span className="display-as-icon-hint">pick an icon first</span>}
    </label>
  );
}

export default DisplayAsIconToggle;
