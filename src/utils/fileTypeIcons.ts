/**
 * File-type icons — the lucide glyphs shown for embedded file shapes, in both
 * the React surfaces (file viewer, property panel) and on the canvas.
 *
 * The canvas can't render a React lucide component, so each category also has a
 * raw lucide SVG string here (24x24, `currentColor`, matching the built-in icon
 * format) that `FileShape` rasterises via `iconCache.drawRawSvgIcon`. The React
 * side uses the lucide-react components directly. Keep the two in sync.
 */
import { File, FileText, FileType, Image as ImageIcon, Sheet, type LucideIcon } from 'lucide-react';
import { drawRawSvgIcon } from './iconCache';
import type { FileCategory } from './fileUtils';

const SVG_ATTRS =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

/** A bare file outline, shared by the document-ish glyphs. */
const FILE_BODY = '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>';

/** Raw lucide SVG markup per file category (mirrors the React components below). */
const FILE_TYPE_SVG: Record<FileCategory, string> = {
  // FileText
  pdf: `<svg ${SVG_ATTRS}>${FILE_BODY}<path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>`,
  // Sheet
  spreadsheet: `<svg ${SVG_ATTRS}><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/></svg>`,
  // Image
  image: `<svg ${SVG_ATTRS}><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>`,
  // FileType
  text: `<svg ${SVG_ATTRS}>${FILE_BODY}<path d="M9 13v-1h6v1"/><path d="M11 18h2"/><path d="M12 12v6"/></svg>`,
  // File
  generic: `<svg ${SVG_ATTRS}>${FILE_BODY}</svg>`,
};

/** TriangleAlert — the missing-blob overlay glyph. */
const WARNING_SVG = `<svg ${SVG_ATTRS}><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`;

/** The lucide-react component per file category (for React surfaces). */
const FILE_TYPE_COMPONENT: Record<FileCategory, LucideIcon> = {
  pdf: FileText,
  spreadsheet: Sheet,
  image: ImageIcon,
  text: FileType,
  generic: File,
};

/** Get the lucide-react icon component for a file category. */
export function getFileTypeLucideIcon(category: FileCategory): LucideIcon {
  return FILE_TYPE_COMPONENT[category];
}

/**
 * Draw a file-type glyph on the canvas (top-left origin), rasterised + cached.
 * Returns false until the icon image has loaded (a redraw is scheduled via the
 * shared `onIconLoad` hook).
 */
export function drawFileTypeIcon(
  ctx: CanvasRenderingContext2D,
  category: FileCategory,
  x: number,
  y: number,
  size: number,
  color: string
): boolean {
  return drawRawSvgIcon(ctx, `file-type:${category}`, FILE_TYPE_SVG[category], x, y, size, color);
}

/** Draw the missing-blob warning glyph on the canvas (top-left origin). */
export function drawWarningIcon(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string
): boolean {
  return drawRawSvgIcon(ctx, 'file-type:warning', WARNING_SVG, x, y, size, color);
}
