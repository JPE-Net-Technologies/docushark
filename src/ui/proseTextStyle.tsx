/**
 * The text-style choice (paragraph or a heading level), shared by the ribbon's
 * Home tab and the selection bubble (DSK-200), so both offer the same levels
 * the same way.
 */
import type { Editor } from '@tiptap/core';
import type { RichSelectItem } from './components/RichSelect';
import * as cmd from './editorCommands';

/** The text-level select values. */
export type TextStyle = 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

/**
 * Text-level options for the heading RichSelect. Each entry renders its label
 * styled as the level it sets, so the menu previews the result (JP-149).
 */
export const TEXT_STYLE_ITEMS: RichSelectItem<TextStyle>[] = (
  [
    { value: 'p', label: 'Paragraph', size: '0.95rem', weight: 400 },
    { value: 'h1', label: 'Heading 1', size: '1.5rem', weight: 700 },
    { value: 'h2', label: 'Heading 2', size: '1.3rem', weight: 700 },
    { value: 'h3', label: 'Heading 3', size: '1.15rem', weight: 600 },
    { value: 'h4', label: 'Heading 4', size: '1.05rem', weight: 600 },
    { value: 'h5', label: 'Heading 5', size: '0.95rem', weight: 600 },
    { value: 'h6', label: 'Heading 6', size: '0.9rem', weight: 600 },
  ] as const
).map(({ value, label, size, weight }) => ({
  value,
  label,
  render: () => (
    <span style={{ fontSize: size, fontWeight: weight, lineHeight: 1.25 }}>{label}</span>
  ),
}));

const LEVELS = [1, 2, 3, 4, 5, 6] as const;

/** The style of the block the selection is in. */
export function textStyleOf(editor: Editor | null): TextStyle {
  const level = LEVELS.find((candidate) => editor?.isActive('heading', { level: candidate }));
  return level ? (`h${level}` as TextStyle) : 'p';
}

export function applyTextStyle(editor: Editor, style: TextStyle): void {
  if (style === 'p') cmd.setParagraph(editor);
  else cmd.setHeading(editor, Number(style.slice(1)) as (typeof LEVELS)[number]);
}
