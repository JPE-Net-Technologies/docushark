/**
 * The ribbon's Document menu, "Aa": settings for the whole document rather than
 * the selection. It sits last on the Home tab, so in a narrow panel it folds
 * into More tools before any formatting does.
 *
 * Today it holds the document font (DSK-246). Further whole-document settings,
 * such as Paper Mode's page size and margins, go here as their own headed
 * sections instead of taking ribbon space (the placement rule in AGENTS.md).
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { setDocumentFont, useDocumentFont } from '../fonts/documentFont';
import { RichSelectItems } from './components/RichSelect';
import { fontDisplayName, fontOptions } from './FontSelect';
import './components/RichSelect.css';
import './DocumentMenu.css';

export function DocumentMenu() {
  const documentFont = useDocumentFont();
  const { selected, items } = fontOptions('document', documentFont, documentFont);
  const fontName = fontDisplayName(documentFont);

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
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
