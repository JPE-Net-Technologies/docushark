import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { HexColorPicker } from 'react-colorful';
import { useColorPaletteStore } from '../../store/colorPaletteStore';
import { lighten, darken, parseColorInput, contrastRatio } from '../../utils/color';
import { COLOR_PRESETS, type ColorPresetName, type SwatchGroup } from './presets';
import './ColorPicker.css';

/**
 * A non-color choice offered above the swatches — "No fill", "Automatic",
 * "Default", "None".
 *
 * Each carries its own `onSelect` **callback** rather than a sentinel value the
 * picker would write itself. This matters: on the canvas "Automatic" is the
 * stored string `'auto'`, while in prose "Default" is the *absence* of a mark.
 * A shared magic value would leak `'auto'` into prose HTML and the schema
 * contract, so the picker never invents one.
 */
export interface ColorSpecial {
  /** Stable key, also used to detect which special is active. */
  id: string;
  /** User-facing name, e.g. "No fill". */
  label: string;
  /** Swatch treatment: the half-and-half "auto" tile or a hatched "none" tile. */
  swatch: 'auto' | 'none';
  /** Whether this special is the current value. */
  isActive: boolean;
  /** Applies the special. The picker calls this and nothing else. */
  onSelect: () => void;
  /** Optional explanation shown in an info tooltip. */
  hint?: string;
}

export interface ColorPickerProps {
  /** Current color. May be empty or a surface sentinel; both render as unset. */
  value: string;
  /** Called with a canonical `#rrggbb` when a color is chosen. */
  onChange: (color: string) => void;
  /** Which swatch vocabulary to lead with. Defaults to `canvas`. */
  preset?: ColorPresetName;
  /** Non-color choices rendered first. Omit for none. */
  specials?: ColorSpecial[];
  /**
   * Background to measure contrast against. When set, a live contrast readout
   * appears next to the hex field — useful for prose text and cell fills, where
   * an unreadable pairing is easy to pick and hard to notice.
   */
  contrastAgainst?: string;
  /** Denser spacing for in-panel dropdowns. Does not hide labels. */
  compact?: boolean;
}

/**
 * Steps from dark to light around the current color.
 *
 * Deduplicated because the ends clamp: white lightened is still white, so a
 * naive five-step ramp renders the same swatch three times.
 */
function buildVariations(hex: string): string[] {
  return [...new Set([darken(hex, 40), darken(hex, 20), hex, lighten(hex, 20), lighten(hex, 40)])];
}

/** WCAG band for a contrast ratio against normal-size body text. */
function contrastGrade(ratio: number): { label: string; tone: 'pass' | 'warn' | 'fail' } {
  if (ratio >= 7) return { label: 'AAA', tone: 'pass' };
  if (ratio >= 4.5) return { label: 'AA', tone: 'pass' };
  if (ratio >= 3) return { label: 'Large only', tone: 'warn' };
  return { label: 'Fail', tone: 'fail' };
}

/**
 * The shared color picker body — one component behind every color control in
 * the editor: shape fill and stroke, prose text and highlight, and table cell
 * backgrounds.
 *
 * The organizing rule is that **the hex field is the invariant**. It is present,
 * identical, and always seeded from the current `value` on every surface;
 * everything above it (which swatches, which non-color specials) is
 * surface-specific vocabulary. That is what makes the canvas and the document
 * feel like one tool rather than two that happen to ship together.
 *
 * Renders as a popover body — the caller owns the trigger and the portal.
 */
export function ColorPicker({
  value,
  onChange,
  preset = 'canvas',
  specials,
  contrastAgainst,
  compact = false,
}: ColorPickerProps) {
  const { recentColors, addRecentColor } = useColorPaletteStore();

  const [showCustom, setShowCustom] = useState(false);
  const [draft, setDraft] = useState('');
  const [isDirty, setIsDirty] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);

  const canonical = useMemo(() => parseColorInput(value) ?? '', [value]);

  // The hex field tracks the live value until the user starts typing, so it can
  // never show a stale color from a previous selection — the defect where the
  // panel read one color and the picker's field read another.
  useEffect(() => {
    if (!isDirty) setDraft(canonical);
  }, [canonical, isDirty]);

  const groups: SwatchGroup[] = COLOR_PRESETS[preset];

  const commit = useCallback(
    (color: string) => {
      const parsed = parseColorInput(color);
      if (!parsed) return;
      onChange(parsed);
      addRecentColor(parsed);
    },
    [onChange, addRecentColor]
  );

  // Dragging the saturation area fires continuously; committing each frame to
  // recents would flood it, so the visual picker updates the value only.
  const handlePickerDrag = useCallback(
    (color: string) => {
      const parsed = parseColorInput(color);
      if (parsed) onChange(parsed);
    },
    [onChange]
  );

  const draftParsed = draft ? parseColorInput(draft) : null;
  const draftInvalid = isDirty && draft.length > 0 && draftParsed === null;

  const handleDraftChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    // Deliberately no coercion here. The old field force-prepended `#` on every
    // keystroke, which made the `#` impossible to delete and mangled pastes.
    setDraft(e.target.value);
    setIsDirty(true);
  }, []);

  const handleDraftCommit = useCallback(() => {
    if (!isDirty) return;
    if (draftParsed) {
      commit(draftParsed);
      setDraft(draftParsed);
      setIsDirty(false);
    }
    // Invalid input stays put and keeps its invalid styling rather than being
    // silently reverted — the user can see and fix what they typed.
  }, [isDirty, draftParsed, commit]);

  const handleDraftKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleDraftCommit();
      } else if (e.key === 'Escape') {
        setDraft(canonical);
        setIsDirty(false);
      }
    },
    [handleDraftCommit, canonical]
  );

  // ── Roving tabindex ──────────────────────────────────────────────
  // The swatch grid is one tab stop, not ~60. Arrow keys move within it.
  const [activeCell, setActiveCell] = useState<[number, number]>([0, 0]);
  const navRows = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  const allRows = useMemo(
    () => (recentColors.length > 0 ? [...navRows, recentColors] : navRows),
    [navRows, recentColors]
  );

  const handleGridKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const [r, c] = activeCell;
      const rowCount = allRows.length;
      if (rowCount === 0) return;

      let next: [number, number] | null = null;
      if (e.key === 'ArrowRight') next = [r, c + 1];
      else if (e.key === 'ArrowLeft') next = [r, c - 1];
      else if (e.key === 'ArrowDown') next = [r + 1, c];
      else if (e.key === 'ArrowUp') next = [r - 1, c];
      else if (e.key === 'Home') next = [r, 0];
      else if (e.key === 'End') next = [r, (allRows[r]?.length ?? 1) - 1];
      if (!next) return;

      e.preventDefault();
      const row = Math.max(0, Math.min(rowCount - 1, next[0]));
      const col = Math.max(0, Math.min((allRows[row]?.length ?? 1) - 1, next[1]));
      setActiveCell([row, col]);
      gridRef.current
        ?.querySelector<HTMLElement>(`[data-cell="${row}-${col}"]`)
        ?.focus();
    },
    [activeCell, allRows]
  );

  const ratio = contrastAgainst && canonical ? contrastRatio(canonical, contrastAgainst) : null;
  const grade = ratio !== null ? contrastGrade(ratio) : null;

  let rowOffset = 0;

  return (
    <div className={`color-picker${compact ? ' color-picker--compact' : ''}`}>
      <div className="color-picker__scroll">
        {specials && specials.length > 0 && (
          <div className="color-picker__specials">
            {specials.map((s) => (
              <div key={s.id} className="color-picker__special-row">
                <button
                  type="button"
                  className={`color-picker__special-swatch color-picker__special-swatch--${s.swatch}${
                    s.isActive ? ' is-selected' : ''
                  }`}
                  onClick={s.onSelect}
                  aria-label={s.label}
                  aria-pressed={s.isActive}
                >
                  {s.swatch === 'auto' ? (
                    <span className="color-picker__special-glyph">A</span>
                  ) : (
                    <span className="color-picker__special-glyph color-picker__special-glyph--none">/</span>
                  )}
                </button>
                <span className="color-picker__special-label">{s.label}</span>
                {s.hint && (
                  <span className="color-picker__info" role="tooltip" aria-label={s.hint}>
                    i<span className="color-picker__info-tip">{s.hint}</span>
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        <div ref={gridRef} onKeyDown={handleGridKeyDown}>
          {groups.map((group) => {
            const start = rowOffset;
            rowOffset += group.rows.length;
            return (
              <section className="color-picker__group" key={group.label}>
                <h4 className="color-picker__group-label">{group.label}</h4>
                {group.rows.map((row, ri) => (
                  <div className="color-picker__row" key={`${group.label}-${ri}`}>
                    {row.map((color, ci) => (
                      <button
                        type="button"
                        key={color}
                        data-cell={`${start + ri}-${ci}`}
                        tabIndex={activeCell[0] === start + ri && activeCell[1] === ci ? 0 : -1}
                        className={`color-picker__swatch${
                          canonical === color ? ' is-selected' : ''
                        }`}
                        style={{ backgroundColor: color }}
                        onClick={() => {
                          setActiveCell([start + ri, ci]);
                          commit(color);
                        }}
                        title={color}
                        aria-label={color}
                      />
                    ))}
                  </div>
                ))}
              </section>
            );
          })}

          {recentColors.length > 0 && (
            <section className="color-picker__group">
              <h4 className="color-picker__group-label">Recent</h4>
              <div className="color-picker__row">
                {recentColors.map((color, ci) => (
                  <button
                    type="button"
                    key={`recent-${color}`}
                    data-cell={`${navRows.length}-${ci}`}
                    tabIndex={activeCell[0] === navRows.length && activeCell[1] === ci ? 0 : -1}
                    className={`color-picker__swatch${canonical === color ? ' is-selected' : ''}`}
                    style={{ backgroundColor: color }}
                    onClick={() => {
                      setActiveCell([navRows.length, ci]);
                      commit(color);
                    }}
                    title={color}
                    aria-label={`Recent ${color}`}
                  />
                ))}
              </div>
            </section>
          )}
        </div>

        {showCustom && (
          <section className="color-picker__custom">
            <HexColorPicker color={canonical || '#000000'} onChange={handlePickerDrag} />
            <h4 className="color-picker__group-label">Variations</h4>
            <div className="color-picker__row">
              {buildVariations(canonical || '#000000').map((color) => (
                <button
                  type="button"
                  key={`var-${color}`}
                  className={`color-picker__swatch${canonical === color ? ' is-selected' : ''}`}
                  style={{ backgroundColor: color }}
                  onClick={() => commit(color)}
                  title={color}
                  aria-label={color}
                />
              ))}
            </div>
          </section>
        )}
      </div>

      {/* The invariant: same hex field on every surface, always seeded from the
          current value, pinned so it never scrolls out of reach. */}
      <div className="color-picker__footer">
        <span
          className="color-picker__preview"
          style={canonical ? { backgroundColor: canonical } : undefined}
          aria-hidden="true"
        />
        <input
          type="text"
          className={`color-picker__hex${draftInvalid ? ' is-invalid' : ''}`}
          value={draft}
          onChange={handleDraftChange}
          onBlur={handleDraftCommit}
          onKeyDown={handleDraftKeyDown}
          placeholder="#000000"
          spellCheck={false}
          autoComplete="off"
          aria-label="Hex color"
          aria-invalid={draftInvalid}
        />
        {grade && (
          <span
            className={`color-picker__contrast color-picker__contrast--${grade.tone}`}
            title={`Contrast against the current background: ${ratio!.toFixed(2)}:1`}
          >
            {ratio!.toFixed(1)}:1 {grade.label}
          </span>
        )}
        <button
          type="button"
          className={`color-picker__custom-toggle${showCustom ? ' is-open' : ''}`}
          onClick={() => setShowCustom((v) => !v)}
          aria-expanded={showCustom}
        >
          Custom
        </button>
      </div>
    </div>
  );
}

export default ColorPicker;
