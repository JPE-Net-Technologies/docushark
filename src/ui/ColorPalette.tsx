import { useState, useCallback } from 'react';
import { useColorPaletteStore } from '../store/colorPaletteStore';
import './ColorPalette.css';

/**
 * Tailwind-inspired color ramps — 10 hue families × 5 shades each.
 * Each ramp goes from lightest (100) to darkest (900).
 */
const COLOR_RAMPS: { name: string; shades: string[] }[] = [
  { name: 'Slate',   shades: ['#f1f5f9', '#cbd5e1', '#64748b', '#334155', '#0f172a'] },
  { name: 'Red',     shades: ['#fee2e2', '#fca5a5', '#ef4444', '#b91c1c', '#7f1d1d'] },
  { name: 'Orange',  shades: ['#ffedd5', '#fdba74', '#f97316', '#c2410c', '#7c2d12'] },
  { name: 'Amber',   shades: ['#fef3c7', '#fcd34d', '#f59e0b', '#b45309', '#78350f'] },
  { name: 'Emerald', shades: ['#d1fae5', '#6ee7b7', '#10b981', '#047857', '#064e3b'] },
  { name: 'Teal',    shades: ['#ccfbf1', '#5eead4', '#14b8a6', '#0f766e', '#134e4a'] },
  { name: 'Blue',    shades: ['#dbeafe', '#93c5fd', '#3b82f6', '#1d4ed8', '#1e3a5f'] },
  { name: 'Indigo',  shades: ['#e0e7ff', '#a5b4fc', '#6366f1', '#4338ca', '#312e81'] },
  { name: 'Violet',  shades: ['#ede9fe', '#c4b5fd', '#8b5cf6', '#6d28d9', '#4c1d95'] },
  { name: 'Pink',    shades: ['#fce7f3', '#f9a8d4', '#ec4899', '#be185d', '#831843'] },
];

/**
 * Props for the ColorPalette component.
 */
interface ColorPaletteProps {
  /** Currently selected color */
  value: string;
  /** Callback when a color is selected */
  onChange: (color: string) => void;
  /** Whether to show the "no fill" option */
  showNoFill?: boolean;
  /** Compact mode - hide labels and reduce spacing */
  compact?: boolean;
}

/**
 * Color swatch button component.
 */
function ColorSwatch({
  color,
  selected,
  onClick,
  title,
}: {
  color: string;
  selected: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      className={`color-swatch ${selected ? 'selected' : ''}`}
      style={{ backgroundColor: color }}
      onClick={onClick}
      title={title || color}
      aria-label={title || color}
    />
  );
}

/**
 * Enhanced ColorPalette component with Tailwind-style color ramps.
 *
 * Features:
 * - Recent colors section (persisted across sessions)
 * - Custom color input with hex support
 * - 10 hue families × 5 shades (light→dark ramps)
 * - No fill option
 */
export function ColorPalette({
  value,
  onChange,
  showNoFill = false,
  compact = false,
}: ColorPaletteProps) {
  const { recentColors, customColor, addRecentColor, setCustomColor } =
    useColorPaletteStore();

  const [showCustomInput, setShowCustomInput] = useState(false);
  const [customInputValue, setCustomInputValue] = useState(customColor);

  const normalizedValue = value?.toLowerCase() || '';

  // Handle color selection
  const handleColorSelect = useCallback(
    (color: string) => {
      onChange(color);
      if (color && color !== 'transparent' && color !== '') {
        addRecentColor(color);
      }
    },
    [onChange, addRecentColor]
  );

  // Handle custom color apply
  const handleCustomApply = useCallback(() => {
    if (customInputValue && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(customInputValue)) {
      setCustomColor(customInputValue);
      handleColorSelect(customInputValue);
      setShowCustomInput(false);
    }
  }, [customInputValue, setCustomColor, handleColorSelect]);

  // Handle native color picker change
  const handleNativePickerChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const color = e.target.value;
      setCustomInputValue(color);
      setCustomColor(color);
    },
    [setCustomColor]
  );

  // Handle custom input change
  const handleCustomInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      let val = e.target.value;
      if (val && !val.startsWith('#')) {
        val = '#' + val;
      }
      setCustomInputValue(val);
    },
    []
  );

  // Handle custom input keydown
  const handleCustomInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        handleCustomApply();
      } else if (e.key === 'Escape') {
        setShowCustomInput(false);
        setCustomInputValue(customColor);
      }
    },
    [handleCustomApply, customColor]
  );

  return (
    <div className={`color-palette-container ${compact ? 'compact' : ''}`}>
      {/* Recent Colors */}
      {recentColors.length > 0 && (
        <div className="color-palette-section">
          {!compact && <div className="color-palette-label">Recent</div>}
          <div className="color-palette-row">
            {recentColors.map((color, index) => (
              <ColorSwatch
                key={`recent-${index}-${color}`}
                color={color}
                selected={normalizedValue === color.toLowerCase()}
                onClick={() => handleColorSelect(color)}
                title={`Recent: ${color}`}
              />
            ))}
          </div>
        </div>
      )}

      {/* Custom Color */}
      <div className="color-palette-section">
        {!compact && <div className="color-palette-label">Custom</div>}
        <div className="color-palette-custom">
          <input
            type="color"
            value={customColor}
            onChange={handleNativePickerChange}
            className="color-palette-picker"
            title="Pick a custom color"
          />
          {showCustomInput ? (
            <div className="color-palette-custom-input-group">
              <input
                type="text"
                value={customInputValue}
                onChange={handleCustomInputChange}
                onKeyDown={handleCustomInputKeyDown}
                className="color-palette-custom-input"
                placeholder="#000000"
                maxLength={7}
                autoFocus
              />
              <button
                className="color-palette-custom-apply"
                onClick={handleCustomApply}
                title="Apply color"
              >
                Apply
              </button>
            </div>
          ) : (
            <button
              className="color-palette-custom-toggle"
              onClick={() => {
                setShowCustomInput(true);
                setCustomInputValue(customColor);
              }}
              title="Enter hex color"
            >
              {customColor}
            </button>
          )}
        </div>
      </div>

      {/* Color Ramps */}
      <div className="color-palette-ramps">
        {COLOR_RAMPS.map((ramp) => (
          <div key={ramp.name} className="color-palette-ramp-row">
            {!compact && (
              <div className="color-palette-ramp-label">{ramp.name}</div>
            )}
            <div className="color-palette-ramp-shades">
              {ramp.shades.map((color) => (
                <ColorSwatch
                  key={color}
                  color={color}
                  selected={normalizedValue === color.toLowerCase()}
                  onClick={() => handleColorSelect(color)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* No Fill Option */}
      {showNoFill && (
        <div className="color-palette-section">
          <button
            className={`color-swatch no-fill ${
              normalizedValue === '' || normalizedValue === 'transparent' ? 'selected' : ''
            }`}
            onClick={() => onChange('')}
            title="No fill"
            aria-label="No fill"
          >
            <span className="no-fill-icon">/</span>
          </button>
          {!compact && <span className="color-palette-nofill-label">No Fill</span>}
        </div>
      )}
    </div>
  );
}

export default ColorPalette;
