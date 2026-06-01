/**
 * Canvas label renderer — the single replacement for the per-handler label
 * blocks that were duplicated across Rectangle/Ellipse/Library (and, in later
 * phases, Connector/Group/File).
 *
 * Contract: the caller has already transformed `ctx` so the label's anchor
 * origin is at `(0, 0)` (e.g. shape center for `inside-centered`, the mid-path
 * point for `along-path`, the 9-grid anchor for groups). This function applies
 * the label offset, lays out the text via the pure `layoutLabel`, optionally
 * paints a background pill, and draws the lines with the spec's alignment.
 *
 * LaTeX labels (text starting with `=`) are delegated to the existing
 * `renderLatexText` path unchanged.
 */

import { isLatexText, renderLatexText } from '../../utils/textUtils';
import { getMeasurer } from './measureCache';
import { layoutLabel } from './layoutLabel';
import type { LabelSpec, LabelOverflow } from './LabelSpec';

export interface LabelRenderInput {
  /** The label text. */
  text: string;
  /** Declarative label behavior. */
  spec: LabelSpec;
  /** Per-instance overflow override (shape's `labelOverflow`); falls back to the spec. */
  overflow?: LabelOverflow | undefined;
  /** Shape box width in world units (before inset). */
  boxWidth: number;
  /** Shape box height in world units (before inset). */
  boxHeight: number;
  /** Resolved font size (shape's `labelFontSize` or the spec default). */
  fontSize: number;
  /** Resolved text color (AUTO already resolved by the caller). */
  color: string;
  /** Optional background pill color. */
  background?: string | undefined;
  /** Label offset from the anchor origin. */
  offsetX: number;
  offsetY: number;
  /** Async re-render hook for LaTeX. */
  requestRender?: (() => void) | undefined;
}

/** Padding around the background pill, matching the historical values. */
const BG_PAD_X = 12;
const BG_PAD_Y = 8;

export function renderLabel(ctx: CanvasRenderingContext2D, input: LabelRenderInput): void {
  const { text, spec, boxWidth, boxHeight, fontSize, color } = input;
  if (!text) return;

  const insetW = spec.insetRatio?.w ?? 1;
  const insetH = spec.insetRatio?.h ?? 1;
  const maxWidth = boxWidth * insetW;
  const maxHeight = boxHeight * insetH;
  const fontFamily = spec.fontFamily ?? 'sans-serif';

  ctx.save();
  ctx.translate(input.offsetX, input.offsetY);

  // LaTeX: preserve the existing image-based rendering path.
  if (isLatexText(text)) {
    renderLatexText(ctx, text, maxWidth, maxHeight, fontSize, fontFamily, color, input.requestRender);
    ctx.restore();
    return;
  }

  const layout = layoutLabel(
    {
      text,
      overflow: input.overflow ?? spec.overflow,
      maxWidth,
      maxHeight,
      fontSize,
      fontFamily,
      minFontSize: spec.minFontSize ?? 6,
      singleLine: spec.singleLine ?? false,
    },
    getMeasurer(ctx)
  );

  // Background pill (sized to the laid-out text, clamped to the box).
  if (spec.background && input.background) {
    const bgWidth = Math.min(layout.totalWidth + BG_PAD_X, maxWidth + BG_PAD_X);
    const bgHeight = Math.min(layout.totalHeight + BG_PAD_Y, maxHeight + BG_PAD_Y);
    ctx.fillStyle = input.background;
    ctx.fillRect(-bgWidth / 2, -bgHeight / 2, bgWidth, bgHeight);
  }

  ctx.fillStyle = color;
  ctx.font = `${layout.fontSize}px ${fontFamily}`;
  ctx.textBaseline = 'middle';

  // Horizontal anchor from align.
  const align = spec.align ?? 'center';
  let anchorX = 0;
  if (align === 'left') {
    anchorX = -maxWidth / 2;
    ctx.textAlign = 'left';
  } else if (align === 'right') {
    anchorX = maxWidth / 2;
    ctx.textAlign = 'right';
  } else {
    anchorX = 0;
    ctx.textAlign = 'center';
  }

  // Vertical anchor from verticalAlign (default middle = historical behavior).
  const vAlign = spec.verticalAlign ?? 'middle';
  const { lineHeight, totalHeight } = layout;
  let startY: number;
  if (vAlign === 'top') {
    startY = -maxHeight / 2 + lineHeight / 2;
  } else if (vAlign === 'bottom') {
    startY = maxHeight / 2 - totalHeight + lineHeight / 2;
  } else {
    startY = -totalHeight / 2 + lineHeight / 2;
  }

  layout.lines.forEach((line, i) => {
    ctx.fillText(line, anchorX, startY + i * lineHeight);
  });

  ctx.restore();
}
