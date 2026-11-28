/**
 * The ribbon's Document menu, "Aa": settings for the whole document rather than
 * the selection. It sits last on the Home tab, so in a narrow panel it folds
 * into More tools before any formatting does.
 *
 * It holds the document font (DSK-246) and the page setup that Paper Mode and
 * the PDF export share (DSK-48): size, orientation and margins. Further
 * whole-document settings go here as their own headed sections instead of
 * taking ribbon space (the placement rule in AGENTS.md).
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { setDocumentFont, useDocumentFont } from '../fonts/documentFont';
import {
  MARGIN_PRESETS,
  marginPresetOf,
  marginsOfPreset,
  PAGE_SIZE_LABELS,
  PAGE_SIZES,
  setPageSetup,
  type MarginPreset,
} from '../paper/pageSetup';
import { useDocumentPageSetup } from '../paper/useDocumentPageSetup';
import type { PDFOrientation, PDFPageSize } from '../types/PDFExport';
import { RichSelectItems } from './components/RichSelect';
import { fontDisplayName, fontOptions } from './FontSelect';
import './components/RichSelect.css';
import './DocumentMenu.css';

export function DocumentMenu() {
  const documentFont = useDocumentFont();
  const { selected, items } = fontOptions('document', documentFont, documentFont);
  const fontName = fontDisplayName(documentFont);
  const page = useDocumentPageSetup();
  const marginPreset = marginPresetOf(page.margins);
  const marginItems: Array<{ value: MarginPreset | 'custom'; label: string }> = [
    ...(Object.entries(MARGIN_PRESETS) as Array<[MarginPreset, { label: string }]>).map(([value, { label }]) => ({ value, label })),
    ...(marginPreset === 'custom' ? [{ value: 'custom' as const, label: 'Custom (set in Export to PDF)' }] : []),
  ];

  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="document-editor-toolbar-btn document-menu-trigger"
          aria-label={`Document settings (font: ${fontName})`}
        >
          {/* Drawn in the document's own font, so the button previews it. */}
          <span className="document-menu-aa" style={{ fontFamily: documentFont }} aria-hidden="true">
            Aa
          </span>
          <svg className="document-menu-chevron" width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
            <path fill="currentColor" d="M2 4l4 4 4-4" />
          </svg>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="rich-select-content document-menu-content"
          side="bottom"
          align="end"
          sideOffset={4}
          collisionPadding={8}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <DropdownMenu.Label className="document-menu-label">Font for the whole document</DropdownMenu.Label>
          <RichSelectItems value={selected} onChange={(css) => setDocumentFont(css)} items={items} />
          <DropdownMenu.Separator className="document-menu-separator" />
          <DropdownMenu.Label className="document-menu-label">Page size</DropdownMenu.Label>
          <RichSelectItems<PDFPageSize>
            value={page.size}
            onChange={(size) => setPageSetup({ ...page, size })}
            items={PAGE_SIZES.map((size) => ({ value: size, label: PAGE_SIZE_LABELS[size] }))}
          />
          <DropdownMenu.Separator className="document-menu-separator" />
          <DropdownMenu.Label className="document-menu-label">Orientation</DropdownMenu.Label>
          <RichSelectItems<PDFOrientation>
            value={page.orientation}
            onChange={(orientation) => setPageSetup({ ...page, orientation })}
            items={[
              { value: 'portrait', label: 'Portrait' },
              { value: 'landscape', label: 'Landscape' },
            ]}
          />
          <DropdownMenu.Separator className="document-menu-separator" />
          <DropdownMenu.Label className="document-menu-label">Margins</DropdownMenu.Label>
          <RichSelectItems<MarginPreset | 'custom'>
            value={marginPreset}
            onChange={(preset) => {
              if (preset !== 'custom') setPageSetup({ ...page, margins: marginsOfPreset(preset) });
            }}
            items={marginItems}
          />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
