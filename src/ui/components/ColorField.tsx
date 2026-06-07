/**
 * ColorField — one color slot in the theme builder: a swatch that opens a
 * popover with a react-colorful picker + hex input, plus "Use default" to clear
 * the override (fall back to the base token). Shows an optional contrast warning.
 *
 * `value === undefined` means "not overridden" — the swatch shows `defaultSwatch`
 * (the base's representative color) and the field reads as Default.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { HexColorPicker, HexColorInput } from 'react-colorful';
import { AlertTriangle } from 'lucide-react';
import './ColorField.css';

export interface ColorFieldProps {
  label: string;
  hint?: string;
  /** Current override, or undefined when the base default applies. */
  value: string | undefined;
  /** Representative swatch shown when unset. */
  defaultSwatch: string;
  onChange: (value: string | undefined) => void;
  /** Inline contrast warning text, if any. */
  warning?: string;
}

export function ColorField({ label, hint, value, defaultSwatch, onChange, warning }: ColorFieldProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const swatch = value ?? defaultSwatch;
  const isDefault = value === undefined;

  // Normalize to a leading-# hex before storing — HexColorInput can emit the
  // bare hex, which is not a valid CSS color value.
  const handlePick = useCallback(
    (c: string) => onChange(c ? (c.startsWith('#') ? c : `#${c}`) : undefined),
    [onChange]
  );

  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && !wrapRef.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  return (
    <div className="color-field" ref={wrapRef}>
      <div className="color-field__head">
        <span className="color-field__label">{label}</span>
        {hint && <span className="color-field__hint">{hint}</span>}
      </div>

      <div className="color-field__control">
        <button
          type="button"
          className="color-field__swatch"
          style={{ background: swatch }}
          aria-label={`${label}: ${isDefault ? 'Default' : swatch}. Click to change.`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        />
        <span className="color-field__value">{isDefault ? 'Default' : swatch}</span>
        {warning && (
          <span className="color-field__warning" role="status" title={warning}>
            <AlertTriangle size={13} aria-hidden="true" /> {warning}
          </span>
        )}
      </div>

      {open && (
        <div className="color-field__popover" role="dialog" aria-label={`${label} color`}>
          <HexColorPicker color={swatch} onChange={handlePick} />
          <div className="color-field__popover-row">
            <span className="color-field__hash">#</span>
            <HexColorInput
              className="color-field__hex"
              color={swatch}
              onChange={handlePick}
              aria-label={`${label} hex value`}
            />
            <button
              type="button"
              className="color-field__default-btn"
              disabled={isDefault}
              onClick={() => {
                onChange(undefined);
                close();
              }}
            >
              Use default
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
