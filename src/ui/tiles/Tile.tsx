/**
 * Tile — the shared anatomy of every control in the tile system (JP-253).
 *
 * One vocabulary, used by both the layout menu and Settings, so the two read as
 * one system rather than two surfaces that happen to share a palette.
 *
 * Every tile opens the same way: a tinted **icon chip**, then a **title**, then
 * an optional **value** line, then whatever control it owns. That repetition is
 * the whole point — it is what makes a wall of thirty settings scannable, and it
 * is why the colour-slot tile puts its swatch *in the chip* instead of inventing
 * a bespoke layout (a tile that breaks the anatomy reads as mis-spaced, not as
 * special).
 *
 * Footprints: 1x1 by default, `wide` (2 columns) for anything carrying a
 * horizontal control, `tall` (2 rows) for the fill slider. `TileGrid` reflows
 * them; see `tiles.css` for the mosaic and its two container queries.
 *
 * These components own **presentation only**. Keyboard and ARIA behaviour comes
 * from the existing brand-tokened primitives in `../components` (Radix-backed
 * Switch / SegmentedControl / Slider), which are wrapped here, never
 * reimplemented.
 */

import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Icon } from '../icons';
import { SegmentedControl, type SegmentedOption } from '../components/SegmentedControl';
import { Slider } from '../components/Slider';
import './tiles.css';

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

export interface TileGridProps {
  children: ReactNode;
  /**
   * Column floor (px). The grid fits as many columns of at least this width as
   * it can. 150 suits a settings sheet; a ~340px popover wants ~132 so it still
   * gets two columns.
   */
  min?: number;
  /** Row floor (px). Rows grow past it when their content needs the room. */
  row?: number;
  className?: string;
}

/**
 * The mosaic. `auto-fill` + `minmax` means there is no breakpoint list to
 * maintain — the column count falls out of the available width.
 *
 * `grid-auto-rows` is a *floor*, not a fixed height: chip (30) + gap + control
 * (30) + padding (20) already exceeds a naive row, and every one of those
 * numbers moves again with `--density-mult` and `--ui-scale`. A constant row
 * height silently clips the bottom of every segmented control at some density,
 * which is exactly the defect `tiles.test.tsx` pins.
 */
export function TileGrid({ children, min = 150, row = 86, className = '' }: TileGridProps) {
  return (
    <div
      className={`tile-grid ${className}`.trim()}
      style={{ '--tile-min': `${min}px`, '--tile-row': `${row}px` } as React.CSSProperties}
    >
      {children}
    </div>
  );
}

export interface TileGroupProps {
  title: string;
  icon: LucideIcon;
  children: ReactNode;
  /** Column floor passed through to the grid. */
  min?: number;
  row?: number;
}

/** An icon-led section header over one mosaic. */
export function TileGroup({ title, icon, children, min, row }: TileGroupProps) {
  return (
    <section className="tile-group">
      <div className="tile-group__head">
        <span className="tile-group__icon" aria-hidden="true">
          <Icon icon={icon} size={15} />
        </span>
        <h4 className="tile-group__title">{title}</h4>
        <span className="tile-group__rule" aria-hidden="true" />
      </div>
      <TileGrid {...(min !== undefined ? { min } : {})} {...(row !== undefined ? { row } : {})}>
        {children}
      </TileGrid>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** Footprint + styling props every tile accepts. */
interface TileBaseProps {
  /** Span two columns. */
  wide?: boolean;
  /** Span two rows. */
  tall?: boolean;
  className?: string;
  /** Native tooltip — for detail that supports a choice already understood. */
  title?: string;
  /**
   * Visible help text inside the tile.
   *
   * Use this, not `title`, whenever the reader needs the text *to make* the
   * choice rather than to confirm it — what three spellcheck modes actually do,
   * when a setting takes effect at all. A tooltip is discoverable only by
   * hovering, which rules it out on touch entirely, so anything load-bearing
   * has to be on the tile. The hint lives INSIDE the tile: help floating beside
   * a tile reads as belonging to the group, not the control.
   */
  hint?: string;
}

function footprint({ wide, tall, className = '' }: TileBaseProps): string {
  return ['tile', wide ? 'tile--w2' : '', tall ? 'tile--h2' : '', className]
    .filter(Boolean)
    .join(' ');
}

/** Visible in-tile help. Rendered last so it reads as a footnote to the control. */
function TileHint({ hint }: { hint?: string | undefined }) {
  if (hint == null) return null;
  return <span className="tile__hint">{hint}</span>;
}

interface TileHeadProps {
  icon?: LucideIcon;
  /** Replaces the glyph entirely (the colour swatch, a layout thumbnail). */
  chip?: ReactNode;
  chipStyle?: React.CSSProperties;
  title: string;
  value?: string | undefined;
  trailing?: ReactNode;
}

function TileHead({ icon, chip, chipStyle, title, value, trailing }: TileHeadProps) {
  return (
    <div className="tile__head">
      <span className="tile__chip" style={chipStyle} aria-hidden="true">
        {chip ?? (icon ? <Icon icon={icon} /> : null)}
      </span>
      <span className="tile__text">
        <span className="tile__title">{title}</span>
        {value != null && <span className="tile__value">{value}</span>}
      </span>
      {trailing}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1. Toggle tile — the Control Centre hero
// ---------------------------------------------------------------------------

export interface ToggleTileProps extends TileBaseProps {
  icon: LucideIcon;
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** State words. Default On/Off. */
  onLabel?: string;
  offLabel?: string;
  disabled?: boolean;
  /** Replaces the state word — e.g. "on selection" for a layout-owned panel. */
  note?: string;
  /** Render as a compact row (icon + label only) — for popovers. */
  compact?: boolean;
}

/**
 * The whole tile is the switch. `role="switch"` + `aria-checked` carries the
 * semantics; the visual state is the accent bloom in `tiles.css`.
 */
export function ToggleTile({
  icon,
  label,
  checked,
  onCheckedChange,
  onLabel = 'On',
  offLabel = 'Off',
  disabled = false,
  note,
  compact = false,
  ...base
}: ToggleTileProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      // A switch is named for the thing, not the action — the role plus
      // aria-checked already carry "toggles".
      aria-label={label}
      className={footprint({
        ...base,
        className: `tile--toggle ${compact ? 'tile--chip' : ''} ${base.className ?? ''}`,
      })}
      onClick={() => onCheckedChange(!checked)}
      {...(base.title !== undefined ? { title: base.title } : {})}
    >
      <TileHead icon={icon} title={label} value={note ?? (checked ? onLabel : offLabel)} />
      <TileHint hint={base.hint} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// 2. Segmented tile
// ---------------------------------------------------------------------------

export interface SegmentedTileProps<T extends string> extends TileBaseProps {
  icon: LucideIcon;
  label: string;
  value: T;
  onValueChange: (value: T) => void;
  options: ReadonlyArray<SegmentedOption<T>>;
  /**
   * Accessible name for the group, when the visible title is too terse to stand
   * alone. A tile title leans on its group header for context ("Base" under
   * "Theme"), but that header is not programmatically associated — so a screen
   * reader would just hear "Base". Defaults to `label`.
   */
  ariaLabel?: string;
}

/** Wraps the real `SegmentedControl`, so roving-tabindex + radiogroup semantics
 *  are inherited rather than re-invented. */
export function SegmentedTile<T extends string>({
  icon,
  label,
  value,
  onValueChange,
  options,
  ariaLabel,
  ...base
}: SegmentedTileProps<T>) {
  return (
    <div className={footprint({ wide: true, ...base })} {...(base.title !== undefined ? { title: base.title } : {})}>
      <TileHead icon={icon} title={label} />
      <div className="tile__body">
        <SegmentedControl
          ariaLabel={ariaLabel ?? label}
          value={value}
          onValueChange={onValueChange}
          options={options}
        />
      </div>
      <TileHint hint={base.hint} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. Slider tile
// ---------------------------------------------------------------------------

export interface SliderTileProps extends TileBaseProps {
  icon: LucideIcon;
  label: string;
  value: number;
  onValueChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  /** Suffix on the readout — "%", "s", … */
  unit?: string;
}

export function SliderTile({
  icon,
  label,
  value,
  onValueChange,
  min,
  max,
  step = 1,
  unit = '%',
  ...base
}: SliderTileProps) {
  return (
    <div className={footprint({ wide: true, ...base })} {...(base.title !== undefined ? { title: base.title } : {})}>
      <TileHead
        icon={icon}
        title={label}
        trailing={
          <span className="tile__metric">
            {value}
            {unit}
          </span>
        }
      />
      <div className="tile__body tile__body--slider">
        <Slider
          ariaLabel={label}
          value={value}
          onValueChange={onValueChange}
          min={min}
          max={max}
          step={step}
        />
      </div>
      <TileHint hint={base.hint} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. Fill tile — the Control Centre brightness bar
// ---------------------------------------------------------------------------

export interface FillTileProps extends TileBaseProps {
  icon: LucideIcon;
  label: string;
  value: number;
  onValueChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
}

/**
 * Drag anywhere on the tile. The axis is declared in CSS (`--fill-axis`) so the
 * container query that rotates the tile at narrow widths also rotates the drag —
 * the pointer maths reads the axis rather than guessing from the aspect ratio.
 *
 * `role="slider"` with arrow-key handling, because this is a real control and
 * the drag surface is not keyboard-reachable on its own.
 */
export function FillTile({
  icon,
  label,
  value,
  onValueChange,
  min,
  max,
  step = 5,
  unit = '%',
  ...base
}: FillTileProps) {
  const pct = ((value - min) / (max - min)) * 100;

  const setFromPointer = (el: HTMLElement, clientX: number, clientY: number) => {
    const r = el.getBoundingClientRect();
    const axis = getComputedStyle(el).getPropertyValue('--fill-axis').trim();
    const ratio = axis === 'x' ? (clientX - r.left) / r.width : 1 - (clientY - r.top) / r.height;
    const next = min + Math.min(1, Math.max(0, ratio)) * (max - min);
    onValueChange(Math.round(next / step) * step);
  };

  const clamp = (v: number) => Math.min(max, Math.max(min, v));

  return (
    <div
      className={footprint({ tall: true, ...base, className: `tile--fill ${base.className ?? ''}` })}
      role="slider"
      tabIndex={0}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-label={label}
      style={{ '--level': `${pct}%` } as React.CSSProperties}
      {...(base.title !== undefined ? { title: base.title } : {})}
      onPointerDown={(e) => {
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        setFromPointer(el, e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        setFromPointer(e.currentTarget, e.clientX, e.clientY);
      }}
      onKeyDown={(e) => {
        const jump = e.shiftKey ? step * 2 : step;
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
          onValueChange(clamp(value + jump));
          e.preventDefault();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
          onValueChange(clamp(value - jump));
          e.preventDefault();
        } else if (e.key === 'Home') {
          onValueChange(min);
          e.preventDefault();
        } else if (e.key === 'End') {
          onValueChange(max);
          e.preventDefault();
        }
      }}
    >
      <span className="fill__level" aria-hidden="true" />
      <span className="fill__content">
        <span className="fill__icon" aria-hidden="true">
          <Icon icon={icon} />
        </span>
        <span className="fill__foot">
          <span className="fill__metric">
            {value}
            {unit}
          </span>
          <span className="fill__label">{label}</span>
        </span>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 5. Swatch tile
// ---------------------------------------------------------------------------

export interface SwatchTileProps extends TileBaseProps {
  label: string;
  /** The resolved colour to show. */
  swatch: string;
  /** No explicit value set — the theme engine derives it. */
  derived?: boolean;
  /** Display value under the title (a hex, usually). */
  value?: string | undefined;
  onClick?: () => void;
}

/** The swatch *is* the icon chip — see the anatomy note at the top of the file. */
export function SwatchTile({
  label,
  swatch,
  derived = false,
  value,
  onClick,
  ...base
}: SwatchTileProps) {
  return (
    <button
      type="button"
      className={footprint({ ...base, className: `tile--swatch ${base.className ?? ''}` })}
      onClick={onClick}
      {...(base.title !== undefined ? { title: base.title } : {})}
    >
      <TileHead
        chip={null}
        chipStyle={{ background: swatch }}
        title={label}
        value={derived ? 'Derived' : value}
        trailing={derived ? <span className="tile__badge">Auto</span> : undefined}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// 6. Picker tile
// ---------------------------------------------------------------------------

export interface PickerTileProps extends TileBaseProps {
  icon: LucideIcon;
  label: string;
  value: string;
  onClick?: () => void;
  /** Small colour dots under the title (theme presets). */
  dots?: readonly string[];
  /** Expanded state, when the tile opens an inline sub-sheet. */
  expanded?: boolean;
}

export function PickerTile({
  icon,
  label,
  value,
  onClick,
  dots,
  expanded,
  ...base
}: PickerTileProps) {
  return (
    <button
      type="button"
      className={footprint({ wide: true, ...base, className: `tile--picker ${base.className ?? ''}` })}
      onClick={onClick}
      {...(expanded !== undefined ? { 'aria-expanded': expanded } : {})}
      {...(base.title !== undefined ? { title: base.title } : {})}
    >
      <TileHead
        icon={icon}
        title={label}
        value={value}
        trailing={
          <span className="tile__chev" aria-hidden="true">
            ›
          </span>
        }
      />
      {dots != null && dots.length > 0 && (
        <span className="tile__dots" aria-hidden="true">
          {dots.map((d, i) => (
            <span key={i} className="tile__dot" style={{ background: d }} />
          ))}
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// 7. Action tile
// ---------------------------------------------------------------------------

export interface ActionTileProps extends TileBaseProps {
  icon: LucideIcon;
  label: string;
  value?: string | undefined;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export function ActionTile({
  icon,
  label,
  value,
  onClick,
  danger = false,
  disabled = false,
  ...base
}: ActionTileProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={footprint({
        ...base,
        className: `tile--action ${danger ? 'is-danger' : ''} ${base.className ?? ''}`,
      })}
      onClick={onClick}
      {...(base.title !== undefined ? { title: base.title } : {})}
    >
      <TileHead icon={icon} title={label} value={value} />
      <TileHint hint={base.hint} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// 8. Status tile (read-only)
// ---------------------------------------------------------------------------

export interface StatusTileProps extends TileBaseProps {
  icon: LucideIcon;
  label: string;
  value: string;
  meta?: string | undefined;
}

export function StatusTile({ icon, label, value, meta, ...base }: StatusTileProps) {
  return (
    <div
      className={footprint({ wide: true, ...base, className: `tile--status ${base.className ?? ''}` })}
      {...(base.title !== undefined ? { title: base.title } : {})}
    >
      <TileHead icon={icon} title={label} />
      <div className="tile__body tile__body--status">
        <span className="tile__metric">{value}</span>
        {meta != null && <span className="tile__value">{meta}</span>}
      </div>
      <TileHint hint={base.hint} />
    </div>
  );
}

/**
 * Escape hatch for a control with no matching tile type — a colour field, a
 * bespoke preset row. Gets the tile chrome and mosaic footprint; owns its body.
 *
 * `label` is optional: some hosted controls (ColorField) already render their
 * own label, hint and warning, and duplicating it in the tile head would say
 * everything twice. Omitting it gives a container-only tile.
 */
export interface CustomTileProps extends TileBaseProps {
  icon?: LucideIcon;
  chip?: ReactNode;
  label?: string | undefined;
  value?: string | undefined;
  children?: ReactNode;
}

export function CustomTile({ icon, chip, label, value, children, ...base }: CustomTileProps) {
  return (
    <div className={footprint(base)} {...(base.title !== undefined ? { title: base.title } : {})}>
      {label != null && (
        <TileHead
          {...(icon !== undefined ? { icon } : {})}
          {...(chip !== undefined ? { chip } : {})}
          title={label}
          value={value}
        />
      )}
      {children != null && (
        <div className={label != null ? 'tile__body' : 'tile__body tile__body--only'}>{children}</div>
      )}
      <TileHint hint={base.hint} />
    </div>
  );
}
