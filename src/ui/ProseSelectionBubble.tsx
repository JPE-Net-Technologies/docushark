/**
 * Formatting that comes to the text (DSK-200): selecting prose shows a small
 * bar above the selection with bold, italic, underline, strikethrough, two
 * heading levels, highlight, link and clear. Built on Tiptap's BubbleMenu.
 *
 * It stays away from code blocks (formatting doesn't apply there), from node
 * and cell selections (an image or a table has its own tab), from text that
 * can't be edited, and from phones (the phone bar covers it, and the panel
 * doesn't mount it there). Appearance > Writing turns it off.
 *
 * Every control is a single press: a menu would open outside the bubble, and
 * the bubble hides when the editor loses focus to it.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { BubbleMenu } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { TextSelection, type EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import {
  Bold, Heading1, Heading2, Highlighter, Italic, Link, RemoveFormatting, Strikethrough, Underline,
} from 'lucide-react';
import { useTiptapEditor } from './TiptapEditorContext';
import { useUIPreferencesStore } from '../store/uiPreferencesStore';
import { formatCombo } from '../engine/keybindings';
import { InsertLinkDialog } from './InsertLinkDialog';
import { HIGHLIGHT_GROUP } from './color/presets';
import { applyTextStyle, textStyleOf } from './proseTextStyle';
import * as cmd from './editorCommands';
import { ICON } from './icons';
import './DocumentEditorToolbar.css';
import './ProseSelectionBubble.css';

/** The bubble's one-press highlight: the highlight palette's first tint. */
export const BUBBLE_HIGHLIGHT = HIGHLIGHT_GROUP.rows[0]![0]!;

interface BubbleContext {
  editor: Editor;
  view: EditorView;
  state: EditorState;
  from: number;
  to: number;
}

/** Show for a non-empty text selection in focused, editable prose, outside code. */
export function shouldShowBubble({ editor, view, state, from, to }: BubbleContext): boolean {
  if (!editor.isEditable || from === to) return false;
  if (!(state.selection instanceof TextSelection)) return false;
  if (editor.isActive('codeBlock')) return false;
  return view.hasFocus();
}

function BubbleButton({ label, active, onPress, children }: { label: string; active?: boolean; onPress: () => void; children: ReactNode }) {
  return (
    <button type="button" className={`document-editor-toolbar-btn${active ? ' active' : ''}`} onClick={onPress} title={label} aria-label={label} aria-pressed={active}>
      {children}
    </button>
  );
}

export function ProseSelectionBubble() {
  const editor = useTiptapEditor();
  const enabled = useUIPreferencesStore((s) => s.appearancePrefs.selectionBubble);
  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [, rerender] = useState(0);

  // The buttons show what the selection already has.
  useEffect(() => {
    if (!editor) return undefined;
    const update = () => rerender((n) => n + 1);
    editor.on('transaction', update);
    return () => {
      editor.off('transaction', update);
    };
  }, [editor]);

  if (!editor || !enabled) return null;
  const style = textStyleOf(editor);
  const highlighted = editor.isActive('highlight');

  return (
    <>
      {/* The menu's plugin moves its element into tippy's popper on <body>, and
          React only hears events inside the containers it renders into: drawn
          in place, every press on the bubble was dropped. So it renders through
          a portal to <body>.
          React must never be the one to remove the moved element either: on
          unmount (the setting turned off, the panel going away) React removes
          only this wrapper, still where React put it, and the plugin's cleanup
          disposes of the moved element. Without the wrapper, unmounting threw
          "removeChild: not a child of this node". */}
      {createPortal(
      <div className="prose-bubble-host">
      <BubbleMenu
        editor={editor}
        shouldShow={shouldShowBubble}
        tippyOptions={{
          duration: 120,
          placement: 'top',
          maxWidth: 'none',
          appendTo: () => document.body,
          // Flip below the selection rather than cover the ribbon on the first lines.
          popperOptions: {
            modifiers: [{ name: 'flip', options: { boundary: editor.view.dom.closest('.tiptap-editor') ?? 'clippingParents' } }],
          },
        }}
      >
        {/* Pressing a button mustn't take focus from the text: the selection would go. */}
        <div className="prose-bubble" role="toolbar" aria-label="Format selection" onMouseDown={(e) => e.preventDefault()}>
          <BubbleButton label={`Bold (${formatCombo('Mod+B')})`} active={editor.isActive('bold')} onPress={() => cmd.toggleBold(editor)}>
            <Bold {...ICON} />
          </BubbleButton>
          <BubbleButton label={`Italic (${formatCombo('Mod+I')})`} active={editor.isActive('italic')} onPress={() => cmd.toggleItalic(editor)}>
            <Italic {...ICON} />
          </BubbleButton>
          <BubbleButton label={`Underline (${formatCombo('Mod+U')})`} active={editor.isActive('underline')} onPress={() => cmd.toggleUnderline(editor)}>
            <Underline {...ICON} />
          </BubbleButton>
          <BubbleButton label="Strikethrough" active={editor.isActive('strike')} onPress={() => cmd.toggleStrike(editor)}>
            <Strikethrough {...ICON} />
          </BubbleButton>
          <span className="prose-bubble__divider" aria-hidden="true" />
          {/* Heading levels toggle back to a paragraph (cmd.setHeading toggles). */}
          <BubbleButton label="Heading 1" active={style === 'h1'} onPress={() => applyTextStyle(editor, 'h1')}>
            <Heading1 {...ICON} />
          </BubbleButton>
          <BubbleButton label="Heading 2" active={style === 'h2'} onPress={() => applyTextStyle(editor, 'h2')}>
            <Heading2 {...ICON} />
          </BubbleButton>
          <span className="prose-bubble__divider" aria-hidden="true" />
          <BubbleButton label="Highlight" active={highlighted} onPress={() => (highlighted ? cmd.unsetHighlight(editor) : cmd.setHighlight(editor, BUBBLE_HIGHLIGHT))}>
            <Highlighter {...ICON} />
          </BubbleButton>
          <BubbleButton label="Link" active={editor.isActive('link')} onPress={() => setShowLinkDialog(true)}>
            <Link {...ICON} />
          </BubbleButton>
          <BubbleButton label="Clear formatting" onPress={() => cmd.clearFormatting(editor)}>
            <RemoveFormatting {...ICON} />
          </BubbleButton>
        </div>
      </BubbleMenu>
      </div>,
      document.body,
      )}
      {showLinkDialog && <InsertLinkDialog editor={editor} onClose={() => setShowLinkDialog(false)} />}
    </>
  );
}
