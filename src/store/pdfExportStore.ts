/**
 * PDF export store for persisting export preferences.
 *
 * Stores user preferences for PDF export settings.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  PDFPageSize,
  PDFOrientation,
  PDFQuality,
  PDFPageNumberFormat,
  PDFMargins,
  PDFCoverPage,
  PDFDiagramEmbed,
  PDFDiagramPosition,
  PDFSettings,
  DEFAULT_MARGINS,
  DEFAULT_COVER_PAGE,
  DEFAULT_DIAGRAM_EMBED,
} from '../types/PDFExport';

/**
 * PDF export preferences state.
 */
export interface PDFExportState {
  /** Preferred page size */
  pageSize: PDFPageSize;
  /** Preferred orientation */
  orientation: PDFOrientation;
  /** Preferred quality setting */
  quality: PDFQuality;
  /** Preferred margins */
  margins: PDFMargins;
  /** Show page numbers */
  showPageNumbers: boolean;
  /** Page number format */
  pageNumberFormat: PDFPageNumberFormat;
  /** Cover page preferences (persisted separately from per-export options) */
  coverPageDefaults: {
    enabled: boolean;
    logoMaxWidth: number;
    logoBlobId: string | null;
    author: string;
    version: string;
    description: string;
  };
  /** Diagram embed preferences */
  diagramEmbedDefaults: {
    enabled: boolean;
    position: PDFDiagramPosition;
    scale: 1 | 2 | 3;
    useThemeBackground: boolean;
  };
}

/**
 * PDF export actions.
 */
export interface PDFExportActions {
  /** Set page size preference */
  setPageSize: (size: PDFPageSize) => void;
  /** Set orientation preference */
  setOrientation: (orientation: PDFOrientation) => void;
  /** Set quality preference */
  setQuality: (quality: PDFQuality) => void;
  /** Set margins preference */
  setMargins: (margins: PDFMargins) => void;
  /** Set show page numbers preference */
  setShowPageNumbers: (show: boolean) => void;
  /** Set page number format preference */
  setPageNumberFormat: (format: PDFPageNumberFormat) => void;
  /** Set cover page defaults */
  setCoverPageDefaults: (defaults: Partial<PDFExportState['coverPageDefaults']>) => void;
  /** Set diagram embed defaults */
  setDiagramEmbedDefaults: (defaults: Partial<PDFExportState['diagramEmbedDefaults']>) => void;
  /** Reset all preferences to defaults */
  resetPreferences: () => void;
}

/**
 * Initial state with default values.
 */
const initialState: PDFExportState = {
  pageSize: 'a4',
  orientation: 'portrait',
  quality: 'high',
  margins: { ...DEFAULT_MARGINS },
  showPageNumbers: true,
  pageNumberFormat: 'x-of-y',
  coverPageDefaults: {
    enabled: false,
    logoMaxWidth: 60,
    logoBlobId: null,
    author: '',
    version: '',
    description: '',
  },
  diagramEmbedDefaults: {
    ...DEFAULT_DIAGRAM_EMBED,
  },
};

/**
 * PDF export preferences store.
 *
 * Persists user preferences for PDF export to localStorage.
 *
 * Usage:
 * ```typescript
 * const { pageSize, setPageSize } = usePDFExportStore();
 *
 * // Get current preference
 * console.log(pageSize); // 'a4'
 *
 * // Update preference
 * setPageSize('letter');
 * ```
 */
export const usePDFExportStore = create<PDFExportState & PDFExportActions>()(
  persist(
    (set, get) => ({
      // State
      ...initialState,

      // Actions
      setPageSize: (size: PDFPageSize) => {
        set({ pageSize: size });
      },

      setOrientation: (orientation: PDFOrientation) => {
        set({ orientation: orientation });
      },

      setQuality: (quality: PDFQuality) => {
        set({ quality: quality });
      },

      setMargins: (margins: PDFMargins) => {
        set({ margins: { ...margins } });
      },

      setShowPageNumbers: (show: boolean) => {
        set({ showPageNumbers: show });
      },

      setPageNumberFormat: (format: PDFPageNumberFormat) => {
        set({ pageNumberFormat: format });
      },

      setCoverPageDefaults: (defaults: Partial<PDFExportState['coverPageDefaults']>) => {
        set({
          coverPageDefaults: {
            ...get().coverPageDefaults,
            ...defaults,
          },
        });
      },

      setDiagramEmbedDefaults: (defaults: Partial<PDFExportState['diagramEmbedDefaults']>) => {
        set({
          diagramEmbedDefaults: {
            ...get().diagramEmbedDefaults,
            ...defaults,
          },
        });
      },

      resetPreferences: () => {
        set(initialState);
      },
    }),
    {
      name: 'diagrammer-pdf-export',
      partialize: (state) => ({
        pageSize: state.pageSize,
        orientation: state.orientation,
        quality: state.quality,
        margins: state.margins,
        showPageNumbers: state.showPageNumbers,
        pageNumberFormat: state.pageNumberFormat,
        coverPageDefaults: state.coverPageDefaults,
        diagramEmbedDefaults: state.diagramEmbedDefaults,
      }),
    }
  )
);

/**
 * Build the initial PDF export options that seed the dialog form.
 *
 * Resolution rule (snapshot model — not a merge):
 *   - If `documentPdfSettings` is provided, every form field comes from it.
 *     App-level defaults are NOT consulted for any field, so a user who
 *     cleared the cover logo in this doc won't have the app-level logo
 *     leak back in.
 *   - If `documentPdfSettings` is absent (untouched / older doc), every
 *     field comes from app-level defaults. App defaults exist solely to
 *     seed new documents on first open.
 *
 * `coverPage.title` and `coverPage.date` are always regenerated from the
 * document name + today's date — they aren't stored either per-doc or
 * per-app, so they're never stale.
 */
export function createInitialPDFOptions(
  documentName: string,
  documentPdfSettings?: PDFSettings | null,
): {
  filename: string;
  pageSize: PDFPageSize;
  orientation: PDFOrientation;
  quality: PDFQuality;
  margins: PDFMargins;
  showPageNumbers: boolean;
  pageNumberFormat: PDFPageNumberFormat;
  includeTableOfContents: boolean;
  includePdfOutline: boolean;
  coverPage: PDFCoverPage;
  diagramEmbed: PDFDiagramEmbed;
} {
  const today = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  if (documentPdfSettings) {
    const dc = documentPdfSettings.coverPage;
    return {
      filename: documentName || 'document',
      pageSize: documentPdfSettings.pageSize,
      orientation: documentPdfSettings.orientation,
      quality: documentPdfSettings.quality,
      margins: { ...documentPdfSettings.margins },
      showPageNumbers: documentPdfSettings.showPageNumbers,
      pageNumberFormat: documentPdfSettings.pageNumberFormat,
      includeTableOfContents: documentPdfSettings.includeTableOfContents,
      includePdfOutline: documentPdfSettings.includePdfOutline,
      coverPage: {
        enabled: dc.enabled,
        logoMaxWidth: dc.logoMaxWidth,
        logoBlobId: dc.logoBlobId,
        author: dc.author,
        version: dc.version,
        description: dc.description,
        title: documentName || 'Untitled Document',
        date: today,
      },
      diagramEmbed: { ...documentPdfSettings.diagramEmbed },
    };
  }

  // No per-document snapshot: seed from app defaults.
  const state = usePDFExportStore.getState();
  return {
    filename: documentName || 'document',
    pageSize: state.pageSize,
    orientation: state.orientation,
    quality: state.quality,
    margins: { ...state.margins },
    showPageNumbers: state.showPageNumbers,
    pageNumberFormat: state.pageNumberFormat,
    includeTableOfContents: true,
    includePdfOutline: true,
    coverPage: {
      ...DEFAULT_COVER_PAGE,
      enabled: state.coverPageDefaults.enabled,
      logoMaxWidth: state.coverPageDefaults.logoMaxWidth,
      logoBlobId: state.coverPageDefaults.logoBlobId,
      author: state.coverPageDefaults.author,
      version: state.coverPageDefaults.version,
      description: state.coverPageDefaults.description,
      title: documentName || 'Untitled Document',
      date: today,
    },
    diagramEmbed: { ...state.diagramEmbedDefaults },
  };
}
