/**
 * A document's page setup: its paper size, orientation and margins (DSK-48).
 *
 * One setting, read by Paper Mode and by the PDF export, so the pages shown
 * are the pages printed. It lives in the document's settings, which are live
 * in shared documents and kept whole by builds that don't know a key
 * (AGENTS.md). A document without it uses its saved export settings, and a new
 * document the paper of its locale: Letter where that's the standard, A4
 * elsewhere (the founder's choice, 2026-11-28).
 */

import { useDocumentSettingsStore } from '../store/documentSettingsStore';
import type { SettingValue } from '../types/DocumentSettings';
import {
  DEFAULT_MARGINS,
  type PDFMargins,
  type PDFOrientation,
  type PDFPageSize,
  type PDFSettings,
} from '../types/PDFExport';

/** The document setting that holds the page setup. */
export const PAGE_SETTING = 'page';

export interface PageSetup {
  size: PDFPageSize;
  orientation: PDFOrientation;
  margins: PDFMargins;
}

/** The sizes the export can print, in the order a menu lists them. */
export const PAGE_SIZES: readonly PDFPageSize[] = ['letter', 'a4', 'a3', 'tabloid'];

export const PAGE_SIZE_LABELS: Record<PDFPageSize, string> = {
  letter: 'Letter (8.5 × 11 in)',
  a4: 'A4 (210 × 297 mm)',
  a3: 'A3 (297 × 420 mm)',
  tabloid: 'Tabloid (11 × 17 in)',
};

/** Margins as a menu offers them: the same on every side, in mm. */
export const MARGIN_PRESETS = {
  normal: { label: 'Normal (20 mm)', mm: 20 },
  narrow: { label: 'Narrow (12.7 mm)', mm: 12.7 },
  wide: { label: 'Wide (25.4 mm)', mm: 25.4 },
} as const;

export type MarginPreset = keyof typeof MARGIN_PRESETS;

/** Regions whose standard paper is Letter; everywhere else uses A4. */
const LETTER_REGIONS = new Set(['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE', 'CR', 'GT', 'DO', 'PA', 'SV', 'NI', 'PR']);

function currentLocale(): string {
  return typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en-US';
}

/**
 * The paper a locale uses: Letter in the US, Canada and the other Letter
 * countries, A4 elsewhere. A locale without a region takes its most likely one
 * (`en` is `en-US`).
 */
export function localeDefaultPageSize(locale: string = currentLocale()): PDFPageSize {
  try {
    const region = new Intl.Locale(locale).maximize().region;
    return region !== undefined && LETTER_REGIONS.has(region) ? 'letter' : 'a4';
  } catch {
    return 'a4';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readMargins(value: unknown): PDFMargins | undefined {
  if (!isRecord(value)) return undefined;
  const sides = ['top', 'right', 'bottom', 'left'] as const;
  const margins: Partial<PDFMargins> = {};
  for (const side of sides) {
    const mm = value[side];
    if (typeof mm !== 'number' || !Number.isFinite(mm) || mm < 0 || mm > 100) return undefined;
    margins[side] = mm;
  }
  return margins as PDFMargins;
}

/** What a stored page setting says, keeping only the parts that are valid. */
export function readPageSetting(value: SettingValue | undefined): Partial<PageSetup> {
  if (!isRecord(value)) return {};
  const setup: Partial<PageSetup> = {};
  const size = value['size'];
  if (typeof size === 'string' && (PAGE_SIZES as readonly string[]).includes(size)) setup.size = size as PDFPageSize;
  const orientation = value['orientation'];
  if (orientation === 'portrait' || orientation === 'landscape') setup.orientation = orientation;
  const margins = readMargins(value['margins']);
  if (margins) setup.margins = margins;
  return setup;
}

/**
 * A document's page setup: its page setting first, then its saved export
 * settings (so an existing document keeps the size it was exported at), then
 * the locale's paper with the export's default margins.
 */
export function resolvePageSetup(
  stored: SettingValue | undefined,
  exportSettings: Partial<Pick<PDFSettings, 'pageSize' | 'orientation' | 'margins'>> | null | undefined,
  locale?: string
): PageSetup {
  const page = readPageSetting(stored);
  return {
    size: page.size ?? exportSettings?.pageSize ?? localeDefaultPageSize(locale),
    orientation: page.orientation ?? exportSettings?.orientation ?? 'portrait',
    margins: page.margins ?? (exportSettings?.margins ? { ...exportSettings.margins } : { ...DEFAULT_MARGINS }),
  };
}

/** The stored form of a page setup. */
export function pageSettingOf(setup: PageSetup): SettingValue {
  const { top, right, bottom, left } = setup.margins;
  return { size: setup.size, orientation: setup.orientation, margins: { top, right, bottom, left } };
}

/** Save the open document's page setup. */
export function setPageSetup(setup: PageSetup): void {
  useDocumentSettingsStore.getState().set(PAGE_SETTING, pageSettingOf(setup));
}

/** The open document's stored page setting, as it changes. */
export function usePageSetting(): SettingValue | undefined {
  return useDocumentSettingsStore((state) => state.settings[PAGE_SETTING]);
}

/** The preset whose margins these are, or 'custom'. */
export function marginPresetOf(margins: PDFMargins): MarginPreset | 'custom' {
  for (const [preset, { mm }] of Object.entries(MARGIN_PRESETS) as Array<[MarginPreset, { mm: number }]>) {
    if (margins.top === mm && margins.right === mm && margins.bottom === mm && margins.left === mm) return preset;
  }
  return 'custom';
}

/** Margins of a preset, the same on every side. */
export function marginsOfPreset(preset: MarginPreset): PDFMargins {
  const { mm } = MARGIN_PRESETS[preset];
  return { top: mm, right: mm, bottom: mm, left: mm };
}
