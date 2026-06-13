import React, { useCallback, useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { PatternConfig, PatternType } from '../shapes/GroupStyles';
import { PATTERN_TYPE_LABELS } from '../shapes/GroupStyles';
import { CompactColorInput } from './CompactColorInput';
import './PatternPicker.css';

interface PatternPickerProps {
  value: PatternConfig | undefined;
  onChange: (config: PatternConfig | undefined) => void;
}

const PATTERN_TYPES: PatternType[] = [
  'none',
  'solid',
  'stripes',
  'hazard',
  'gradient-linear',
  'gradient-radial',
];

/**
 * PatternPicker component for selecting and configuring group background patterns.
 */
export function PatternPicker({ value, onChange }: PatternPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0 });

  // Current pattern type
  const currentType = value?.type || 'none';

  // Update dropdown position when opening
  useEffect(() => {
    if (isOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setDropdownPosition({
        top: rect.bottom + 4,
        left: rect.left,
      });
    }
  }, [isOpen]);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node) &&
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  // Handle pattern type change
  const handleTypeChange = useCallback(
    (type: PatternType) => {
      if (type === 'none') {
        onChange(undefined);
      } else {
        const newConfig: PatternConfig = {
          type,
          color1: value?.color1 || '#ffffff',
          color2: value?.color2 || '#000000',
          angle: value?.angle || 45,
          spacing: value?.spacing || 10,
        };

        // Add gradient stops for gradient types
        if (type === 'gradient-linear' || type === 'gradient-radial') {
          newConfig.gradientStops = value?.gradientStops || [
            { offset: 0, color: newConfig.color1! },
            { offset: 1, color: newConfig.color2! },
          ];
        }

        onChange(newConfig);
      }
      setIsOpen(false);
    },
    [value, onChange]
  );

  // Handle color changes
  const handleColor1Change = useCallback(
    (color: string) => {
      if (!value) return;
      const newConfig = { ...value, color1: color };

      // Also update gradient stops if using gradients
      if (newConfig.gradientStops && newConfig.gradientStops.length > 0) {
        newConfig.gradientStops = [...newConfig.gradientStops];
        const firstStop = newConfig.gradientStops[0];
        if (firstStop) {
          newConfig.gradientStops[0] = { offset: firstStop.offset, color };
        }
      }

      onChange(newConfig);
    },
    [value, onChange]
  );

  const handleColor2Change = useCallback(
    (color: string) => {
      if (!value) return;
      const newConfig = { ...value, color2: color };

      // Also update gradient stops if using gradients
      if (newConfig.gradientStops && newConfig.gradientStops.length > 1) {
        newConfig.gradientStops = [...newConfig.gradientStops];
        const lastIndex = newConfig.gradientStops.length - 1;
        const lastStop = newConfig.gradientStops[lastIndex];
        if (lastStop) {
          newConfig.gradientStops[lastIndex] = { offset: lastStop.offset, color };
        }
      }

      onChange(newConfig);
    },
    [value, onChange]
  );

  // Handle angle change
  const handleAngleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!value) return;
      onChange({ ...value, angle: parseFloat(e.target.value) || 0 });
    },
    [value, onChange]
  );

  // Handle spacing change
  const handleSpacingChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!value) return;
      onChange({ ...value, spacing: parseFloat(e.target.value) || 10 });
    },
    [value, onChange]
  );

  // Render pattern preview swatch
  const renderPatternPreview = (type: PatternType) => {
    const previewSize = 24;
    const color1 = value?.color1 || '#ffffff';
    const color2 = value?.color2 || '#000000';

    switch (type) {
      case 'none':
        return (
          <svg width={previewSize} height={previewSize} viewBox="0 0 24 24">
            <rect x="0" y="0" width="24" height="24" fill="#f0f0f0" />
            <line x1="0" y1="24" x2="24" y2="0" stroke="#ff0000" strokeWidth="2" />
          </svg>
        );
      case 'solid':
        return (
          <svg width={previewSize} height={previewSize} viewBox="0 0 24 24">
            <rect x="0" y="0" width="24" height="24" fill={color1} stroke="#ccc" strokeWidth="1" />
          </svg>
        );
      case 'stripes':
        return (
          <svg width={previewSize} height={previewSize} viewBox="0 0 24 24">
            <defs>
              <pattern id="stripes-preview" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
                <rect width="4" height="8" fill={color1} />
                <rect x="4" width="4" height="8" fill={color2} />
              </pattern>
            </defs>
            <rect x="0" y="0" width="24" height="24" fill="url(#stripes-preview)" stroke="#ccc" strokeWidth="1" />
          </svg>
        );
      case 'hazard':
        return (
          <svg width={previewSize} height={previewSize} viewBox="0 0 24 24">
            <defs>
              <pattern id="hazard-preview" patternUnits="userSpaceOnUse" width="10" height="10" patternTransform="rotate(45)">
                <rect width="5" height="10" fill="#ffcc00" />
                <rect x="5" width="5" height="10" fill="#000000" />
              </pattern>
            </defs>
            <rect x="0" y="0" width="24" height="24" fill="url(#hazard-preview)" stroke="#ccc" strokeWidth="1" />
          </svg>
        );
      case 'gradient-linear':
        return (
          <svg width={previewSize} height={previewSize} viewBox="0 0 24 24">
            <defs>
              <linearGradient id="linear-preview" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor={color1} />
                <stop offset="100%" stopColor={color2} />
              </linearGradient>
            </defs>
            <rect x="0" y="0" width="24" height="24" fill="url(#linear-preview)" stroke="#ccc" strokeWidth="1" />
          </svg>
        );
      case 'gradient-radial':
        return (
          <svg width={previewSize} height={previewSize} viewBox="0 0 24 24">
            <defs>
              <radialGradient id="radial-preview">
                <stop offset="0%" stopColor={color1} />
                <stop offset="100%" stopColor={color2} />
              </radialGradient>
            </defs>
            <rect x="0" y="0" width="24" height="24" fill="url(#radial-preview)" stroke="#ccc" strokeWidth="1" />
          </svg>
        );
      default:
        return null;
    }
  };

  // Check if pattern needs color pickers
  const needsColors = value && value.type !== 'none';
  const needsAngle =
    value && (value.type === 'stripes' || value.type === 'hazard' || value.type === 'gradient-linear');
  const needsSpacing = value && (value.type === 'stripes' || value.type === 'hazard');

  return (
    <div className="pattern-picker">
      {/* Pattern type selector button */}
      <div className="pattern-picker-row">
        <span className="pattern-picker-label">Pattern</span>
        <button
          ref={buttonRef}
          className="pattern-picker-button"
          onClick={() => setIsOpen(!isOpen)}
        >
          <span className="pattern-preview">{renderPatternPreview(currentType)}</span>
          <span className="pattern-name">{PATTERN_TYPE_LABELS[currentType]}</span>
          <span className="pattern-chevron">&#9662;</span>
        </button>
      </div>

      {/* Dropdown for pattern type selection */}
      {isOpen &&
        createPortal(
          <div
            ref={dropdownRef}
            className="pattern-picker-dropdown"
            // Portaled to body but logically part of the host panel — keeps an
            // unpinned FlyoutPanel from collapsing while picking a pattern.
            data-flyout-keep-open
            style={{ top: dropdownPosition.top, left: dropdownPosition.left }}
          >
            {PATTERN_TYPES.map((type) => (
              <button
                key={type}
                className={`pattern-option ${type === currentType ? 'selected' : ''}`}
                onClick={() => handleTypeChange(type)}
              >
                <span className="pattern-preview">{renderPatternPreview(type)}</span>
                <span className="pattern-name">{PATTERN_TYPE_LABELS[type]}</span>
              </button>
            ))}
          </div>,
          document.body
        )}

      {/* Color pickers (when pattern is not 'none') */}
      {needsColors && (
        <>
          <CompactColorInput
            label="Color 1"
            value={value?.color1 || '#ffffff'}
            onChange={handleColor1Change}
          />
          {value?.type !== 'solid' && (
            <CompactColorInput
              label="Color 2"
              value={value?.color2 || '#000000'}
              onChange={handleColor2Change}
            />
          )}
        </>
      )}

      {/* Angle control */}
      {needsAngle && (
        <div className="pattern-picker-row">
          <span className="pattern-picker-label">Angle</span>
          <input
            type="number"
            className="pattern-input"
            value={value?.angle || 45}
            onChange={handleAngleChange}
            min={0}
            max={360}
            step={15}
          />
          <span className="pattern-unit">deg</span>
        </div>
      )}

      {/* Spacing control */}
      {needsSpacing && (
        <div className="pattern-picker-row">
          <span className="pattern-picker-label">Spacing</span>
          <input
            type="number"
            className="pattern-input"
            value={value?.spacing || 10}
            onChange={handleSpacingChange}
            min={4}
            max={50}
            step={2}
          />
          <span className="pattern-unit">px</span>
        </div>
      )}
    </div>
  );
}
