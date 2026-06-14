import { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useColorPaletteStore } from '../store/colorPaletteStore';
import { ColorPalette } from './ColorPalette';
import './CompactColorInput.css';

/**
 * Props for the CompactColorInput component.
 */
interface CompactColorInputProps {
  /** Current color value */
  value: string;
  /** Callback when color changes */
  onChange: (color: string) => void;
  /** Label for the input */
  label: string;
  /** Whether to show palette on click */
  showPalette?: boolean;
  /** Whether to show the "no fill" option in palette */
  showNoFill?: boolean;
  /** Whether to show the "Automatic" (contrast-aware) option */
  showAuto?: boolean;
}

/**
 * Compact color input component with inline picker and hex display.
 *
 * Features:
 * - Native color picker
 * - Hex value display/input
 * - Click to expand color palette
 * - Recent colors tracking
 * - Portal-based dropdown to avoid overflow clipping
 *
 * Usage:
 * ```tsx
 * <CompactColorInput
 *   label="Fill"
 *   value={shape.fill}
 *   onChange={(color) => updateShape({ fill: color })}
 *   showNoFill
 * />
 * ```
 */
export function CompactColorInput({
  value,
  onChange,
  label,
  showPalette = true,
  showNoFill = false,
  showAuto = false,
}: CompactColorInputProps) {
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(value || '');
  const [dropdownPosition, setDropdownPosition] = useState<{ top: number; left: number; width: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { addRecentColor } = useColorPaletteStore();

  // Calculate dropdown position
  const updateDropdownPosition = useCallback(() => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      // Bound the width so the palette never stretches across the screen, and
      // clamp the left edge so it stays on-screen.
      const width = Math.min(264, Math.max(rect.width, 232));
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      setDropdownPosition({ top: rect.bottom + 4, left, width });
    }
  }, []);

  // Close palette when clicking outside (check both container and portal dropdown)
  useEffect(() => {
    if (!isPaletteOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const dropdown = document.querySelector('.compact-color-palette-portal');

      if (
        containerRef.current &&
        !containerRef.current.contains(target) &&
        (!dropdown || !dropdown.contains(target))
      ) {
        setIsPaletteOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isPaletteOpen]);

  // Update position on scroll/resize
  useEffect(() => {
    if (!isPaletteOpen) return;

    const handleUpdate = () => updateDropdownPosition();
    window.addEventListener('scroll', handleUpdate, true);
    window.addEventListener('resize', handleUpdate);

    return () => {
      window.removeEventListener('scroll', handleUpdate, true);
      window.removeEventListener('resize', handleUpdate);
    };
  }, [isPaletteOpen, updateDropdownPosition]);

  // Handle native picker change
  const handlePickerChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const color = e.target.value;
      onChange(color);
      addRecentColor(color);
    },
    [onChange, addRecentColor]
  );

  // Handle hex input click - toggle palette
  const handleHexClick = useCallback(() => {
    if (showPalette) {
      if (!isPaletteOpen) {
        updateDropdownPosition();
      }
      setIsPaletteOpen((prev) => !prev);
    } else {
      setIsEditing(true);
      setEditValue(value || '');
    }
  }, [showPalette, value, isPaletteOpen, updateDropdownPosition]);

  // Handle starting edit mode
  const handleStartEdit = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setIsEditing(true);
      setEditValue(value || '');
      setIsPaletteOpen(false);
    },
    [value]
  );

  // Handle edit input change
  const handleEditChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    let val = e.target.value;
    if (val && !val.startsWith('#')) {
      val = '#' + val;
    }
    setEditValue(val);
  }, []);

  // Handle edit input blur
  const handleEditBlur = useCallback(() => {
    setIsEditing(false);
    if (editValue && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(editValue)) {
      onChange(editValue.toLowerCase());
      addRecentColor(editValue.toLowerCase());
    } else {
      setEditValue(value || '');
    }
  }, [editValue, onChange, addRecentColor, value]);

  // Handle edit input keydown
  const handleEditKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        handleEditBlur();
      } else if (e.key === 'Escape') {
        setIsEditing(false);
        setEditValue(value || '');
      }
    },
    [handleEditBlur, value]
  );

  // Handle palette color selection
  const handlePaletteSelect = useCallback(
    (color: string) => {
      onChange(color);
      setIsPaletteOpen(false);
    },
    [onChange]
  );

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const displayValue = value || '';
  const isAuto = displayValue === 'auto';
  const hasValue = displayValue && displayValue !== 'transparent' && !isAuto;

  // Render dropdown via portal
  const dropdownContent = isPaletteOpen && showPalette && dropdownPosition && (
    <div
      className="compact-color-palette-dropdown compact-color-palette-portal"
      // Logically part of whatever panel opened us, even though we render in a
      // portal on document.body — keeps an unpinned FlyoutPanel from collapsing
      // when the user picks a color here.
      data-flyout-keep-open
      style={{
        position: 'fixed',
        top: dropdownPosition.top,
        left: dropdownPosition.left,
        width: dropdownPosition.width,
        maxWidth: 'calc(100vw - 16px)',
        boxSizing: 'border-box',
        zIndex: 10000,
      }}
    >
      <ColorPalette
        value={displayValue}
        onChange={handlePaletteSelect}
        showNoFill={showNoFill}
        showAuto={showAuto}
        compact
      />
    </div>
  );

  // Visual style for the swatch button: solid colour, "no fill" diagonal, or
  // the contrast-aware "Auto" half-and-half pattern.
  const swatchStyle: React.CSSProperties = isAuto
    ? {
        background:
          'linear-gradient(135deg, #ffffff 0%, #ffffff 50%, #000000 50%, #000000 100%)',
      }
    : hasValue
      ? { backgroundColor: displayValue }
      : {
          background:
            'repeating-linear-gradient(45deg, #fff, #fff 4px, #eee 4px, #eee 8px)',
        };

  const swatchTitle = showPalette
    ? `Open ${label.toLowerCase()} palette`
    : `Pick ${label.toLowerCase()} color`;

  return (
    <div className="compact-color-input" ref={containerRef}>
      <label className="compact-color-label">{label}</label>
      <div className="compact-color-controls" ref={triggerRef}>
        {showPalette ? (
          <button
            type="button"
            className="compact-color-swatch"
            style={swatchStyle}
            onClick={handleHexClick}
            title={swatchTitle}
            aria-label={swatchTitle}
          >
            {isAuto && <span className="compact-color-swatch-auto">A</span>}
            {!hasValue && !isAuto && (
              <span className="compact-color-swatch-none">/</span>
            )}
          </button>
        ) : (
          <input
            type="color"
            value={hasValue ? displayValue : '#000000'}
            onChange={handlePickerChange}
            className="compact-color-picker"
            title={swatchTitle}
          />
        )}
        {isEditing ? (
          <input
            ref={inputRef}
            type="text"
            value={editValue}
            onChange={handleEditChange}
            onBlur={handleEditBlur}
            onKeyDown={handleEditKeyDown}
            className="compact-color-hex-input editing"
            maxLength={7}
          />
        ) : (
          <button
            className="compact-color-hex-input"
            onClick={handleHexClick}
            title={showPalette ? 'Open color palette' : 'Edit color'}
          >
            {isAuto ? <span className="compact-color-auto-label">Auto</span> : hasValue ? displayValue : 'none'}
          </button>
        )}
        {(hasValue || isAuto) && showPalette && !isEditing && (
          <button
            className="compact-color-edit"
            onClick={handleStartEdit}
            title="Edit hex value"
          >
            #
          </button>
        )}
      </div>

      {/* Color Palette Dropdown - rendered via portal */}
      {dropdownContent && createPortal(dropdownContent, document.body)}
    </div>
  );
}

export default CompactColorInput;
