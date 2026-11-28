/**
 * The ribbon's Document menu: "Aa" previews the document's font, names it for
 * screen readers, and sets the font for the whole document (DSK-246).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DocumentMenu } from './DocumentMenu';
import { JETBRAINS_MONO, SOURCE_SERIF } from '../fonts/catalogue';
import { documentFont } from '../fonts/documentFont';
import { useDocumentSettingsStore } from '../store/documentSettingsStore';

const trigger = () => screen.getByRole('button', { name: /^Document settings/ });
const open = () => fireEvent.keyDown(trigger(), { key: 'Enter' });

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
    const fonts = screen.getAllByRole('menuitemradio');
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
    const fonts = screen.getAllByRole('menuitemradio');
    expect(fonts).toHaveLength(4);
    expect(fonts[3]!.textContent).toContain('Not bundled');
    expect(fonts[3]!.getAttribute('aria-checked')).toBe('true');
  });
});
