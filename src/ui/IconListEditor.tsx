/**
 * Multi-icon editor component for shapes.
 *
 * Provides UI for managing multiple icons on a shape with:
 * - Add/remove icons (up to 4 max)
 * - Individual icon configuration (size, position, display mode, badge)
 * - Collapsible settings per icon
 */

import { useState, useCallback } from 'react';
import {
  IconPosition,
  IconDisplayMode,
  IconBadgeShape,
  IconConfig,
  DEFAULT_BADGE_CONFIG,
} from '../shapes/Shape';
import { IconPicker } from './IconPicker';
import { CompactColorInput } from './CompactColorInput';
import { useIconPresetStore, applyPresetToIconConfig, type IconPreset } from '../store/iconPresetStore';
import './IconListEditor.css';

const MAX_ICONS = 4;

/**
 * Get a display name from an icon ID.
 * Strips 'builtin:' prefix and formats the name.
 */
function getIconDisplayName(iconId: string): string {
  // Remove 'builtin:' prefix if present
  const name = iconId.startsWith('builtin:') ? iconId.slice(8) : iconId;
  // Truncate if too long (likely a hash)
  if (name.length > 20) {
    return name.slice(0, 8) + '...';
  }
  // Replace hyphens with spaces and capitalize
  return name.replace(/-/g, ' ');
}

interface IconListEditorProps {
  /** Array of icon configurations */
  icons: IconConfig[];
  /** Default color for icons (usually stroke color) */
  defaultColor: string;
  /** Callback when icons change */
  onChange: (icons: IconConfig[]) => void;
}

/**
 * Compact number input for icon settings
 */
function MiniNumberInput({
  label,
  value,
  onChange,
  min,
  max,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  suffix?: string;
}) {
  return (
    <div className="icon-mini-input">
      <label>{label}</label>
      <input
        type="number"
        value={value}
        onChange={(e) => {
          const val = Math.max(min, Math.min(max, parseInt(e.target.value) || 0));
          onChange(val);
        }}
        min={min}
        max={max}
      />
      {suffix && <span className="suffix">{suffix}</span>}
    </div>
  );
}

/**
 * Preset selector dropdown
 */
function PresetSelector({
  onApply,
}: {
  onApply: (preset: IconPreset) => void;
}) {
  const getAllPresets = useIconPresetStore((state) => state.getAllPresets);
  const presets = getAllPresets();

  return (
    <div className="icon-preset-selector">
      <label>Preset</label>
      <select
        value=""
        onChange={(e) => {
          const presetId = e.target.value;
          if (presetId) {
            const preset = presets.find((p) => p.id === presetId);
            if (preset) {
              onApply(preset);
            }
          }
        }}
      >
        <option value="">Apply preset...</option>
        <optgroup label="Built-in">
          {presets.filter((p) => p.isBuiltin).map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name}
            </option>
          ))}
        </optgroup>
        {presets.some((p) => !p.isBuiltin) && (
          <optgroup label="Custom">
            {presets.filter((p) => !p.isBuiltin).map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </div>
  );
}

/**
 * Single icon configuration editor (collapsible)
 */
function IconConfigEditor({
  config,
  index,
  defaultColor,
  isExpanded,
  onToggle,
  onChange,
  onRemove,
}: {
  config: IconConfig;
  index: number;
  defaultColor: string;
  isExpanded: boolean;
  onToggle: () => void;
  onChange: (config: IconConfig) => void;
  onRemove: () => void;
}) {
  const iconName = getIconDisplayName(config.iconId);

  const updateConfig = useCallback((updates: Partial<IconConfig>) => {
    onChange({ ...config, ...updates });
  }, [config, onChange]);

  return (
    <div className={`icon-config-item ${isExpanded ? 'expanded' : ''}`}>
      <div className="icon-config-header" onClick={onToggle}>
        <span className="icon-config-index">#{index + 1}</span>
        <span className="icon-config-name" title={iconName}>{iconName}</span>
        <span className="icon-config-position">{config.position}</span>
        <button
          className="icon-config-remove"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          title="Remove icon"
        >
          x
        </button>
      </div>

      {isExpanded && (
        <div className="icon-config-body">
          {/* Icon Picker */}
          <IconPicker
            value={config.iconId}
            onChange={(iconId) => {
              if (iconId) {
                updateConfig({ iconId });
              }
            }}
          />

          {/* Preset Selector */}
          <PresetSelector
            onApply={(preset) => {
              const updated = applyPresetToIconConfig(config, preset);
              onChange(updated);
            }}
          />

          {/* Display Mode */}
          <div className="icon-config-row">
            <label>Mode</label>
            <select
              value={config.displayMode || 'inside'}
              onChange={(e) => updateConfig({ displayMode: e.target.value as IconDisplayMode })}
            >
              <option value="inside">Inside</option>
              <option value="badge">Badge</option>
              <option value="icon-only">Icon Only</option>
            </select>
          </div>

          {/* Size */}
          <MiniNumberInput
            label="Size"
            value={config.size || 24}
            onChange={(val) => updateConfig({ size: val })}
            min={12}
            max={64}
            suffix="px"
          />

          {/* Position & Padding (hidden in icon-only mode) */}
          {config.displayMode !== 'icon-only' && (
            <>
              <div className="icon-config-row">
                <label>Position</label>
                <select
                  value={config.position}
                  onChange={(e) => updateConfig({ position: e.target.value as IconPosition })}
                >
                  <optgroup label="Corners">
                    <option value="top-left">Top Left</option>
                    <option value="top-right">Top Right</option>
                    <option value="bottom-left">Bottom Left</option>
                    <option value="bottom-right">Bottom Right</option>
                  </optgroup>
                  <optgroup label="Edges">
                    <option value="top">Top Center</option>
                    <option value="bottom">Bottom Center</option>
                    <option value="left">Left Center</option>
                    <option value="right">Right Center</option>
                  </optgroup>
                  <optgroup label="Other">
                    <option value="center">Center</option>
                  </optgroup>
                  <optgroup label="Outside">
                    <option value="top-left-outer">Top Left (Outside)</option>
                    <option value="top-right-outer">Top Right (Outside)</option>
                    <option value="bottom-left-outer">Bottom Left (Outside)</option>
                    <option value="bottom-right-outer">Bottom Right (Outside)</option>
                  </optgroup>
                </select>
              </div>

              <MiniNumberInput
                label="Padding"
                value={config.padding || 8}
                onChange={(val) => updateConfig({ padding: val })}
                min={0}
                max={32}
                suffix="px"
              />
            </>
          )}

          {/* Color */}
          <div className="icon-config-row">
            <label>Color</label>
            <CompactColorInput
              label=""
              value={config.color || defaultColor}
              onChange={(color) => updateConfig({ color })}
            />
            {config.color && (
              <button
                className="icon-color-reset-mini"
                onClick={() => {
                  // Remove color property to use default
                  const { color: _, ...rest } = config;
                  onChange(rest as IconConfig);
                }}
                title="Reset to default"
              >
                Reset
              </button>
            )}
          </div>

          {/* Badge Options */}
          {config.displayMode === 'badge' && (
            <div className="icon-badge-options">
              <div className="icon-badge-header">Badge</div>

              <div className="icon-config-row">
                <label>Shape</label>
                <select
                  value={config.badge?.shape || 'circle'}
                  onChange={(e) => {
                    const badge = config.badge || { ...DEFAULT_BADGE_CONFIG };
                    updateConfig({ badge: { ...badge, shape: e.target.value as IconBadgeShape } });
                  }}
                >
                  <option value="circle">Circle</option>
                  <option value="rounded-rect">Rounded</option>
                  <option value="square">Square</option>
                </select>
              </div>

              <div className="icon-config-row">
                <label>Background</label>
                <CompactColorInput
                  label=""
                  value={config.badge?.backgroundColor || '#ffffff'}
                  onChange={(color) => {
                    const badge = config.badge || { ...DEFAULT_BADGE_CONFIG };
                    updateConfig({ badge: { ...badge, backgroundColor: color } });
                  }}
                />
              </div>

              <div className="icon-config-row">
                <label>Border</label>
                <CompactColorInput
                  label=""
                  value={config.badge?.borderColor || ''}
                  onChange={(color) => {
                    const currentBadge = config.badge || { ...DEFAULT_BADGE_CONFIG };
                    const updatedBadge = {
                      ...currentBadge,
                      borderWidth: color ? (currentBadge.borderWidth || 1) : 0,
                    };
                    if (color) {
                      updatedBadge.borderColor = color;
                    } else {
                      delete updatedBadge.borderColor;
                    }
                    updateConfig({ badge: updatedBadge });
                  }}
                />
              </div>

              {config.badge?.borderColor && (
                <MiniNumberInput
                  label="Border Width"
                  value={config.badge?.borderWidth || 1}
                  onChange={(val) => {
                    const badge = config.badge || { ...DEFAULT_BADGE_CONFIG };
                    updateConfig({ badge: { ...badge, borderWidth: val } });
                  }}
                  min={0}
                  max={4}
                  suffix="px"
                />
              )}

              <div className="icon-config-row checkbox">
                <label>
                  <input
                    type="checkbox"
                    checked={config.badge?.shadow || false}
                    onChange={(e) => {
                      const badge = config.badge || { ...DEFAULT_BADGE_CONFIG };
                      updateConfig({ badge: { ...badge, shadow: e.target.checked } });
                    }}
                  />
                  Shadow
                </label>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Main multi-icon list editor component
 */
export function IconListEditor({ icons, defaultColor, onChange }: IconListEditorProps) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [showAddPicker, setShowAddPicker] = useState(false);

  const handleAddIcon = useCallback((iconId: string | undefined) => {
    if (!iconId || icons.length >= MAX_ICONS) return;

    // Find a position that's not already used
    // Priority order: corners first, then edges, then center, then outer
    const usedPositions = new Set(icons.map(i => i.position));
    const positions: IconPosition[] = [
      'top-left', 'top-right', 'bottom-left', 'bottom-right',
      'top', 'bottom', 'left', 'right',
      'center',
      'top-left-outer', 'top-right-outer', 'bottom-left-outer', 'bottom-right-outer',
    ];
    const availablePosition = positions.find(p => !usedPositions.has(p)) || 'top-left';

    const newIcon: IconConfig = {
      iconId,
      position: availablePosition,
    };

    onChange([...icons, newIcon]);
    setExpandedIndex(icons.length); // Expand the new icon
    setShowAddPicker(false);
  }, [icons, onChange]);

  const handleUpdateIcon = useCallback((index: number, config: IconConfig) => {
    const newIcons = [...icons];
    newIcons[index] = config;
    onChange(newIcons);
  }, [icons, onChange]);

  const handleRemoveIcon = useCallback((index: number) => {
    const newIcons = icons.filter((_, i) => i !== index);
    onChange(newIcons);
    if (expandedIndex === index) {
      setExpandedIndex(null);
    } else if (expandedIndex !== null && expandedIndex > index) {
      setExpandedIndex(expandedIndex - 1);
    }
  }, [icons, onChange, expandedIndex]);

  return (
    <div className="icon-list-editor">
      <div className="icon-list-header">
        <span>Icons ({icons.length}/{MAX_ICONS})</span>
        {icons.length < MAX_ICONS && !showAddPicker && (
          <button
            className="icon-add-button"
            onClick={() => setShowAddPicker(true)}
          >
            + Add
          </button>
        )}
      </div>

      {/* Add Icon Picker */}
      {showAddPicker && (
        <div className="icon-add-picker">
          <IconPicker
            value={undefined}
            onChange={handleAddIcon}
          />
          <button
            className="icon-add-cancel"
            onClick={() => setShowAddPicker(false)}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Icon List */}
      {icons.length > 0 && (
        <div className="icon-list">
          {icons.map((config, index) => (
            <IconConfigEditor
              key={`${config.iconId}-${index}`}
              config={config}
              index={index}
              defaultColor={defaultColor}
              isExpanded={expandedIndex === index}
              onToggle={() => setExpandedIndex(expandedIndex === index ? null : index)}
              onChange={(newConfig) => handleUpdateIcon(index, newConfig)}
              onRemove={() => handleRemoveIcon(index)}
            />
          ))}
        </div>
      )}

      {icons.length === 0 && !showAddPicker && (
        <div className="icon-list-empty">
          No icons configured
        </div>
      )}
    </div>
  );
}
