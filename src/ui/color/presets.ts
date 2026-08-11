/**
 * Swatch vocabularies for the shared color picker.
 *
 * Each surface leads with the swatches its work actually calls for — table
 * cells want header greys far more often than saturated fills — but every
 * surface ends with the same full palette, and every surface offers the same
 * hex field. The vocabulary differs; the currency does not.
 */

/**
 * One labelled block of swatches inside the picker.
 *
 * `rows` is a list of rendered lines rather than a flat array so a ramp keeps
 * its shape (one hue family per line) instead of reflowing arbitrarily.
 */
export interface SwatchGroup {
  /** Section heading. Always rendered — the picker has no unlabelled rows. */
  label: string;
  /** Swatch rows; each inner array renders as one line. */
  rows: string[][];
}

/**
 * Tailwind-inspired color ramps — 10 hue families x 5 shades, lightest to
 * darkest. The shared baseline every surface falls back to.
 */
export const PALETTE_GROUP: SwatchGroup = {
  label: 'Palette',
  rows: [
    ['#f1f5f9', '#cbd5e1', '#64748b', '#334155', '#0f172a'], // Slate
    ['#fee2e2', '#fca5a5', '#ef4444', '#b91c1c', '#7f1d1d'], // Red
    ['#ffedd5', '#fdba74', '#f97316', '#c2410c', '#7c2d12'], // Orange
    ['#fef3c7', '#fcd34d', '#f59e0b', '#b45309', '#78350f'], // Amber
    ['#d1fae5', '#6ee7b7', '#10b981', '#047857', '#064e3b'], // Emerald
    ['#ccfbf1', '#5eead4', '#14b8a6', '#0f766e', '#134e4a'], // Teal
    ['#dbeafe', '#93c5fd', '#3b82f6', '#1d4ed8', '#1e3a5f'], // Blue
    ['#e0e7ff', '#a5b4fc', '#6366f1', '#4338ca', '#312e81'], // Indigo
    ['#ede9fe', '#c4b5fd', '#8b5cf6', '#6d28d9', '#4c1d95'], // Violet
    ['#fce7f3', '#f9a8d4', '#ec4899', '#be185d', '#831843'], // Pink
  ],
};

/**
 * Document neutrals — the header greys and pale hue tints that table styling
 * actually reaches for. Cell backgrounds previously offered the highlighter
 * palette and no greys at all, which made a subtle header row impossible.
 */
export const NEUTRALS_GROUP: SwatchGroup = {
  label: 'Neutrals',
  rows: [
    ['#ffffff', '#f8fafc', '#f1f5f9', '#e2e8f0', '#cbd5e1', '#94a3b8', '#64748b', '#475569', '#1e293b', '#0f172a'],
    ['#fef2f2', '#fff7ed', '#fefce8', '#f0fdf4', '#ecfeff', '#eff6ff', '#eef2ff', '#faf5ff', '#fdf2f8', '#f5f5f4'],
  ],
};

/**
 * Highlight tints — pale enough that body text stays legible on top of them,
 * which the saturated primaries in the old highlight palette were not.
 */
export const HIGHLIGHT_GROUP: SwatchGroup = {
  label: 'Tints',
  rows: [
    ['#fef08a', '#bbf7d0', '#a5f3fc', '#bfdbfe', '#ddd6fe', '#fbcfe8'],
    ['#fed7aa', '#fecaca', '#d9f99d', '#99f6e4', '#e9d5ff', '#e7e5e4'],
  ],
};

/**
 * Which vocabulary a surface leads with.
 *
 * - `canvas` — shape fill, stroke, shadow, text
 * - `document` — table cell backgrounds; neutrals first
 * - `highlight` — text highlight; legible tints first
 */
export type ColorPresetName = 'canvas' | 'document' | 'highlight';

/** Swatch groups per surface, in render order. */
export const COLOR_PRESETS: Record<ColorPresetName, SwatchGroup[]> = {
  canvas: [PALETTE_GROUP],
  document: [NEUTRALS_GROUP, PALETTE_GROUP],
  highlight: [HIGHLIGHT_GROUP, PALETTE_GROUP],
};
