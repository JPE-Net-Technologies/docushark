/**
 * Per-shape-type default `LabelSpec`s.
 *
 * These reproduce each shape's historical label behavior by default
 * (overflow = word-wrap + clip, centered). A shape's runtime `labelOverflow`
 * field (added in a later phase) overrides `spec.overflow` per instance.
 */

import { DEFAULT_LABEL_SPEC, mergeLabelSpec, type LabelSpec } from './LabelSpec';

/** Rectangle / generic boxed shapes: 85% inset, centered, word-wrap + clip. */
export const RECT_LABEL_SPEC: LabelSpec = mergeLabelSpec(DEFAULT_LABEL_SPEC, {
  insetRatio: { w: 0.85, h: 0.85 },
});

/** Ellipse: tighter 70% inset (less usable interior than a box). */
export const ELLIPSE_LABEL_SPEC: LabelSpec = mergeLabelSpec(DEFAULT_LABEL_SPEC, {
  insetRatio: { w: 0.7, h: 0.7 },
});

/** Library shapes: same as rectangle (the factory's historical behavior). */
export const LIBRARY_LABEL_SPEC: LabelSpec = mergeLabelSpec(DEFAULT_LABEL_SPEC, {
  insetRatio: { w: 0.85, h: 0.85 },
});

/** Line: a single-line label centered at the midpoint. */
export const LINE_LABEL_SPEC: LabelSpec = mergeLabelSpec(DEFAULT_LABEL_SPEC, {
  placement: { kind: 'along-path', t: 0.5 },
  singleLine: true,
  defaultFontSize: 12,
  insetRatio: { w: 1, h: 1 },
});

/** Connector: single-line label at the mid-path point, with a readability pill. */
export const CONNECTOR_LABEL_SPEC: LabelSpec = mergeLabelSpec(DEFAULT_LABEL_SPEC, {
  placement: { kind: 'along-path', t: 0.5 },
  // Wrap within a bounded width (set by the caller) instead of stretching the
  // pill indefinitely; short labels still render on one line.
  singleLine: false,
  defaultFontSize: 12,
  background: true,
  insetRatio: { w: 1, h: 1 },
});

/** Max width (world units) a connector label wraps within before going multi-line. */
export const CONNECTOR_LABEL_MAX_WIDTH = 200;

/** Group: single-line label anchored at the 9-grid position around the bounds. */
export const GROUP_LABEL_SPEC: LabelSpec = mergeLabelSpec(DEFAULT_LABEL_SPEC, {
  placement: { kind: 'nine-grid', position: 'top' },
  singleLine: true,
  defaultFontSize: 14,
  background: true,
  insetRatio: { w: 1, h: 1 },
});
