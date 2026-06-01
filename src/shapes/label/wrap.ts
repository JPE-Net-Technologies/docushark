/**
 * Pure text-wrapping primitives for the label engine.
 *
 * All functions take an injected `Measurer` and never touch a canvas, so they
 * are deterministic and unit-testable. These are the canonical wrap algorithms;
 * `layoutLabel` composes them per overflow mode.
 */

import type { Measurer } from './LabelSpec';
import { LINE_HEIGHT_RATIO } from './LabelSpec';

/**
 * Word-boundary wrap. Mirrors the historical `textUtils.wrapText` behavior:
 * paragraphs split on `\n`; within a paragraph, words are packed greedily and a
 * word that alone exceeds `maxWidth` is left on its own line (overflowing width).
 */
export function wrapWord(
  text: string,
  maxWidth: number,
  fontPx: number,
  fontFamily: string,
  measure: Measurer
): string[] {
  const paragraphs = text.split('\n');
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }

    const words = paragraph.split(' ');
    let currentLine = '';

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      if (measure(testLine, fontPx, fontFamily) > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }

    if (currentLine) lines.push(currentLine);
  }

  return lines.length > 0 ? lines : [''];
}

/**
 * Word-boundary wrap that additionally breaks a single token mid-word when the
 * token is wider than `maxWidth`. Long unbroken strings (URLs, IDs) are split
 * character-by-character so they never overflow the box width.
 */
export function wrapBreakWord(
  text: string,
  maxWidth: number,
  fontPx: number,
  fontFamily: string,
  measure: Measurer
): string[] {
  const paragraphs = text.split('\n');
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }

    const words = paragraph.split(' ');
    let currentLine = '';

    const flush = () => {
      if (currentLine) {
        lines.push(currentLine);
        currentLine = '';
      }
    };

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;

      if (measure(testLine, fontPx, fontFamily) <= maxWidth) {
        currentLine = testLine;
        continue;
      }

      // Word doesn't fit on the current line.
      flush();

      // If the word itself fits on a fresh line, place it there.
      if (measure(word, fontPx, fontFamily) <= maxWidth) {
        currentLine = word;
        continue;
      }

      // Otherwise break the oversized token character by character.
      let chunk = '';
      for (const ch of word) {
        const testChunk = chunk + ch;
        if (chunk && measure(testChunk, fontPx, fontFamily) > maxWidth) {
          lines.push(chunk);
          chunk = ch;
        } else {
          chunk = testChunk;
        }
      }
      currentLine = chunk;
    }

    flush();
  }

  return lines.length > 0 ? lines : [''];
}

/**
 * Find the largest integer font size in `[minFontSize, maxFontSize]` at which
 * the word-wrapped text fits within `maxWidth` × `maxHeight`. Falls back to
 * `minFontSize` if nothing fits.
 *
 * "Fits" means: every wrapped line is ≤ `maxWidth` AND the stacked line count ×
 * lineHeight is ≤ `maxHeight`.
 */
export function squeezeToFit(
  text: string,
  maxWidth: number,
  maxHeight: number,
  maxFontSize: number,
  minFontSize: number,
  fontFamily: string,
  measure: Measurer
): { fontSize: number; lines: string[] } {
  const fits = (fontPx: number): string[] | null => {
    const lines = wrapWord(text, maxWidth, fontPx, fontFamily, measure);
    const totalHeight = lines.length * fontPx * LINE_HEIGHT_RATIO;
    if (totalHeight > maxHeight) return null;
    for (const line of lines) {
      if (measure(line, fontPx, fontFamily) > maxWidth) return null;
    }
    return lines;
  };

  let lo = Math.max(1, Math.floor(minFontSize));
  let hi = Math.max(lo, Math.floor(maxFontSize));

  // Largest size that fits, via binary search on integer sizes.
  let bestSize = lo;
  let bestLines = wrapWord(text, maxWidth, lo, fontFamily, measure);

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const lines = fits(mid);
    if (lines) {
      bestSize = mid;
      bestLines = lines;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return { fontSize: bestSize, lines: bestLines };
}
