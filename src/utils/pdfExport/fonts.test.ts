/**
 * PDF font registration (DSK-246): the document's family in jsPDF's four
 * styles, each from the right face, and the code font beside it.
 */
import { describe, expect, it, vi } from 'vitest';
import type { jsPDF } from 'jspdf';
import { CAVEAT, INTER, JETBRAINS_MONO, SOURCE_SERIF } from '../../fonts/catalogue';
import { pdfFontFor, registerPDFFonts } from './fonts';

function recordingDoc() {
  const addFont = vi.fn();
  const doc = { addFileToVFS: vi.fn(), addFont, setFont: vi.fn() } as unknown as jsPDF;
  return { doc, fonts: () => addFont.mock.calls.map(([file, name, style]) => `${name} ${style}: ${file}`) };
}

describe('registerPDFFonts', () => {
  it('registers the family’s four faces, then the code font, and names the family', async () => {
    const { doc, fonts } = recordingDoc();
    expect(await registerPDFFonts(doc, SOURCE_SERIF)).toBe('SourceSerif4');
    expect(fonts()).toEqual([
      'SourceSerif4 normal: SourceSerif4-Regular.ttf',
      'SourceSerif4 bold: SourceSerif4-Bold.ttf',
      'SourceSerif4 italic: SourceSerif4-It.ttf',
      'SourceSerif4 bolditalic: SourceSerif4-BoldIt.ttf',
      'JetBrainsMono normal: JetBrainsMono-Regular.ttf',
      'JetBrainsMono italic: JetBrainsMono-Regular.ttf',
    ]);
  });

  it('registers Inter by default, exactly as before the catalogue', async () => {
    const { doc, fonts } = recordingDoc();
    expect(await registerPDFFonts(doc)).toBe(INTER.pdfName);
    expect(fonts().slice(0, 4)).toEqual([
      'Inter normal: Inter-Regular.ttf',
      'Inter bold: Inter-Bold.ttf',
      'Inter italic: Inter-Italic.ttf',
      'Inter bolditalic: Inter-BoldItalic.ttf',
    ]);
  });

  it('draws a family without italics upright, at the right weight', async () => {
    const { doc, fonts } = recordingDoc();
    await registerPDFFonts(doc, CAVEAT);
    expect(fonts().slice(0, 4)).toEqual([
      'Caveat normal: Caveat-Regular.ttf',
      'Caveat bold: Caveat-Bold.ttf',
      'Caveat italic: Caveat-Regular.ttf',
      'Caveat bolditalic: Caveat-Bold.ttf',
    ]);
  });

  it('registers the code font once when it is the document’s font', async () => {
    const { doc, fonts } = recordingDoc();
    await registerPDFFonts(doc, JETBRAINS_MONO);
    expect(fonts()).toHaveLength(4);
  });
});

describe('pdfFontFor', () => {
  it('embeds the bundled font named, else the one for the generic family, else Inter', () => {
    expect(pdfFontFor(undefined)).toBe(INTER);
    expect(pdfFontFor(SOURCE_SERIF.css)).toBe(SOURCE_SERIF);
    expect(pdfFontFor("'Comic Sans MS', cursive")).toBe(CAVEAT);
    expect(pdfFontFor("'Courier New', monospace")).toBe(JETBRAINS_MONO);
    expect(pdfFontFor("'Atkinson Hyperlegible', sans-serif")).toBe(INTER);
  });
});
