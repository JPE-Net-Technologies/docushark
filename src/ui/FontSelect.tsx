/**
 * Choose a font (DSK-246): each option drawn in its own font. One control for
 * the document font (the ribbon) and shape fonts (the Properties panel).
 *
 * Values are CSS font-family lists (`src/fonts/fontFamily.ts`). A value this
 * build doesn't bundle, written by a newer build or an agent, is listed as it
 * is and kept until another font is chosen.
 */

import { FONT_CATALOGUE, type FontRole } from '../fonts/catalogue';
import { useDocumentFont } from '../fonts/documentFont';
import { catalogueFontFor, firstFamily, FOLLOW_DOCUMENT_FONT, sanitizeFontFamily } from '../fonts/fontFamily';
import { RichSelect, type RichSelectItem } from './components/RichSelect';
import './FontSelect.css';

export interface FontSelectProps {
  /** The stored value. For shapes, absent or `sans-serif` follows the document font. */
  value: string | undefined;
  /** The chosen font's CSS list; `undefined` means follow the document font (shapes only). */
  onChange: (css: string | undefined) => void;
  /** Which fonts to offer: the document's, or a shape's (which adds "Document font"). */
  role: FontRole;
  ariaLabel: string;
  minWidth?: number;
  className?: string;
}

/** The option a stored value selects. */
function selectedValue(value: string | undefined, role: FontRole): string {
  const css = sanitizeFontFamily(value);
  if (role === 'shape' && (css === null || css === FOLLOW_DOCUMENT_FONT)) return FOLLOW_DOCUMENT_FONT;
  if (css === null) return '';
  return catalogueFontFor(css)?.css ?? css;
}

/** "Comic Sans MS" from `'Comic Sans MS', cursive`, as written. */
function displayName(css: string): string {
  return (css.split(',')[0] ?? css).trim().replace(/^['"]|['"]$/g, '');
}

function fontRow(name: string, kind: string, css: string) {
  return (
    <span className="font-select-option">
      <span className="font-select-name" style={{ fontFamily: css }}>
        {name}
      </span>
      <span className="font-select-kind">{kind}</span>
    </span>
  );
}

export function FontSelect({ value, onChange, role, ariaLabel, minWidth, className }: FontSelectProps) {
  const documentFont = useDocumentFont();
  const selected = selectedValue(value, role);

  const items: RichSelectItem<string>[] = [];
  if (role === 'shape') {
    const documentName = displayName(documentFont);
    items.push({
      value: FOLLOW_DOCUMENT_FONT,
      label: 'Document font',
      keywords: `document font ${documentName}`,
      render: () => fontRow('Document font', documentName, documentFont),
    });
  }
  for (const font of FONT_CATALOGUE) {
    if (!font.roles.includes(role)) continue;
    items.push({
      value: font.css,
      label: font.name,
      keywords: `${font.name} ${font.kind}`,
      render: () => fontRow(font.name, font.kind, font.css),
    });
  }
  if (selected !== '' && !items.some((item) => item.value === selected)) {
    const name = displayName(selected);
    items.push({
      value: selected,
      label: name,
      keywords: firstFamily(selected),
      render: () => fontRow(name, 'Not bundled', selected),
    });
  }

  return (
    <RichSelect<string>
      value={selected}
      onChange={(next) => onChange(next === FOLLOW_DOCUMENT_FONT ? undefined : next)}
      items={items}
      ariaLabel={ariaLabel}
      {...(minWidth !== undefined && { minWidth })}
      {...(className !== undefined && { className })}
    />
  );
}
