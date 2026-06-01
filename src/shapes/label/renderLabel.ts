/**
 * Canvas label renderer — the single replacement for the per-handler label
 * blocks that were duplicated across Rectangle/Ellipse/Library/Line and
 * Connector/Group/File.
 *
 * Two anchoring modes:
 *
 * - **Box-anchored** (default): the caller has transformed `ctx` so the shape
 *   *center* is at the origin; text is aligned within a `boxWidth × boxHeight`
 *   inset region (rectangles, ellipses, library shapes, line midpoints).
 * - **Point-anchored** (`input.anchor` present): the origin *is* the text
 *   anchor, drawn with the given `textAlign`/`textBaseline` (connector mid-path,
 *   group 9-grid). The background pill follows the anchor.
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
  /** Draw a subtle 1px border around the pill (the connector default pill). */
  backgroundBorder?: boolean | undefined;
  /** Draw the pill with rounded corners (groups). */
  backgroundRound?: boolean | undefined;
  /** Corner radius when `backgroundRound`. Default 4. */
  backgroundRadius?: number | undefined;
  /** Total horizontal pill padding (added to text width). Default 12. */
  backgroundPadX?: number | undefined;
  /** Total vertical pill padding (added to text height). Default 8. */
  backgroundPadY?: number | undefined;
  /**
   * Point-anchored mode. When set, the origin is the text anchor drawn with
   * these canvas alignment values (instead of box-edge alignment).
   */
  anchor?: { textAlign: CanvasTextAlign; textBaseline: CanvasTextBaseline } | undefined;
  /** Label offset from the anchor origin. */
  offsetX: number;
  offsetY: number;
  /** Async re-render hook for LaTeX. */
  requestRender?: (() => void) | undefined;
}

/** Default padding around the background pill, matching the historical values. */
const BG_PAD_X = 12;
const BG_PAD_Y = 8;
const BG_BORDER_COLOR = 'rgba(0, 0, 0, 0.2)';

/**
 * Compute the top-left corner of the background pill.
 * Box-anchored pills are centered; point-anchored pills follow the text
 * align/baseline so the pill hugs the drawn text.
 */
function pillCorner(
  anchor: { textAlign: CanvasTextAlign; textBaseline: CanvasTextBaseline } | undefined,
  w: number,
  h: number,
  padX: number,
  padY: number
): { x: number; y: number } {
  if (!anchor) {
    return { x: -w / 2, y: -h / 2 };
  }
  let x: number;
  switch (anchor.textAlign) {
    case 'left':
    case 'start':
      x = -padX / 2;
      break;
    case 'right':
    case 'end':
      x = -(w - padX / 2);
      break;
    default:
      x = -w / 2;
  }
  let y: number;
  switch (anchor.textBaseline) {
    case 'top':
    case 'hanging':
      y = -padY / 2;
      break;
    case 'bottom':
    case 'alphabetic':
    case 'ideographic':
      y = -(h - padY / 2);
      break;
    default:
      y = -h / 2;
  }
  return { x, y };
}

export function renderLabel(ctx: CanvasRenderingContext2D, input: LabelRenderInput): void {
  const { text, spec, boxWidth, boxHeight, fontSize, color, anchor } = input;
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

  // Background pill.
  if (spec.background && input.background) {
    const padX = input.backgroundPadX ?? BG_PAD_X;
    const padY = input.backgroundPadY ?? BG_PAD_Y;
    // Box-anchored pills clamp to the inset box; point-anchored pills don't.
    const bgWidth = anchor ? layout.totalWidth + padX : Math.min(layout.totalWidth + padX, maxWidth + padX);
    const bgHeight = anchor ? layout.totalHeight + padY : Math.min(layout.totalHeight + padY, maxHeight + padY);
    const { x: bgX, y: bgY } = pillCorner(anchor, bgWidth, bgHeight, padX, padY);

    ctx.fillStyle = input.background;
    if (input.backgroundRound) {
      ctx.beginPath();
      ctx.roundRect(bgX, bgY, bgWidth, bgHeight, input.backgroundRadius ?? 4);
      ctx.fill();
    } else {
      ctx.fillRect(bgX, bgY, bgWidth, bgHeight);
    }
    if (input.backgroundBorder) {
      ctx.strokeStyle = BG_BORDER_COLOR;
      ctx.lineWidth = 1;
      ctx.strokeRect(bgX, bgY, bgWidth, bgHeight);
    }
  }

  ctx.fillStyle = color;
  ctx.font = `${layout.fontSize}px ${fontFamily}`;
  const { lineHeight } = layout;

  if (anchor) {
    // Point-anchored: draw with the given canvas alignment. Multi-line stacks
    // are centered for a 'middle' baseline (connectors) and bottom-anchored for
    // a 'bottom' baseline, so wrapped text sits correctly within its pill.
    // Single-line labels are unaffected (startY = 0).
    ctx.textAlign = anchor.textAlign;
    ctx.textBaseline = anchor.textBaseline;
    const lineCount = layout.lines.length;
    let startY = 0;
    if (anchor.textBaseline === 'middle') {
      startY = -((lineCount - 1) * lineHeight) / 2;
    } else if (
      anchor.textBaseline === 'bottom' ||
      anchor.textBaseline === 'alphabetic' ||
      anchor.textBaseline === 'ideographic'
    ) {
      startY = -(lineCount - 1) * lineHeight;
    }
    layout.lines.forEach((line, i) => {
      ctx.fillText(line, 0, startY + i * lineHeight);
    });
    ctx.restore();
    return;
  }

  // Box-anchored: align within the inset box.
  ctx.textBaseline = 'middle';
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

  const vAlign = spec.verticalAlign ?? 'middle';
  const { totalHeight } = layout;
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
