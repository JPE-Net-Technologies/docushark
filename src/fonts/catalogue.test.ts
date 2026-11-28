/**
 * The font catalogue (DSK-246) names real files: each face's TTF (TrueType
 * outlines, which jsPDF can embed) and its WOFF2, a licence per family, and a
 * stored value that falls back to its generic family.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FONT_CATALOGUE } from './catalogue';
import { faceFiles, INTERFACE_INTER_WOFF2 } from './fontFiles';

/** A `?url` asset import is a path from the project root in tests. */
const onDisk = (url: string) => join(process.cwd(), url.replace(/^\//, '').replace(/\?.*$/, ''));

describe('the font catalogue', () => {
  it('has unique ids, families and PDF names', () => {
    for (const key of ['id', 'family', 'pdfName'] as const) {
      const values = FONT_CATALOGUE.map((font) => font[key]);
      expect(new Set(values).size, key).toBe(values.length);
    }
  });

  it('stores each font as its family, falling back to its generic family', () => {
    for (const font of FONT_CATALOGUE) {
      expect(font.css.split(',').pop()?.trim(), font.id).toBe(font.generic);
      expect(font.css.toLowerCase(), font.id).toContain(font.family.toLowerCase());
    }
  });

  it('ships every face as a TrueType TTF and a WOFF2, with a licence beside them', () => {
    for (const font of FONT_CATALOGUE) {
      expect(font.faces.length, font.id).toBeGreaterThan(0);
      for (const face of font.faces) {
        const files = faceFiles(face);
        const ttf = onDisk(files.ttf);
        const woff2 = onDisk(files.woff2);
        expect(existsSync(ttf), files.ttf).toBe(true);
        expect(existsSync(woff2), files.woff2).toBe(true);
        expect(ttf.endsWith(`/${face.file}`), face.file).toBe(true);
        // 00 01 00 00 is TrueType; `OTTO` (CFF outlines) can't be embedded by jsPDF.
        expect(readFileSync(ttf).subarray(0, 4).toString('hex'), face.file).toBe('00010000');
        expect(readFileSync(woff2).subarray(0, 4).toString('latin1'), files.woff2).toBe('wOF2');
      }
      const folder = readdirSync(dirname(onDisk(faceFiles(font.faces[0]!).ttf)));
      expect(folder.some((file) => /^(LICENSE|OFL)/i.test(file)), font.id).toBe(true);
    }
  });

  it('gives every document font all four faces the PDF draws text in', () => {
    for (const font of FONT_CATALOGUE.filter((entry) => entry.roles.includes('document'))) {
      const variants = font.faces.map((face) => `${face.weight} ${face.style}`).sort();
      expect(variants, font.id).toEqual(['400 italic', '400 normal', '700 italic', '700 normal']);
    }
  });

  it('ships the interface font', () => {
    expect(readFileSync(onDisk(INTERFACE_INTER_WOFF2)).subarray(0, 4).toString('latin1')).toBe('wOF2');
  });
});
