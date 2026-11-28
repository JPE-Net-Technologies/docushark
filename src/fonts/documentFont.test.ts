/**
 * The document font and canvas fonts (DSK-246): the document's `settings.font`,
 * what shapes draw with, and what an export waits for.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDocumentSettingsStore } from '../store/documentSettingsStore';
import { CAVEAT, DEFAULT_DOCUMENT_FONT, JETBRAINS_MONO, SOURCE_SERIF } from './catalogue';
import { canvasFont, fontsOf } from './canvasFont';
import { DOCUMENT_FONT_SETTING, documentFont, onDocumentFontChange, setDocumentFont } from './documentFont';
import { currentDocumentFont } from './currentDocumentFont';

beforeEach(() => {
  useDocumentSettingsStore.setState({ settings: {}, documentId: 'doc' });
});

describe('the document font', () => {
  it('is the default until the document chooses one', () => {
    expect(documentFont()).toBe(DEFAULT_DOCUMENT_FONT.css);
    setDocumentFont(SOURCE_SERIF.css);
    expect(useDocumentSettingsStore.getState().settings[DOCUMENT_FONT_SETTING]).toBe(SOURCE_SERIF.css);
    expect(documentFont()).toBe(SOURCE_SERIF.css);
  });

  it('keeps the canvas’s copy in step, which shape renderers read without the store', () => {
    setDocumentFont(SOURCE_SERIF.css);
    expect(currentDocumentFont()).toBe(SOURCE_SERIF.css);
    useDocumentSettingsStore.getState().load({}, 'other');
    expect(currentDocumentFont()).toBe(DEFAULT_DOCUMENT_FONT.css);
  });

  it('follows a document switch', () => {
    setDocumentFont(SOURCE_SERIF.css);
    useDocumentSettingsStore.getState().load({}, 'other');
    expect(documentFont()).toBe(DEFAULT_DOCUMENT_FONT.css);
  });

  it('reports a change once, and not a change to another setting', () => {
    const listener = vi.fn();
    const unsubscribe = onDocumentFontChange(listener);
    setDocumentFont(SOURCE_SERIF.css);
    useDocumentSettingsStore.getState().set('pageSize', 'a4');
    setDocumentFont(SOURCE_SERIF.css);
    unsubscribe();
    expect(listener.mock.calls).toEqual([[SOURCE_SERIF.css]]);
  });
});

describe('canvas fonts', () => {
  it('draw shapes in the document font unless they have their own', () => {
    setDocumentFont(SOURCE_SERIF.css);
    expect(canvasFont(undefined)).toBe(SOURCE_SERIF.css);
    expect(canvasFont('sans-serif')).toBe(SOURCE_SERIF.css);
    expect(canvasFont('Caveat, cursive')).toBe(CAVEAT.css);
    setDocumentFont(JETBRAINS_MONO.css);
    expect(canvasFont('sans-serif')).toBe(JETBRAINS_MONO.css);
  });

  it('lists every font a set of shapes draws in, for an export to wait on', () => {
    setDocumentFont(SOURCE_SERIF.css);
    const fonts = fontsOf([
      { type: 'text', fontFamily: 'sans-serif' },
      { type: 'rectangle', labelFontFamily: 'Caveat, cursive' },
      { type: 'rectangle' },
    ]);
    expect(fonts.sort()).toEqual([CAVEAT.css, SOURCE_SERIF.css].sort());
  });
});
