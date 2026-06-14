import { useCallback, useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { BORDER_DASH_PATTERNS } from '../shapes/GroupStyles';
import './BorderStylePicker.css';

type BorderStyle = keyof typeof BORDER_DASH_PATTERNS;

interface BorderStylePickerProps {
  value: number[] | undefined;
  onChange: (dashArray: number[] | undefined) => void;
}

const BORDER_STYLES: { key: BorderStyle; label: string }[] = [
  { key: 'solid', label: 'Solid' },
  { key: 'dashed', label: 'Dashed' },
  { key: 'dotted', label: 'Dotted' },
  { key: 'dashDot', label: 'Dash-Dot' },
];

/**
 * Get the current border style key from a dash array.
 */
function getDashStyleKey(dashArray: number[] | undefined): BorderStyle {
  if (!dashArray || dashArray.length === 0) return 'solid';

  // Try to match known patterns
  for (const [key, pattern] of Object.entries(BORDER_DASH_PATTERNS)) {
    if (arraysEqual(dashArray, pattern)) {
      return key as BorderStyle;
    }
  }

  return 'dashed'; // Default for custom patterns
}

function arraysEqual(a: number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/**
 * BorderStylePicker component for selecting border dash patterns.
 */
export function BorderStylePicker({ value, onChange }: BorderStylePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0 });

  const currentStyle = getDashStyleKey(value);

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

  const handleStyleChange = useCallback(
    (style: BorderStyle) => {
      const pattern = BORDER_DASH_PATTERNS[style];
      onChange(pattern.length > 0 ? [...pattern] : undefined);
      setIsOpen(false);
    },
    [onChange]
  );

  // Render line preview for a dash pattern
  const renderLinePreview = (style: BorderStyle) => {
    const pattern = BORDER_DASH_PATTERNS[style];
    const dashArray = pattern.length > 0 ? pattern.join(',') : 'none';

    return (
      <svg width="60" height="12" viewBox="0 0 60 12">
        <line
          x1="2"
          y1="6"
          x2="58"
          y2="6"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray={dashArray}
        />
      </svg>
    );
  };

  return (
    <div className="border-style-picker">
      <div className="border-style-row">
        <span className="border-style-label">Style</span>
        <button
          ref={buttonRef}
          className="border-style-button"
          onClick={() => setIsOpen(!isOpen)}
        >
          <span className="border-style-preview">{renderLinePreview(currentStyle)}</span>
          <span className="border-style-name">
            {BORDER_STYLES.find((s) => s.key === currentStyle)?.label || 'Solid'}
          </span>
          <span className="border-style-chevron">&#9662;</span>
        </button>
      </div>

      {isOpen &&
        createPortal(
          <div
            ref={dropdownRef}
            className="border-style-dropdown"
            // Portaled to body but logically part of the host panel — keeps an
            // unpinned FlyoutPanel from collapsing while picking a border style.
            data-flyout-keep-open
            style={{ top: dropdownPosition.top, left: dropdownPosition.left }}
          >
            {BORDER_STYLES.map(({ key, label }) => (
              <button
                key={key}
                className={`border-style-option ${key === currentStyle ? 'selected' : ''}`}
                onClick={() => handleStyleChange(key)}
              >
                <span className="border-style-preview">{renderLinePreview(key)}</span>
                <span className="border-style-name">{label}</span>
              </button>
            ))}
          </div>,
          document.body
        )}
    </div>
  );
}
