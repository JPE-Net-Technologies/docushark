/**
 * Label specification — the declarative description of how a shape's label
 * behaves: where it sits, how it overflows, and its default typography.
 *
 * A `LabelSpec` is authored data (per shape type, or per `LibraryShapeDefinition`).
 * The label engine (`layoutLabel` / `renderLabel`) reads it together with the
 * shape's runtime label fields to produce a concrete `LabelLayout`.
 *
 * This module is pure and free of canvas/DOM dependencies so it can be unit
 * tested with a fake measurer.
 */

import type { GroupLabelPosition } from '../GroupStyles';

/**
 * How a label behaves when its text does not fit the available box.
 *
 * - `overflow`     — wrap at word boundaries; lines past the box height are
 *                    clipped (the historical rect/ellipse/library behavior).
 * - `squeeze-into` — wrap at word boundaries, then shrink the font down to
 *                    `minFontSize` until the text fits the box.
 * - `break-word`   — wrap at word boundaries, but break a single token mid-word
 *                    when it is wider than the box; lines past height are clipped.
 */
export type LabelOverflow = 'overflow' | 'squeeze-into' | 'break-word';

/**
 * Where the label is anchored relative to its shape.
 */
export type LabelPlacement =
  | { kind: 'inside-centered' }
  | { kind: 'offset' }
  | { kind: 'nine-grid'; position: GroupLabelPosition }
  | { kind: 'along-path'; t: number }
  | { kind: 'header-bar' };

/**
 * Declarative label behavior for a shape type.
 */
export interface LabelSpec {
  /** Which shape field holds the editable text. */
  textField: 'label' | 'text';
  /** Behavior when text exceeds the box. */
  overflow: LabelOverflow;
  /** Anchor placement relative to the shape. */
  placement: LabelPlacement;
  /** Fraction of width/height usable for text (rect/ellipse use 0.85). */
  insetRatio?: { w: number; h: number };
  /** Font family. Default 'sans-serif'. */
  fontFamily?: string;
  /** Default font size when the shape carries no explicit `labelFontSize`. */
  defaultFontSize: number;
  /** Lower bound for `squeeze-into` shrink. Default 6. */
  minFontSize?: number;
  /** Horizontal text alignment. Default 'center'. */
  align?: 'left' | 'center' | 'right';
  /** Vertical alignment within the box. Default 'middle'. */
  verticalAlign?: 'top' | 'middle' | 'bottom';
  /** Force a single line (no wrap) — preserves connector/group look. */
  singleLine?: boolean;
  /** Honor the shape's `labelBackground` pill. */
  background?: boolean;
}

/**
 * Result of laying out a label — pure data the renderer consumes.
 */
export interface LabelLayout {
  /** Wrapped lines, already clipped to fit when applicable. */
  lines: string[];
  /** Final font size in px (may be reduced by `squeeze-into`). */
  fontSize: number;
  /** Line height in px. */
  lineHeight: number;
  /** Widest measured line width in px. */
  totalWidth: number;
  /** Total stacked height in px. */
  totalHeight: number;
  /** True if text was truncated to fit (overflow / break-word height clip,
   *  or a single line wider than the box). */
  clipped: boolean;
}

/**
 * Measures the rendered width of `text` at a given font size and family.
 * Injected so layout stays pure and testable (the canvas-backed implementation
 * lives in `measureCache.ts`).
 */
export type Measurer = (text: string, fontPx: number, fontFamily: string) => number;

/** The line-height multiple used throughout the editor. */
export const LINE_HEIGHT_RATIO = 1.2;

/** Baseline defaults applied when a spec omits optional fields. */
export const DEFAULT_LABEL_SPEC: LabelSpec = {
  textField: 'label',
  overflow: 'overflow',
  placement: { kind: 'inside-centered' },
  insetRatio: { w: 0.85, h: 0.85 },
  fontFamily: 'sans-serif',
  defaultFontSize: 14,
  minFontSize: 6,
  align: 'center',
  verticalAlign: 'middle',
  singleLine: false,
  background: true,
};

/**
 * Merge a partial override over a base spec. A `placement` in the override
 * replaces the base placement wholesale (placements are discriminated unions,
 * not mergeable field-by-field).
 */
export function mergeLabelSpec(base: LabelSpec, override?: Partial<LabelSpec>): LabelSpec {
  if (!override) return base;
  return { ...base, ...override };
}
