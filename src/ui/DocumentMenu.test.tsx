/**
 * The ribbon's Document menu: "Aa" previews the document's font, names it for
 * screen readers, and sets the font for the whole document (DSK-246).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { DocumentMenu } from './DocumentMenu';
import { JETBRAINS_MONO, SOURCE_SERIF } from '../fonts/catalogue';
import { documentFont } from '../fonts/documentFont';
import { useDocumentSettingsStore } from '../store/documentSettingsStore';

const trigger = () => screen.getByRole('button', { name: /^Document settings/ });
const open = () => fireEvent.keyDown(trigger(), { key: 'Enter' });
/** The radio items of one of the menu's sections: 0 fonts, 1 page size, 2 orientation, 3 margins. */
const section = (index: number) => within(screen.getAllByRole('group')[index]!).getAllByRole('menuitemradio');

beforeEach(() => {
  useDocumentSettingsStore.setState({ settings: {}, documentId: 'doc' });
});

afterEach(cleanup);

describe('the Document menu', () => {
  it('names the document font and draws "Aa" in it', () => {
    useDocumentSettingsStore.setState({ settings: { font: SOURCE_SERIF.css }, documentId: 'doc' });
    render(<DocumentMenu />);
    expect(trigger().getAttribute('aria-label')).toBe('Document settings (font: Source Serif 4)');
    const aa = trigger().querySelector<HTMLElement>('.document-menu-aa')!;
    expect(aa.textContent).toBe('Aa');
    expect(aa.style.fontFamily).toContain('Source Serif 4');
  });

  it('opens on a heading that says the font is the whole document’s, with the current one checked', () => {
    render(<DocumentMenu />);
    open();
    expect(screen.getByText('Font for the whole document')).toBeTruthy();
    const fonts = section(0);
    expect(fonts.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Inter'),
      expect.stringContaining('Source Serif 4'),
      expect.stringContaining('JetBrains Mono'),
    ]);
    expect(fonts.map((item) => item.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
  });

  it('sets the font for the whole document', () => {
    render(<DocumentMenu />);
    open();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /JetBrains Mono/ }));
    expect(documentFont()).toBe(JETBRAINS_MONO.css);
    expect(trigger().getAttribute('aria-label')).toBe('Document settings (font: JetBrains Mono)');
  });

  it('lists a font this build doesn’t bundle as it is, and keeps it', () => {
    useDocumentSettingsStore.setState({ settings: { font: "'Comic Sans MS', cursive" }, documentId: 'doc' });
    render(<DocumentMenu />);
    open();
    const fonts = section(0);
    expect(fonts).toHaveLength(4);
    expect(fonts[3]!.textContent).toContain('Not bundled');
    expect(fonts[3]!.getAttribute('aria-checked')).toBe('true');
  });

  describe('the page setup (DSK-48)', () => {
    const checked = (items: HTMLElement[]) => items.filter((item) => item.getAttribute('aria-checked') === 'true').map((item) => item.textContent);
    const stored = () => useDocumentSettingsStore.getState().settings['page'] as Record<string, unknown> | undefined;

    it('shows the page size, orientation and margins, the locale’s paper checked for a new document', () => {
      // jsdom's locale is en-US: Letter.
      render(<DocumentMenu />);
      open();
      for (const heading of ['Page size', 'Orientation', 'Margins']) expect(screen.getByText(heading)).toBeTruthy();
      expect(checked(section(1))).toEqual([expect.stringContaining('Letter')]);
      expect(checked(section(2))).toEqual(['Portrait']);
      expect(checked(section(3))).toEqual([expect.stringContaining('Normal')]);
    });

    it('saves a new size and margins with the document', () => {
      render(<DocumentMenu />);
      open();
      fireEvent.click(screen.getByRole('menuitemradio', { name: /^A4/ }));
      expect(stored()).toEqual({ size: 'a4', orientation: 'portrait', margins: { top: 20, right: 20, bottom: 20, left: 20 } });
      open(); // a choice closes the menu, as the font's does
      fireEvent.click(screen.getByRole('menuitemradio', { name: /^Narrow/ }));
      expect(stored()?.['margins']).toEqual({ top: 12.7, right: 12.7, bottom: 12.7, left: 12.7 });
      expect(stored()?.['size']).toBe('a4');
    });

    it('shows margins set in the export dialog as custom', () => {
      useDocumentSettingsStore.setState({
        settings: { page: { size: 'a4', orientation: 'landscape', margins: { top: 15, right: 20, bottom: 15, left: 20 } } },
        documentId: 'doc',
      });
      render(<DocumentMenu />);
      open();
      expect(checked(section(1))).toEqual([expect.stringContaining('A4')]);
      expect(checked(section(2))).toEqual(['Landscape']);
      expect(checked(section(3))).toEqual([expect.stringContaining('Custom')]);
    });
  });
});
