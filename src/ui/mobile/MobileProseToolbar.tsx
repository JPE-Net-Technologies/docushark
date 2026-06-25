/**
 * MobileProseToolbar — the prose ribbon, partitioned for mobile (JP-332).
 *
 * The full DocumentEditorToolbar is a tabbed ribbon that wraps to several rows
 * on a narrow viewport, cramping the writing column. On mobile we render a slim
 * one-row bar of the highest-frequency marks plus a "Format" button. Tapping
 * Format expands the complete ribbon *inline above the bar* (bounded height,
 * scrollable) rather than as an overlay — so it squeezes the writing area
 * instead of drawing over the text.
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

import { useEffect, useState } from 'react';
import { Bold, Italic, Underline, List, Heading2, Type, X } from 'lucide-react';
import { Icon } from '../icons';
import { useTiptapEditor } from '../TiptapEditorContext';
import * as cmd from '../editorCommands';
import { DocumentEditorToolbar } from '../DocumentEditorToolbar';
import './MobileProseToolbar.css';

export function MobileProseToolbar() {
  const editor = useTiptapEditor();
  const [, force] = useState({});
  const [showFormat, setShowFormat] = useState(false);

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

  // No live editor (e.g. a read-only ProsePreview) → nothing to format.
  if (!editor) return null;

  const isH2 = editor.isActive('heading', { level: 2 });

  return (
    <div className="mobile-prose-toolbar">
      {showFormat && (
        <div className="mpt-panel" role="region" aria-label="Formatting">
          <DocumentEditorToolbar />
        </div>
      )}

      <div className="mpt-bar">
        <button
          className={`mpt-btn${editor.isActive('bold') ? ' is-active' : ''}`}
          onClick={() => cmd.toggleBold(editor)}
          aria-label="Bold"
          aria-pressed={editor.isActive('bold')}
        >
          <Icon icon={Bold} />
        </button>
        <button
          className={`mpt-btn${editor.isActive('italic') ? ' is-active' : ''}`}
          onClick={() => cmd.toggleItalic(editor)}
          aria-label="Italic"
          aria-pressed={editor.isActive('italic')}
        >
          <Icon icon={Italic} />
        </button>
        <button
          className={`mpt-btn${editor.isActive('underline') ? ' is-active' : ''}`}
          onClick={() => cmd.toggleUnderline(editor)}
          aria-label="Underline"
          aria-pressed={editor.isActive('underline')}
        >
          <Icon icon={Underline} />
        </button>
        <button
          className={`mpt-btn${isH2 ? ' is-active' : ''}`}
          onClick={() => (isH2 ? cmd.setParagraph(editor) : cmd.setHeading(editor, 2))}
          aria-label="Heading"
          aria-pressed={isH2}
        >
          <Icon icon={Heading2} />
        </button>
        <button
          className={`mpt-btn${editor.isActive('bulletList') ? ' is-active' : ''}`}
          onClick={() => cmd.toggleBulletList(editor)}
          aria-label="Bullet list"
          aria-pressed={editor.isActive('bulletList')}
        >
          <Icon icon={List} />
        </button>

        <button
          className={`mpt-format${showFormat ? ' is-open' : ''}`}
          onClick={() => setShowFormat((v) => !v)}
          aria-pressed={showFormat}
          aria-label={showFormat ? 'Close formatting' : 'More formatting'}
        >
          <Icon icon={showFormat ? X : Type} />
          <span>Format</span>
        </button>
      </div>
    </div>
  );
}
