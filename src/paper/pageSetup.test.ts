/**
 * A document's page setup (DSK-48): the locale's paper for a new document, and
 * which setting wins.
 */
import { describe, expect, it } from 'vitest';
import {
  localeDefaultPageSize,
  marginPresetOf,
  marginsOfPreset,
  pageSettingOf,
  readPageSetting,
  resolvePageSetup,
} from './pageSetup';

describe('localeDefaultPageSize', () => {
  it('gives Letter where the locale uses it', () => {
    for (const locale of ['en-US', 'en-CA', 'fr-CA', 'es-MX', 'en-PH', 'en']) {
      expect(localeDefaultPageSize(locale), locale).toBe('letter');
    }
  });

  it('gives A4 elsewhere, and for a locale it can’t read', () => {
    for (const locale of ['en-GB', 'de', 'fr', 'fr-FR', 'ja-JP', 'en-AU', 'not a locale!']) {
      expect(localeDefaultPageSize(locale), locale).toBe('a4');
    }
  });
});

describe('resolvePageSetup', () => {
  const exported = { pageSize: 'a3' as const, orientation: 'landscape' as const, margins: { top: 10, right: 11, bottom: 12, left: 13 } };

  it('takes the document’s page setting first', () => {
    const page = { size: 'tabloid', orientation: 'portrait', margins: { top: 5, right: 5, bottom: 5, left: 5 } };
    expect(resolvePageSetup(page, exported, 'en-US')).toEqual({ size: 'tabloid', orientation: 'portrait', margins: page.margins });
  });

  it('then the document’s saved export settings, so an old document keeps its size', () => {
    expect(resolvePageSetup(undefined, exported, 'en-US')).toEqual({ size: 'a3', orientation: 'landscape', margins: exported.margins });
  });

  it('then the locale’s paper, portrait, with the export’s default margins', () => {
    expect(resolvePageSetup(undefined, null, 'en-CA')).toEqual({
      size: 'letter', orientation: 'portrait', margins: { top: 20, right: 20, bottom: 20, left: 20 },
    });
    expect(resolvePageSetup(undefined, null, 'de').size).toBe('a4');
  });

  it('ignores the parts of a stored setting that aren’t valid, part by part', () => {
    const page = { size: 'b5', orientation: 'sideways', margins: { top: 5, right: -1, bottom: 5, left: 5 } };
    expect(readPageSetting(page)).toEqual({});
    expect(resolvePageSetup({ size: 'a4', margins: 'wide' }, exported, 'en-US')).toEqual({
      size: 'a4', orientation: 'landscape', margins: exported.margins,
    });
  });

  it('stores a setup in a form it reads back', () => {
    const setup = { size: 'letter' as const, orientation: 'portrait' as const, margins: marginsOfPreset('narrow') };
    expect(readPageSetting(pageSettingOf(setup))).toEqual(setup);
  });
});

describe('margin presets', () => {
  it('names margins that match a preset on every side, and calls the rest custom', () => {
    expect(marginPresetOf(marginsOfPreset('wide'))).toBe('wide');
    expect(marginPresetOf({ top: 20, right: 20, bottom: 20, left: 20 })).toBe('normal');
    expect(marginPresetOf({ top: 20, right: 15, bottom: 20, left: 20 })).toBe('custom');
  });
});
