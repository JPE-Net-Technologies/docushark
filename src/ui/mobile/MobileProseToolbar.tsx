/**
 * MobileProseToolbar — the prose ribbon, partitioned for mobile (JP-332).
 *
 * The full DocumentEditorToolbar is a tabbed ribbon that wraps to several rows
 * on a narrow viewport, cramping the writing column. On mobile we render a slim
 * one-row bar of the everyday controls plus a "Format" button. Tapping Format
 * expands the complete ribbon *inline above the bar* (bounded height,
 * scrollable) rather than as an overlay — so it squeezes the writing area
 * instead of drawing over the text.
 *
 * The bar (DSK-197) scrolls sideways under a pinned Format button: undo and
 * redo (a phone has no Mod+Z), a text-style menu that opens as a sheet, the
 * marks, the lists — with indent and outdent while the caret is in one, since a
 * phone has no Tab key — and link. Every control is 44px, and pressing one
 * keeps the caret in the editor, so the keyboard doesn't drop and rise again
 * on each tap. While Format is open the bar keeps only undo and redo: the
 * ribbon above repeats everything else.
 *
 * This component is mounted as the LAST flex child of the editor panel (a flex
 * column), so expanding the panel shrinks the `flex: 1` content above it. The
 * panel reserves the keyboard inset (see DocumentEditorPanel + useKeyboardInset),
 * which keeps this bar sitting directly above the on-screen keyboard.
 *
 * It hosts the real DocumentEditorToolbar verbatim (so every dialog keeps
 * working); because it lives inside the panel's TiptapEditorProvider it shares
 * the same editor without any re-providing, and the slim bar is the only toolbar
 * mounted when collapsed (no duplicate shortcut listeners).
 */

import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type { Editor } from '@tiptap/core';
import type { LucideIcon } from 'lucide-react';
import {
  Bold,
  ChevronDown,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  Redo2,
  Strikethrough,
  Type,
  Underline,
  Undo2,
  X,
} from 'lucide-react';
import { Icon } from '../icons';
import { useTiptapEditor } from '../TiptapEditorContext';
import * as cmd from '../editorCommands';
import { DocumentEditorToolbar } from '../DocumentEditorToolbar';
import { InsertLinkDialog } from '../InsertLinkDialog';
import { DropdownMenu, menuAction } from '../components/DropdownMenu';
import { MirrorBanner } from '../integrations/MirrorBanner';
import { useActiveDocReadOnly } from '../../store/documentRegistry';
import { useActivePageMirror, useRichTextPagesStore } from '../../store/richTextPagesStore';
import './MobileProseToolbar.css';

/**
 * Keep the caret in the editor when a toolbar button is pressed (DSK-197).
 *
 * A press moves focus to the button, which blurs the editor and drops the
 * phone's keyboard; the command's own `focus()` then raises it again — a
 * flicker on every tap. Cancelling the press's default keeps focus where it is;
 * the click still fires. Only for buttons in the bar's own DOM: a dialog it
 * opens is portaled elsewhere and keeps normal focus behaviour.
 */
function keepEditorFocus(e: ReactMouseEvent<HTMLElement>): void {
  const target = e.target as HTMLElement;
  if (e.currentTarget.contains(target) && target.closest('button')) e.preventDefault();
}

type TextStyle = 'body' | 'h1' | 'h2' | 'h3' | 'quote' | 'code';

const TEXT_STYLES: { id: TextStyle; label: string; short: string }[] = [
  { id: 'body', label: 'Body text', short: 'Body' },
  { id: 'h1', label: 'Heading 1', short: 'H1' },
  { id: 'h2', label: 'Heading 2', short: 'H2' },
  { id: 'h3', label: 'Heading 3', short: 'H3' },
  { id: 'quote', label: 'Quote', short: 'Quote' },
  { id: 'code', label: 'Code block', short: 'Code' },
];

function currentTextStyle(editor: Editor): TextStyle {
  if (editor.isActive('codeBlock')) return 'code';
  for (const level of [1, 2, 3] as const) {
    if (editor.isActive('heading', { level })) return `h${level}`;
  }
  if (editor.isActive('blockquote')) return 'quote';
  return 'body';
}

function applyTextStyle(editor: Editor, style: TextStyle, from: TextStyle): void {
  // Quote and code block are toggles; leave one before applying another.
  if (from === 'quote' && style !== 'quote') cmd.toggleBlockquote(editor);
  if (from === 'code' && style !== 'code') cmd.toggleCodeBlock(editor);
  if (style === from) return;
  if (style === 'body') cmd.setParagraph(editor);
  else if (style === 'quote') cmd.toggleBlockquote(editor);
  else if (style === 'code') cmd.toggleCodeBlock(editor);
  else cmd.setHeading(editor, Number(style.slice(1)) as 1 | 2 | 3);
}

interface BarButtonProps {
  label: string;
  icon: LucideIcon;
  onPress: () => void;
  active?: boolean | undefined;
  disabled?: boolean | undefined;
}

function BarButton({ label, icon, onPress, active, disabled }: BarButtonProps) {
  return (
    <button
      type="button"
      className={`mpt-btn${active ? ' is-active' : ''}`}
      onClick={onPress}
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
    >
      <Icon icon={icon} size={20} />
    </button>
  );
}

export function MobileProseToolbar() {
  const editor = useTiptapEditor();
  const docReadOnly = useActiveDocReadOnly();
  const activeMirror = useActivePageMirror();
  const activePageId = useRichTextPagesStore((s) => s.activePageId);
  const [, force] = useState({});
  const [showFormat, setShowFormat] = useState(false);
  const [showLink, setShowLink] = useState(false);

  // Re-render the slim bar's active states as the selection/content changes
  // (same subscription the full ribbon uses).
  useEffect(() => {
    if (!editor) return;
    const handle = () => force({});
    editor.on('selectionUpdate', handle);
    editor.on('transaction', handle);
    return () => {
      editor.off('selectionUpdate', handle);
      editor.off('transaction', handle);
    };
  }, [editor]);

  // JP-462: same rule as the desktop ribbon — a viewer gets a statement, not a
  // set of controls that do nothing. Kept as a strip rather than removed
  // entirely so the answer to "why can't I type?" is on screen; screen space is
  // tighter here, so it is one line.
  if (docReadOnly) {
    if (!editor) return null;
    return (
      <div className="mobile-prose-toolbar mobile-prose-toolbar--readonly" role="status">
        View only
      </div>
    );
  }

  // A mirror page is read-only page by page (DSK-193), which the document-level
  // check above never sees: its marks did nothing. Say what the page is and
  // offer what can be done with it, as the desktop ribbon does (DSK-197).
  if (activeMirror && activePageId) {
    return (
      <div className="mobile-prose-toolbar mobile-prose-toolbar--mirror">
        <MirrorBanner pageId={activePageId} mirror={activeMirror} compact />
      </div>
    );
  }

  // No live editor (e.g. a read-only ProsePreview) → nothing to format.
  if (!editor) return null;

  const style = currentTextStyle(editor);
  const styleInfo = TEXT_STYLES.find((s) => s.id === style) ?? TEXT_STYLES[0]!;
  const inList = cmd.isInList(editor);

  return (
    <div className="mobile-prose-toolbar" onMouseDown={keepEditorFocus}>
      {showFormat && (
        <div className="mpt-panel" role="region" aria-label="Formatting">
          <DocumentEditorToolbar />
        </div>
      )}

      <div className="mpt-bar">
        <div className="mpt-scroll" role="toolbar" aria-label="Quick formatting">
          <BarButton label="Undo" icon={Undo2} onPress={() => cmd.undo(editor)} disabled={!cmd.canUndo(editor)} />
          <BarButton label="Redo" icon={Redo2} onPress={() => cmd.redo(editor)} disabled={!cmd.canRedo(editor)} />

          {!showFormat && (
            <>
              <span className="mpt-sep" aria-hidden="true" />
              <DropdownMenu
                trigger={
                  <>
                    <span className="mpt-style-label">{styleInfo.short}</span>
                    <ChevronDown size={14} aria-hidden="true" />
                  </>
                }
                triggerClassName="mpt-style"
                triggerTitle={`Text style: ${styleInfo.label}`}
                sheetTitle="Text style"
                align="left"
                entries={TEXT_STYLES.map((s) =>
                  menuAction({
                    id: `style-${s.id}`,
                    label: s.label,
                    checked: s.id === style,
                    onSelect: () => applyTextStyle(editor, s.id, style),
                  }),
                )}
              />
              <BarButton label="Bold" icon={Bold} onPress={() => cmd.toggleBold(editor)} active={editor.isActive('bold')} />
              <BarButton
                label="Italic"
                icon={Italic}
                onPress={() => cmd.toggleItalic(editor)}
                active={editor.isActive('italic')}
              />
              <BarButton
                label="Underline"
                icon={Underline}
                onPress={() => cmd.toggleUnderline(editor)}
                active={editor.isActive('underline')}
              />
              <BarButton
                label="Strikethrough"
                icon={Strikethrough}
                onPress={() => cmd.toggleStrike(editor)}
                active={editor.isActive('strike')}
              />

              <span className="mpt-sep" aria-hidden="true" />
              <BarButton
                label="Bullet list"
                icon={List}
                onPress={() => cmd.toggleBulletList(editor)}
                active={editor.isActive('bulletList')}
              />
              <BarButton
                label="Numbered list"
                icon={ListOrdered}
                onPress={() => cmd.toggleOrderedList(editor)}
                active={editor.isActive('orderedList')}
              />
              <BarButton
                label="Task list"
                icon={ListChecks}
                onPress={() => cmd.toggleTaskList(editor)}
                active={editor.isActive('taskList')}
              />
              {inList && (
                <>
                  <BarButton
                    label="Outdent"
                    icon={IndentDecrease}
                    onPress={() => cmd.outdentListItem(editor)}
                    disabled={!cmd.canOutdentListItem(editor)}
                  />
                  <BarButton
                    label="Indent"
                    icon={IndentIncrease}
                    onPress={() => cmd.indentListItem(editor)}
                    disabled={!cmd.canIndentListItem(editor)}
                  />
                </>
              )}

              <span className="mpt-sep" aria-hidden="true" />
              <BarButton label="Link" icon={Link} onPress={() => setShowLink(true)} active={editor.isActive('link')} />
            </>
          )}
        </div>

        <button
          type="button"
          className={`mpt-format${showFormat ? ' is-open' : ''}`}
          onClick={() => setShowFormat((v) => !v)}
          aria-pressed={showFormat}
          aria-label={showFormat ? 'Close formatting' : 'More formatting'}
        >
          <Icon icon={showFormat ? X : Type} size={18} />
          <span>Format</span>
        </button>
      </div>

      {showLink && <InsertLinkDialog editor={editor} onClose={() => setShowLink(false)} />}
    </div>
  );
}
