/**
 * Style constants for PDF export: sizes, spacing and colours. Renderers read
 * them from here rather than hardcoding values.
 */



/**
 * Centralized style config for PDF rendering.
 * All hardcoded constants live here; renderers read from this object.
 */
export const PDF_STYLE = {
  /** Font sizes for heading levels (in points) */
  headingSizes: { 1: 24, 2: 20, 3: 18, 4: 16, 5: 14, 6: 12 } as Record<number, number>,
  /** Top spacing before headings (mm), per level */
  headingTopSpacing: { 1: 8, 2: 6, 3: 5, 4: 4, 5: 3, 6: 2.5 } as Record<number, number>,
  /** Bottom spacing after headings (mm) */
  headingBottomSpacing: 1.5,
  /** Internal vertical padding inside blockquote panels (mm) */
  blockquoteVerticalPadding: 3,
  /** Default body text size (pt) */
  bodyFontSize: 12,
  /** Line height multiplier */
  lineHeight: 1.4,
  /** List indentation per level (mm) */
  listIndent: 8,
  /** Code block padding (mm) */
  codeBlockPadding: 3,
  /** Code block background color */
  codeBlockBg: '#f5f5f5',
  /** Footer height for page numbers (mm) */
  pageNumberFooterHeight: 10,
  /** Table cell padding (mm) */
  tableCellPadding: 2,
  /** Table header background */
  tableHeaderBg: '#f0f0f0',
  /** Table border color */
  tableBorderColor: '#cccccc',
  /** Block equation display font size (px, for KaTeX container) */
  mathBlockFontSize: '14px',
  /** Inline equation font size (px) */
  mathInlineFontSize: '12px',
  /** Max height for block equations (mm) */
  mathBlockMaxHeight: 30,
  /** Max height for inline equations (mm) */
  mathInlineMaxHeight: 12,
} as const;
