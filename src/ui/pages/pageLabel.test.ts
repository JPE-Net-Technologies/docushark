/**
 * Page labels (DSK-260): a chosen name, else the first heading, else
 * "Page N" / "Diagram N". Display only.
 */
import { describe, expect, it, vi } from 'vitest';
import { defaultPageNumber, firstHeadingInHtml, hasDefaultName, pageLabel } from './pageLabel';

describe('defaultPageNumber', () => {
  it('reads the number from a default name, of either scheme', () => {
    expect(defaultPageNumber('Prose', 'prose')).toBe(1);
    expect(defaultPageNumber('Prose p.3', 'prose')).toBe(3);
    expect(defaultPageNumber('Canvas', 'canvas')).toBe(1);
    expect(defaultPageNumber('Canvas p.12', 'canvas')).toBe(12);
    expect(defaultPageNumber('Page 4', 'prose')).toBe(4);
    expect(defaultPageNumber('Page 4', 'canvas')).toBe(4);
  });

  it('is null for a name someone chose', () => {
    expect(defaultPageNumber('Overview', 'prose')).toBeNull();
    expect(defaultPageNumber('Canvas p.2 (Copy)', 'canvas')).toBeNull();
    expect(defaultPageNumber('Prose p.two', 'prose')).toBeNull();
    // The other kind's base is a chosen name here.
    expect(defaultPageNumber('Canvas', 'prose')).toBeNull();
    expect(defaultPageNumber('Page 2 notes', 'prose')).toBeNull();
  });
});

describe('pageLabel', () => {
  it('keeps a chosen name, whatever the page says', () => {
    expect(pageLabel('prose', 'Requirements', 'Goals')).toBe('Requirements');
  });

  it('names a default-named page from its first heading', () => {
    expect(pageLabel('prose', 'Prose p.2', 'Sync protocol')).toBe('Sync protocol');
    expect(pageLabel('prose', 'Prose', '  Overview\n')).toBe('Overview');
  });

  it('says "Page N" or "Diagram N" while there is no heading', () => {
    expect(pageLabel('prose', 'Prose p.2', null)).toBe('Page 2');
    expect(pageLabel('prose', 'Prose')).toBe('Page 1');
    expect(pageLabel('canvas', 'Canvas p.3')).toBe('Diagram 3');
    expect(pageLabel('canvas', 'Page 2')).toBe('Diagram 2');
  });

  it('treats a blank name as a default one', () => {
    expect(hasDefaultName('  ', 'prose')).toBe(true);
    expect(pageLabel('prose', '', 'Intro')).toBe('Intro');
    expect(pageLabel('canvas', '')).toBe('Diagram');
  });

  it('names a copy of a default-named page as a copy of its label', () => {
    expect(pageLabel('canvas', 'Canvas p.2 (Copy)')).toBe('Diagram 2 (Copy)');
    expect(pageLabel('canvas', 'Canvas p.2 (Copy) (Copy)')).toBe('Diagram 2 (Copy) (Copy)');
    expect(pageLabel('prose', 'Prose p.3 (Copy)', 'Overview')).toBe('Overview (Copy)');
    // A chosen name's copy keeps the stored name.
    expect(pageLabel('canvas', 'Flow (Copy)')).toBe('Flow (Copy)');
    expect(pageLabel('canvas', 'Flow (Copy) (Copy)')).toBe('Flow (Copy) (Copy)');
  });

  it('clips a long heading as document names are clipped', () => {
    const long = 'A heading that runs on well past the length a tab could ever show in full';
    expect(pageLabel('prose', 'Prose p.4', long).endsWith('…')).toBe(true);
  });
});

describe('firstHeadingInHtml', () => {
  it('finds the first heading, at any level', () => {
    expect(firstHeadingInHtml('<p>intro</p><h2>Data <em>model</em></h2><h1>Later</h1>')).toBe('Data model');
  });

  it('parses only the heading, however long the page (DSK-260)', () => {
    const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
    const body = '<p>' + 'word '.repeat(20_000) + '</p>';
    expect(firstHeadingInHtml(`<p>intro</p><H2 id="a">Sync &amp; <em>merge</em></H2>${body}<h1>Later</h1>`)).toBe(
      'Sync & merge',
    );
    expect(parse).toHaveBeenCalledTimes(1);
    expect((parse.mock.calls[0]?.[0] ?? '').length).toBeLessThan(100);
    parse.mockRestore();
  });

  it('reads a heading that never closes', () => {
    expect(firstHeadingInHtml('<p>x</p><h3>Open ended')).toBe('Open ended');
  });

  it('is null without a heading, or with an empty one', () => {
    expect(firstHeadingInHtml('<p>Just text</p>')).toBeNull();
    expect(firstHeadingInHtml('<h1>  </h1>')).toBeNull();
    expect(firstHeadingInHtml('')).toBeNull();
  });
});
