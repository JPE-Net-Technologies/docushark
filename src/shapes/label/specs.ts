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
