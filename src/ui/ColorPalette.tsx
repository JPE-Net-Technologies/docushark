import { useState, useCallback } from 'react';
import { useColorPaletteStore } from '../store/colorPaletteStore';
import { lighten, darken } from '../utils/color';
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

const HEX_REGEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Generate 5-shade harmonics: dark→base→light */
function buildHarmonics(hex: string): string[] {
  if (!HEX_REGEX.test(hex)) return [];
  return [
    darken(hex, 40),
    darken(hex, 20),
    hex,
    lighten(hex, 20),
    lighten(hex, 40),
  ];
}

interface ColorPaletteProps {
  /** Currently selected color */
  value: string;
  /** Callback when a color is selected */
  onChange: (color: string) => void;
  /** Whether to show the "no fill" option */
  showNoFill?: boolean;
  /** Whether to show the "Automatic" (contrast-aware) option */
  showAuto?: boolean;
  /** Compact mode - hide labels and reduce spacing */
  compact?: boolean;
}

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

export function ColorPalette({
  value,
  onChange,
  showNoFill = false,
  showAuto = false,
  compact = false,
}: ColorPaletteProps) {
  const { recentColors, customColor, addRecentColor, setCustomColor } =
    useColorPaletteStore();

  const [showCustomInput, setShowCustomInput] = useState(false);
  const [customInputValue, setCustomInputValue] = useState(customColor);

  const normalizedValue = value?.toLowerCase() || '';

  const handleColorSelect = useCallback(
    (color: string) => {
      onChange(color);
      if (color && color !== 'transparent' && color !== '' && color !== 'auto') {
        addRecentColor(color);
      }
    },
    [onChange, addRecentColor]
  );

  const handleCustomApply = useCallback(() => {
    if (customInputValue && HEX_REGEX.test(customInputValue)) {
      setCustomColor(customInputValue);
      handleColorSelect(customInputValue);
      setShowCustomInput(false);
    }
  }, [customInputValue, setCustomColor, handleColorSelect]);

  const handleNativePickerChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const color = e.target.value;
      setCustomInputValue(color);
      setCustomColor(color);
      // Apply immediately — picking a colour in the native picker should take
      // effect right away, not wait for the user to open the hex field and hit
      // Apply.
      handleColorSelect(color);
    },
    [setCustomColor, handleColorSelect]
  );

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

  const harmonics = buildHarmonics(normalizedValue);
  const isAutoSelected = normalizedValue === 'auto';
  const isNoFillSelected = normalizedValue === '' || normalizedValue === 'transparent';

  return (
    <div className={`color-palette-container ${compact ? 'compact' : ''}`}>

      {/* Automatic (contrast-aware) — promoted to top */}
      {showAuto && (
        <div className="color-palette-auto-row">
          <button
            className={`color-swatch color-swatch--auto ${isAutoSelected ? 'selected' : ''}`}
            onClick={() => onChange('auto')}
            aria-label="Automatic color"
          >
            <span className="auto-color-icon">A</span>
          </button>
          <span className="color-palette-special-label">Automatic</span>
          <span className="color-palette-info-btn" role="tooltip" aria-label="What is Automatic color?">
            ℹ
            <span className="color-palette-info-tooltip">
              Adapts to the canvas background — white text on dark shapes, black on light shapes.
              Always renders as black in exported PDFs.
            </span>
          </span>
        </div>
      )}

      {/* No Fill */}
      {showNoFill && (
        <div className="color-palette-nofill-row">
          <button
            className={`color-swatch color-swatch--nofill ${isNoFillSelected ? 'selected' : ''}`}
            onClick={() => onChange('')}
            aria-label="No fill"
          >
            <span className="no-fill-icon">/</span>
          </button>
          <span className="color-palette-special-label">No Fill</span>
        </div>
      )}

      {/* Harmonics — 5 shades of the currently selected color */}
      {harmonics.length > 0 && (
        <div className="color-palette-section">
          {!compact && <div className="color-palette-label">Shades</div>}
          <div className="color-palette-row">
            {harmonics.map((color, i) => (
              <ColorSwatch
                key={`harmonic-${i}-${color}`}
                color={color}
                selected={normalizedValue === color.toLowerCase()}
                onClick={() => handleColorSelect(color)}
                title={color}
              />
            ))}
          </div>
        </div>
      )}

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

    </div>
  );
}

export default ColorPalette;
