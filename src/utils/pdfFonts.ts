/**
 * PDF Font Registration for jsPDF.
 *
 * Embeds Inter (4 weights) and JetBrains Mono (Regular) as custom fonts,
 * replacing jsPDF's built-in helvetica/courier which only support
 * WinAnsiEncoding and cause þÿ artifacts with Unicode text.
 *
 * Fonts are lazy-loaded (dynamic import) — only fetched when PDF export runs.
 *
 * @see https://github.com/parallax/jsPDF/issues/2677
 */

import type { jsPDF } from 'jspdf';

/** Font family name used in setFont() calls */
export const PDF_FONT_SANS = 'Inter';
/** Monospace font family name used for code blocks */
export const PDF_FONT_MONO = 'JetBrainsMono';

/**
 * Register custom Unicode-capable fonts with a jsPDF document instance.
 * Must be called once after `new jsPDF(...)` and before any text rendering.
 *
 * Uses dynamic imports so the ~2MB of base64 font data is only loaded
 * when PDF export is actually triggered.
 */
export async function registerPDFFonts(doc: jsPDF): Promise<void> {
  const [
    { Inter_Regular },
    { Inter_Bold },
    { Inter_Italic },
    { Inter_BoldItalic },
    { JetBrainsMono_Regular },
  ] = await Promise.all([
    import('./fonts/Inter_Regular'),
    import('./fonts/Inter_Bold'),
    import('./fonts/Inter_Italic'),
    import('./fonts/Inter_BoldItalic'),
    import('./fonts/JetBrainsMono_Regular'),
  ]);

  // Inter — sans-serif (4 styles)
  doc.addFileToVFS('Inter-Regular.ttf', Inter_Regular);
  doc.addFont('Inter-Regular.ttf', 'Inter', 'normal');

  doc.addFileToVFS('Inter-Bold.ttf', Inter_Bold);
  doc.addFont('Inter-Bold.ttf', 'Inter', 'bold');

  doc.addFileToVFS('Inter-Italic.ttf', Inter_Italic);
  doc.addFont('Inter-Italic.ttf', 'Inter', 'italic');

  doc.addFileToVFS('Inter-BoldItalic.ttf', Inter_BoldItalic);
  doc.addFont('Inter-BoldItalic.ttf', 'Inter', 'bolditalic');

  // JetBrains Mono — monospace (regular only; bold/italic fall back to regular)
  doc.addFileToVFS('JetBrainsMono-Regular.ttf', JetBrainsMono_Regular);
  doc.addFont('JetBrainsMono-Regular.ttf', 'JetBrainsMono', 'normal');
  doc.addFont('JetBrainsMono-Regular.ttf', 'JetBrainsMono', 'italic');

  // Set Inter as the default font
  doc.setFont('Inter', 'normal');
}
