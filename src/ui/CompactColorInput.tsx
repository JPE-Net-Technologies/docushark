import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { ColorPicker, type ColorSpecial } from './color/ColorPicker';
import { parseColorInput } from '../utils/color';
import './CompactColorInput.css';

/**
 * Props for the CompactColorInput component.
 */
interface CompactColorInputProps {
  /** Current color value. May be `''` (no fill) or `'auto'` (contrast-aware). */
  value: string;
  /** Callback when color changes */
  onChange: (color: string) => void;
  /** Label for the input */
  label: string;
  /** Whether to show the "no fill" option in the picker */
  showNoFill?: boolean;
  /** Whether to show the "Automatic" (contrast-aware) option */
  showAuto?: boolean;
  /**
   * Render the swatch alone — no label or hex readout. For dense strips (the
   * property panel's quick bar) where the colour itself is the control and
   * `label` becomes its accessible name. The picker dropdown is unaffected.
   */
  swatchOnly?: boolean;
}

/**
 * The canvas-side trigger for the shared color picker.
 *
 * Owns the swatch, the hex readout, and the portal; the picker body itself is
 * {@link ColorPicker}, shared with the prose and table surfaces.
 *
 * There are deliberately only **two** controls here. The previous version had
 * three — a swatch and a hex readout that both opened the palette, plus a `#`
 * button that opened a *second* hex editor seeded from a different source than
 * the palette's own field. Both now open the one picker, whose hex field is
 * always seeded from `value`.
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
  showNoFill = false,
  showAuto = false,
  swatchOnly = false,
}: CompactColorInputProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);

  // Calculate dropdown position
  const updateDropdownPosition = useCallback(() => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      // Bound the width so the picker never stretches across the screen, and
      // clamp the left edge so it stays on-screen.
      const width = Math.min(264, Math.max(rect.width, 232));
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      setDropdownPosition({ top: rect.bottom + 4, left, width });
    }
  }, []);

  // Close when clicking outside (check both container and portal dropdown)
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const dropdown = document.querySelector('.compact-color-palette-portal');

      if (
        containerRef.current &&
        !containerRef.current.contains(target) &&
        (!dropdown || !dropdown.contains(target))
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  // Update position on scroll/resize
  useEffect(() => {
    if (!isOpen) return;

    const handleUpdate = () => updateDropdownPosition();
    window.addEventListener('scroll', handleUpdate, true);
    window.addEventListener('resize', handleUpdate);

    return () => {
      window.removeEventListener('scroll', handleUpdate, true);
      window.removeEventListener('resize', handleUpdate);
    };
  }, [isOpen, updateDropdownPosition]);

  const togglePicker = useCallback(() => {
    if (!isOpen) updateDropdownPosition();
    setIsOpen((prev) => !prev);
  }, [isOpen, updateDropdownPosition]);

  const handlePick = useCallback(
    (color: string) => {
      onChange(color);
    },
    [onChange]
  );

  const displayValue = value || '';
  const isAuto = displayValue === 'auto';
  const hasValue = Boolean(parseColorInput(displayValue));

  // The canvas expresses "no colour" and "contrast-aware" as stored values, so
  // its specials write those sentinels. Other surfaces pass their own callbacks
  // — the picker never invents a value of its own.
  const specials = useMemo<ColorSpecial[]>(() => {
    const out: ColorSpecial[] = [];
    if (showAuto) {
      out.push({
        id: 'auto',
        label: 'Automatic',
        swatch: 'auto',
        isActive: isAuto,
        onSelect: () => {
          onChange('auto');
          setIsOpen(false);
        },
        hint: 'Adapts to the canvas background — white text on dark shapes, black on light shapes. Always renders as black in exported PDFs.',
      });
    }
    if (showNoFill) {
      out.push({
        id: 'none',
        label: 'No fill',
        swatch: 'none',
        isActive: !hasValue && !isAuto,
        onSelect: () => {
          onChange('');
          setIsOpen(false);
        },
      });
    }
    return out;
  }, [showAuto, showNoFill, isAuto, hasValue, onChange]);

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

  const swatchTitle = `Open ${label.toLowerCase()} picker`;

  const dropdownContent = isOpen && dropdownPosition && (
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
      <ColorPicker
        value={displayValue}
        onChange={handlePick}
        preset="canvas"
        specials={specials}
        compact
      />
    </div>
  );

  return (
    <div
      className={`compact-color-input${swatchOnly ? ' compact-color-input--swatch-only' : ''}`}
      ref={containerRef}
    >
      {!swatchOnly && <label className="compact-color-label">{label}</label>}
      <div className="compact-color-controls" ref={triggerRef}>
        <button
          type="button"
          className="compact-color-swatch"
          style={swatchStyle}
          onClick={togglePicker}
          title={swatchTitle}
          aria-label={swatchTitle}
          aria-expanded={isOpen}
        >
          {isAuto && <span className="compact-color-swatch-auto">A</span>}
          {!hasValue && !isAuto && <span className="compact-color-swatch-none">/</span>}
        </button>
        {!swatchOnly && (
          <button
            type="button"
            className="compact-color-hex-input"
            onClick={togglePicker}
            title={swatchTitle}
          >
            {isAuto ? (
              <span className="compact-color-auto-label">Auto</span>
            ) : hasValue ? (
              displayValue
            ) : (
              'none'
            )}
          </button>
        )}
      </div>

      {dropdownContent && createPortal(dropdownContent, document.body)}
    </div>
  );
}

export default CompactColorInput;
