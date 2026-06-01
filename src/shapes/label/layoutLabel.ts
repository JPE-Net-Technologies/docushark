/**
 * Label layout — turns a label-text + box + overflow mode into a concrete
 * `LabelLayout` (wrapped lines, final font size, dimensions, clip flag).
 *
 * Pure: takes an injected `Measurer`. The renderer (`renderLabel`) builds a
 * `LayoutRequest` from a shape + its `LabelSpec`, calls this, then paints.
 */

import type { LabelLayout, LabelOverflow, Measurer } from './LabelSpec';
import { LINE_HEIGHT_RATIO } from './LabelSpec';
import { wrapWord, wrapBreakWord, squeezeToFit } from './wrap';

export interface LayoutRequest {
  text: string;
  overflow: LabelOverflow;
  maxWidth: number;
  maxHeight: number;
  fontSize: number;
  fontFamily: string;
  /** Lower bound for `squeeze-into`. */
  minFontSize: number;
  /** Force a single line (no wrap); newlines collapse to spaces. */
  singleLine?: boolean;
}

function measureMaxLineWidth(
  lines: string[],
  fontPx: number,
  fontFamily: string,
  measure: Measurer
): number {
  let max = 0;
  for (const line of lines) {
    const w = measure(line, fontPx, fontFamily);
    if (w > max) max = w;
  }
  return max;
}

/**
 * Lay out a label according to its overflow mode.
 */
export function layoutLabel(req: LayoutRequest, measure: Measurer): LabelLayout {
  const { text, maxWidth, maxHeight, fontFamily } = req;

  // Single-line shapes (connector/group defaults): one line, no wrap.
  if (req.singleLine) {
    const line = text.replace(/\n/g, ' ');
    const fontSize = req.fontSize;
    const lineHeight = fontSize * LINE_HEIGHT_RATIO;
    const width = measure(line, fontSize, fontFamily);
    return {
      lines: [line],
      fontSize,
      lineHeight,
      totalWidth: width,
      totalHeight: lineHeight,
      clipped: width > maxWidth,
    };
  }

  if (req.overflow === 'squeeze-into') {
    const { fontSize, lines } = squeezeToFit(
      text,
      maxWidth,
      maxHeight,
      req.fontSize,
      req.minFontSize,
      fontFamily,
      measure
    );
    const lineHeight = fontSize * LINE_HEIGHT_RATIO;
    const maxLines = Math.max(1, Math.floor(maxHeight / lineHeight));
    const clipped = lines.length > maxLines;
    const visible = clipped ? lines.slice(0, maxLines) : lines;
    return {
      lines: visible,
      fontSize,
      lineHeight,
      totalWidth: measureMaxLineWidth(visible, fontSize, fontFamily, measure),
      totalHeight: visible.length * lineHeight,
      clipped,
    };
  }

  // 'overflow' and 'break-word' share the height-clip tail; they differ only in
  // how a too-wide token is handled.
  const fontSize = req.fontSize;
  const lineHeight = fontSize * LINE_HEIGHT_RATIO;
  const allLines =
    req.overflow === 'break-word'
      ? wrapBreakWord(text, maxWidth, fontSize, fontFamily, measure)
      : wrapWord(text, maxWidth, fontSize, fontFamily, measure);

  const maxLines = Math.max(1, Math.floor(maxHeight / lineHeight));
  const clipped = allLines.length > maxLines;
  const visible = clipped ? allLines.slice(0, maxLines) : allLines;

  return {
    lines: visible,
    fontSize,
    lineHeight,
    totalWidth: measureMaxLineWidth(visible, fontSize, fontFamily, measure),
    totalHeight: visible.length * lineHeight,
    clipped,
  };
}
