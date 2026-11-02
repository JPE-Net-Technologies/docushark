/**
 * DocumentEditorToolbar - the ribbon for the rich text editor, in one row:
 * undo and redo (DSK-200), the tab switch, the tab's controls, and Find.
 *
 * - Home: text formatting, colours, lists, alignment.
 * - Insert: tables, maths, images and files, callouts, citations, fields.
 * - Table and Image are contextual (DSK-27): each appears while the selection
 *   is in a table or on an image, is never chosen for you, and gives way to
 *   the tab you were on when the selection leaves.
 *
 * **Read-only documents get a "View only" strip instead of the ribbon (JP-462).**
 * Every control here drives an editor that is already `editable: false` on a
 * read-only document, so nothing was ever corrupted — but offering someone
 * sixty-odd formatting controls that silently do nothing is its own failure, and
 * it answers the wrong question. A viewer's first question is "can I edit this?";
 * a dead ribbon makes them discover the answer by clicking. This surface is now
 * the *shared* experience too — anyone arriving on a share link is a viewer.
 *
 * Hiding rather than disabling: a viewer has no use for formatting controls, and
 * `disabled` on sixty-three buttons is more code that communicates less. The
 * canvas side (`CanvasToolbar`) has gated on read-only since JP-370; this closes
 * the asymmetry.
 *
 * **A mirror page gets the mirror banner instead (DSK-193).** Mirror pages are
 * read-only page by page, which the document-level check above never saw, so
 * they kept a ribbon of dead controls. The banner names the source, says when
 * it last synced, and carries Refresh, Open and Detach.
 */

import { useState, useEffect, useCallback, useMemo, useRef, type ChangeEvent } from 'react';
import { formatCombo } from '../engine/keybindings';
import { createPortal } from 'react-dom';
import {
  Bold, Italic, Underline, Strikethrough, Code, Subscript, Superscript,
  Highlighter, RemoveFormatting, List, ListOrdered, ListTodo, Quote, SquareCode,
  Link, AlignLeft, AlignCenter, AlignRight, AlignJustify,
  Table, Sigma, SquareSigma, Minus, Search, Settings2, PaintBucket, Trash2,
  BookMarked, Library, Info, Braces,
  BetweenVerticalStart, BetweenVerticalEnd, BetweenHorizontalStart, BetweenHorizontalEnd,
  ArrowLeft, ArrowRight, ArrowUp, ArrowDown, Eye, X, Undo2, Redo2, ImageUp,
} from 'lucide-react';
import type { CalloutVariant } from '../tiptap/CalloutExtension';
import { useTiptapEditor } from './TiptapEditorContext';
import { useActiveDocReadOnly } from '../store/documentRegistry';
import { useActivePageMirror, useRichTextPagesStore } from '../store/richTextPagesStore';
import { MirrorBanner } from './integrations/MirrorBanner';
import * as cmd from './editorCommands';
import { registerSlashUiHandler } from '../tiptap/slashCommands';
import { replaceSelectedImageWithFile, selectedImage } from './proseImageActions';
import { IMAGE_FILE_ACCEPT } from './proseImageUpload';
import { ImageUploadButton } from './ImageUploadButton';
import { FileUploadButton } from './FileUploadButton';
import { GalleryUploadButton } from './GalleryUploadButton';
import { SearchReplacePanel } from './SearchReplacePanel';
import { ToolbarDropdown } from './ToolbarDropdown';
import { ColorPicker, type ColorSpecial } from './color/ColorPicker';
import { RichSelect, type RichSelectItem } from './components/RichSelect';
import { InsertLinkDialog } from './InsertLinkDialog';
import { CitationPickerDialog } from './CitationPickerDialog';
import { ReferenceManagerDialog } from './ReferenceManagerDialog';
import { FieldsManagerDialog } from './FieldsManagerDialog';
import { useNotificationStore } from '../store/notificationStore';
import { useUIPreferencesStore } from '../store/uiPreferencesStore';
import { isGuestSession } from '../guest/guestSession';
import { ICON } from './icons';
import './DocumentEditorToolbar.css';

/** Home and Insert are always there; Table and Image only in their context. */
type PlainTab = 'home' | 'insert';
type RibbonTab = PlainTab | 'table' | 'image';

const TAB_LABELS: Record<RibbonTab, string> = { home: 'Home', insert: 'Insert', table: 'Table', image: 'Image' };

/** The text-level select values. */
type HeadingValue = 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

/**
 * Text-level options for the heading RichSelect. Each entry renders its label
 * styled as the level it sets, so the menu previews the result (JP-149).
 */
const HEADING_ITEMS: RichSelectItem<HeadingValue>[] = (
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

/**
 * How long the "View only" notice stays up before retiring itself (JP-464).
 * Long enough to read and register on a page you just opened; short enough
 * that it isn't a permanent toolbar row restating something the absence of
 * every editing control already says.
 */
const VIEW_ONLY_NOTICE_MS = 30_000;

export function DocumentEditorToolbar() {
  const editor = useTiptapEditor();
  const docReadOnly = useActiveDocReadOnly();
  const activeMirror = useActivePageMirror();
  const activePageId = useRichTextPagesStore((s) => s.activePageId);
  const viewOnlyNoticeDismissed = useUIPreferencesStore((s) => s.viewOnlyNoticeDismissed);
  const dismissViewOnlyNotice = useUIPreferencesStore((s) => s.dismissViewOnlyNotice);
  const [viewOnlyNoticeExpired, setViewOnlyNoticeExpired] = useState(false);

  // Start the retire timer when the notice actually becomes visible, and reset
  // it if the document flips back to editable — so re-entering a read-only doc
  // shows it again (unless permanently dismissed).
  useEffect(() => {
    if (!docReadOnly) {
      setViewOnlyNoticeExpired(false);
      return;
    }
    const timer = setTimeout(() => setViewOnlyNoticeExpired(true), VIEW_ONLY_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [docReadOnly]);
  const [, forceUpdate] = useState({});
  // The tab you chose, and the plain tab to go back to when a contextual tab's
  // context ends.
  const [chosenTab, setChosenTab] = useState<RibbonTab>('home');
  const [lastPlainTab, setLastPlainTab] = useState<PlainTab>('home');

  // Modal states
  const [showMathInput, setShowMathInput] = useState(false);
  const [mathInput, setMathInput] = useState('');
  const [mathIsBlock, setMathIsBlock] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState<'text' | 'highlight' | null>(null);
  const [showTableStyles, setShowTableStyles] = useState(false);
  const [showCellBgColor, setShowCellBgColor] = useState(false);
  const [showSearchReplace, setShowSearchReplace] = useState(false);
  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [showCitationPicker, setShowCitationPicker] = useState(false);
  const [showRefManager, setShowRefManager] = useState(false);
  const [showFieldsManager, setShowFieldsManager] = useState(false);
  const [showCalloutMenu, setShowCalloutMenu] = useState(false);

  const CALLOUT_VARIANTS: { value: CalloutVariant; label: string }[] = [
    { value: 'note', label: 'Note' },
    { value: 'tip', label: 'Tip' },
    { value: 'warning', label: 'Warning' },
    { value: 'danger', label: 'Danger' },
  ];

  // Let the `/citation` slash command open the citation picker (the picker is
  // React UI outside the editor). No-op headless: nothing registered.
  useEffect(() => registerSlashUiHandler('citation', () => setShowCitationPicker(true)), []);
  useEffect(() => registerSlashUiHandler('field', () => setShowFieldsManager(true)), []);

  // Subscribe to editor events for toolbar state updates
  useEffect(() => {
    if (!editor) return;

    const handleUpdate = () => forceUpdate({});
    editor.on('selectionUpdate', handleUpdate);
    editor.on('transaction', handleUpdate);

    return () => {
      editor.off('selectionUpdate', handleUpdate);
      editor.off('transaction', handleUpdate);
    };
  }, [editor]);

  // Contextual tabs exist only while the selection is in a table or on an
  // image. They're never chosen for you (DSK-27: the ribbon used to jump to
  // Table whenever the caret entered one); when the context ends, the ribbon
  // goes back to the plain tab you were on, so returning to a table later
  // doesn't take you to its tab again.
  const isInTable = editor?.isActive('table') ?? false;
  const image = editor ? selectedImage(editor.state) : null;
  const tabs: RibbonTab[] = ['home', 'insert'];
  if (isInTable) tabs.push('table');
  if (image) tabs.push('image');
  if (!tabs.includes(chosenTab)) setChosenTab(lastPlainTab);
  const activeTab = tabs.includes(chosenTab) ? chosenTab : lastPlainTab;
  const chooseTab = (tab: RibbonTab) => {
    setChosenTab(tab);
    if (tab === 'home' || tab === 'insert') setLastPlainTab(tab);
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'h')) {
        e.preventDefault();
        setShowSearchReplace(true);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Colour handlers. These deliberately do NOT close the dropdown: the shared
  // picker's saturation area emits continuously while dragged, so closing on
  // change would dismiss it on the first pixel of a drag. Clearing a colour
  // (the "specials" below) is a terminal choice, so those do close.
  const handleSetTextColor = useCallback((color: string) => {
    if (editor) cmd.setTextColor(editor, color);
  }, [editor]);

  const handleSetHighlight = useCallback((color: string) => {
    if (editor) cmd.setHighlight(editor, color);
  }, [editor]);

  const handleSetCellBg = useCallback((color: string) => {
    if (editor) cmd.setCellBackground(editor, color);
  }, [editor]);

  // The Image tab's Replace: the same swap as the context menu's. The image
  // stays selected while the file picker is open, so the swap finds it.
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const handleReplaceImage = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file || !editor) return;
      try {
        await replaceSelectedImageWithFile(editor, file);
      } catch (err) {
        console.error('Failed to replace image:', err);
      }
    },
    [editor]
  );

  /**
   * Read a colour attribute off the current selection, so each picker's hex
   * field opens showing the colour actually in effect.
   */
  const attrColor = useCallback(
    (nodeOrMark: string, key: string): string => {
      if (!editor) return '';
      const raw: unknown = editor.getAttributes(nodeOrMark)[key];
      return typeof raw === 'string' ? raw : '';
    },
    [editor]
  );

  const textColor = attrColor('textStyle', 'color');
  const highlightColor = attrColor('highlight', 'color');
  const cellBgColor =
    attrColor('tableCell', 'backgroundColor') || attrColor('tableHeader', 'backgroundColor');

  // "Clear this colour" as the first entry of every picker, so the affordance
  // sits in the same place on every surface. Each passes its own command —
  // prose clears a *mark*, which has no sentinel value to write.
  const textColorSpecials = useMemo<ColorSpecial[]>(
    () => [
      {
        id: 'default',
        label: 'Default',
        swatch: 'auto',
        isActive: !textColor,
        onSelect: () => {
          if (editor) cmd.unsetTextColor(editor);
          setShowColorPicker(null);
        },
        hint: "Back to the document's body colour, leaving bold, italic and links untouched.",
      },
    ],
    [editor, textColor]
  );

  const highlightSpecials = useMemo<ColorSpecial[]>(
    () => [
      {
        id: 'none',
        label: 'No highlight',
        swatch: 'none',
        isActive: !highlightColor,
        onSelect: () => {
          if (editor) cmd.unsetHighlight(editor);
          setShowColorPicker(null);
        },
      },
    ],
    [editor, highlightColor]
  );

  const cellBgSpecials = useMemo<ColorSpecial[]>(
    () => [
      {
        id: 'none',
        label: 'No background',
        swatch: 'none',
        isActive: !cellBgColor,
        onSelect: () => {
          if (editor) cmd.setCellBackground(editor, null);
          setShowCellBgColor(false);
        },
      },
    ],
    [editor, cellBgColor]
  );

  // Math handlers
  const openMathInput = useCallback((isBlock: boolean) => {
    setMathIsBlock(isBlock);
    setMathInput('');
    setShowMathInput(true);
  }, []);

  // Citations (JP-89): insert a bibliography, but only one per document.
  const insertBibliographyOnce = useCallback(() => {
    if (!editor) return;
    let exists = false;
    editor.state.doc.descendants((n) => {
      if (n.type.name === 'bibliography') exists = true;
    });
    if (exists) {
      useNotificationStore.getState().info('Bibliography already added');
      return;
    }
    cmd.insertBibliography(editor);
  }, [editor]);

  const insertMath = useCallback(() => {
    if (!mathInput.trim() || !editor) return;
    if (mathIsBlock) {
      cmd.setMathBlock(editor, mathInput);
    } else {
      cmd.setMathInline(editor, mathInput);
    }
    setShowMathInput(false);
    setMathInput('');
  }, [editor, mathInput, mathIsBlock]);

  // Heading select value
  const headingValue =
    editor?.isActive('heading', { level: 1 }) ? 'h1' :
    editor?.isActive('heading', { level: 2 }) ? 'h2' :
    editor?.isActive('heading', { level: 3 }) ? 'h3' :
    editor?.isActive('heading', { level: 4 }) ? 'h4' :
    editor?.isActive('heading', { level: 5 }) ? 'h5' :
    editor?.isActive('heading', { level: 6 }) ? 'h6' : 'p';

  const isActive = (type: string, attrs?: Record<string, unknown>) =>
    editor?.isActive(type, attrs) ?? false;

  // Placed after every hook above — an early return before them would change
  // hook order between renders when a document's permission flips in place.
  if (docReadOnly) {
    // The notice explains a state the user discovers once; after that it is a
    // full toolbar row spent on a sentence. It retires itself after
    // VIEW_ONLY_NOTICE_MS, and the × retires it for good (JP-464). Read-only
    // itself is still evident everywhere else — no editing controls exist.
    if (viewOnlyNoticeDismissed || viewOnlyNoticeExpired) return null;
    return (
      <div className="document-editor-toolbar document-editor-toolbar--readonly">
        <div className="ribbon-readonly" role="status">
          <Eye size={14} aria-hidden="true" />
          {/* JP-464: a guest is reading a published snapshot by design — the
              permission framing reads as a denial to someone who was simply
              handed a link, and "permission" is meaningless with no account. */}
          <span>
            {isGuestSession()
              ? 'View only — a published snapshot of this document.'
              : 'View only — you don’t have permission to edit this document.'}
          </span>
          <button
            type="button"
            className="ribbon-readonly__dismiss"
            onClick={dismissViewOnlyNotice}
            title="Don’t show this again"
            aria-label="Dismiss view-only notice"
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }

  // A mirror page is read-only too, page by page (DSK-193). Say what it is and
  // what can be done with it, instead of offering a ribbon of dead controls.
  if (activeMirror && activePageId) {
    return <MirrorBanner pageId={activePageId} mirror={activeMirror} />;
  }

  return (
    <div className="document-editor-toolbar">
      <div className="ribbon-row">
        {/* Undo and redo first, where the canvas toolbar keeps them (DSK-200). */}
        <div className="document-editor-toolbar-group ribbon-history">
          <button className="document-editor-toolbar-btn" onClick={() => editor && cmd.undo(editor)} disabled={!editor || !cmd.canUndo(editor)} title={`Undo (${formatCombo('Mod+Z')})`} aria-label="Undo">
            <Undo2 {...ICON} />
          </button>
          <button className="document-editor-toolbar-btn" onClick={() => editor && cmd.redo(editor)} disabled={!editor || !cmd.canRedo(editor)} title={`Redo (${formatCombo('Mod+Shift+Z')})`} aria-label="Redo">
            <Redo2 {...ICON} />
          </button>
        </div>

        <div className="ribbon-tabs" role="tablist" aria-label="Ribbon">
          {tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              className={`ribbon-tab${activeTab === tab ? ' active' : ''}${tab === 'table' || tab === 'image' ? ' ribbon-tab--contextual' : ''}`}
              onClick={() => chooseTab(tab)}
            >
              {TAB_LABELS[tab]}
            </button>
          ))}
        </div>

        {/* === HOME TAB === */}
        {activeTab === 'home' && (
          <div className="ribbon-panel-content" role="tabpanel">
            {/* Heading dropdown — rich select, each entry styled as its level */}
            <div className="document-editor-toolbar-group">
              <RichSelect<HeadingValue>
                value={headingValue}
                onChange={(value) => {
                  if (!editor) return;
                  if (value === 'p') cmd.setParagraph(editor);
                  else cmd.setHeading(editor, parseInt(value.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6);
                }}
                items={HEADING_ITEMS}
                hoverOpen
                ariaLabel="Text style"
                minWidth={132}
              />
            </div>


            {/* Text formatting */}
            <div className="document-editor-toolbar-group">
              <button className={`document-editor-toolbar-btn ${isActive('bold') ? 'active' : ''}`} onClick={() => editor && cmd.toggleBold(editor)} title={`Bold (${formatCombo('Mod+B')})`} aria-label="Bold">
                <Bold {...ICON} />
              </button>
              <button className={`document-editor-toolbar-btn ${isActive('italic') ? 'active' : ''}`} onClick={() => editor && cmd.toggleItalic(editor)} title={`Italic (${formatCombo('Mod+I')})`} aria-label="Italic">
                <Italic {...ICON} />
              </button>
              <button className={`document-editor-toolbar-btn ${isActive('underline') ? 'active' : ''}`} onClick={() => editor && cmd.toggleUnderline(editor)} title={`Underline (${formatCombo('Mod+U')})`} aria-label="Underline">
                <Underline {...ICON} />
              </button>
              <button className={`document-editor-toolbar-btn ${isActive('strike') ? 'active' : ''}`} onClick={() => editor && cmd.toggleStrike(editor)} title="Strikethrough" aria-label="Strikethrough">
                <Strikethrough {...ICON} />
              </button>
              <button className={`document-editor-toolbar-btn ${isActive('code') ? 'active' : ''}`} onClick={() => editor && cmd.toggleCode(editor)} title="Inline Code" aria-label="Inline code">
                <Code {...ICON} />
              </button>
            </div>


            {/* Subscript/Superscript */}
            <div className="document-editor-toolbar-group">
              <button className={`document-editor-toolbar-btn ${isActive('subscript') ? 'active' : ''}`} onClick={() => editor && cmd.toggleSubscript(editor)} title="Subscript" aria-label="Subscript">
                <Subscript {...ICON} />
              </button>
              <button className={`document-editor-toolbar-btn ${isActive('superscript') ? 'active' : ''}`} onClick={() => editor && cmd.toggleSuperscript(editor)} title="Superscript" aria-label="Superscript">
                <Superscript {...ICON} />
              </button>
            </div>


            {/* Color controls */}
            <div className="document-editor-toolbar-group">
              <ToolbarDropdown
                trigger={<span className="color-btn-icon">A<span className="color-underline" style={{ background: 'var(--text-primary)' }} /></span>}
                isOpen={showColorPicker === 'text'}
                onToggle={() => setShowColorPicker(showColorPicker === 'text' ? null : 'text')}
                onClose={() => setShowColorPicker(null)}
                triggerClassName="document-editor-toolbar-btn"
                title="Text Color"
              >
                {/* Contrast is measured against white: a document's legibility
                    that matters is on the printed/exported page, which is white
                    regardless of the app's current theme. */}
                <ColorPicker
                  value={textColor}
                  onChange={handleSetTextColor}
                  preset="canvas"
                  specials={textColorSpecials}
                  contrastAgainst="#ffffff"
                  compact
                />
              </ToolbarDropdown>

              <ToolbarDropdown
                trigger={<span className="highlight-btn-icon"><Highlighter {...ICON} /></span>}
                isOpen={showColorPicker === 'highlight'}
                onToggle={() => setShowColorPicker(showColorPicker === 'highlight' ? null : 'highlight')}
                onClose={() => setShowColorPicker(null)}
                triggerClassName="document-editor-toolbar-btn"
                title="Highlight"
              >
                {/* Highlight sits *behind* body text, so contrast is measured
                    against black — the colour that has to stay readable on it. */}
                <ColorPicker
                  value={highlightColor}
                  onChange={handleSetHighlight}
                  preset="highlight"
                  specials={highlightSpecials}
                  contrastAgainst="#000000"
                  compact
                />
              </ToolbarDropdown>

              <button className="document-editor-toolbar-btn" onClick={() => editor && cmd.clearFormatting(editor)} title="Clear Formatting" aria-label="Clear formatting">
                <RemoveFormatting {...ICON} />
              </button>
            </div>


            {/* Lists & Blockquote */}
            <div className="document-editor-toolbar-group">
              <button className={`document-editor-toolbar-btn ${isActive('bulletList') ? 'active' : ''}`} onClick={() => editor && cmd.toggleBulletList(editor)} title="Bullet List" aria-label="Bullet list">
                <List {...ICON} />
              </button>
              <button className={`document-editor-toolbar-btn ${isActive('orderedList') ? 'active' : ''}`} onClick={() => editor && cmd.toggleOrderedList(editor)} title="Numbered List" aria-label="Numbered list">
                <ListOrdered {...ICON} />
              </button>
              <button className={`document-editor-toolbar-btn ${isActive('taskList') ? 'active' : ''}`} onClick={() => editor && cmd.toggleTaskList(editor)} title="Task List" aria-label="Task list">
                <ListTodo {...ICON} />
              </button>
              <button className={`document-editor-toolbar-btn ${isActive('blockquote') ? 'active' : ''}`} onClick={() => editor && cmd.toggleBlockquote(editor)} title="Block Quote" aria-label="Block quote">
                <Quote {...ICON} />
              </button>
              <button className={`document-editor-toolbar-btn ${isActive('codeBlock') ? 'active' : ''}`} onClick={() => editor && cmd.toggleCodeBlock(editor)} title="Code Block" aria-label="Code block">
                <SquareCode {...ICON} />
              </button>
              <button className={`document-editor-toolbar-btn ${isActive('link') ? 'active' : ''}`} onClick={() => editor && setShowLinkDialog(true)} title="Insert / Edit Link" aria-label="Insert or edit link">
                <Link {...ICON} />
              </button>
            </div>


            {/* Text Alignment */}
            <div className="document-editor-toolbar-group">
              <button className={`document-editor-toolbar-btn ${editor?.isActive({ textAlign: 'left' }) ? 'active' : ''}`} onClick={() => editor && cmd.setTextAlign(editor, 'left')} title="Align Left" aria-label="Align left">
                <AlignLeft {...ICON} />
              </button>
              <button className={`document-editor-toolbar-btn ${editor?.isActive({ textAlign: 'center' }) ? 'active' : ''}`} onClick={() => editor && cmd.setTextAlign(editor, 'center')} title="Align Center" aria-label="Align center">
                <AlignCenter {...ICON} />
              </button>
              <button className={`document-editor-toolbar-btn ${editor?.isActive({ textAlign: 'right' }) ? 'active' : ''}`} onClick={() => editor && cmd.setTextAlign(editor, 'right')} title="Align Right" aria-label="Align right">
                <AlignRight {...ICON} />
              </button>
              <button className={`document-editor-toolbar-btn ${editor?.isActive({ textAlign: 'justify' }) ? 'active' : ''}`} onClick={() => editor && cmd.setTextAlign(editor, 'justify')} title="Justify" aria-label="Justify">
                <AlignJustify {...ICON} />
              </button>
            </div>
          </div>
        )}

        {/* === INSERT TAB === — kept mounted, and hidden while another tab
            shows: its upload buttons register the /image, /file and /gallery
            commands, which did nothing whenever Insert wasn't open. */}
        <div className="ribbon-panel-content" role="tabpanel" hidden={activeTab !== 'insert'}>
            {/* Table insert */}
            <div className="document-editor-toolbar-group">
              <button className="document-editor-toolbar-btn" onClick={() => editor && cmd.insertTable(editor)} title="Insert Table" aria-label="Insert table">
                <Table {...ICON} />
              </button>
            </div>


            {/* Math/LaTeX */}
            <div className="document-editor-toolbar-group">
              <button className="document-editor-toolbar-btn" onClick={() => openMathInput(false)} title="Insert Inline Equation ($...$)" aria-label="Insert inline equation">
                <Sigma {...ICON} />
              </button>
              <button className="document-editor-toolbar-btn" onClick={() => openMathInput(true)} title="Insert Block Equation ($$...$$)" aria-label="Insert block equation">
                <SquareSigma {...ICON} />
              </button>
            </div>


            {/* Media */}
            <div className="document-editor-toolbar-group">
              <ImageUploadButton className="document-editor-toolbar-btn" />
              <FileUploadButton className="document-editor-toolbar-btn" />
              <GalleryUploadButton className="document-editor-toolbar-btn" />
              <button className="document-editor-toolbar-btn" onClick={() => editor && cmd.insertHorizontalRule(editor)} title="Horizontal Rule" aria-label="Horizontal rule">
                <Minus {...ICON} />
              </button>
            </div>


            {/* Blocks */}
            <div className="document-editor-toolbar-group">
              <ToolbarDropdown
                trigger={<Info {...ICON} />}
                isOpen={showCalloutMenu}
                onToggle={() => setShowCalloutMenu(!showCalloutMenu)}
                onClose={() => setShowCalloutMenu(false)}
                triggerClassName="document-editor-toolbar-btn"
                title="Insert Callout"
                isActive={isActive('callout')}
              >
                <div className="callout-variant-menu">
                  {CALLOUT_VARIANTS.map(({ value, label }) => (
                    <button key={value} onClick={() => { if (editor) cmd.setCallout(editor, value); setShowCalloutMenu(false); }}>
                      {label}
                    </button>
                  ))}
                </div>
              </ToolbarDropdown>
            </div>


            {/* Citations (JP-89) */}
            <div className="document-editor-toolbar-group">
              <button className="document-editor-toolbar-btn" onClick={() => editor && setShowCitationPicker(true)} title="Insert Citation" aria-label="Insert citation">
                <Quote {...ICON} />
              </button>
              <button className="document-editor-toolbar-btn" onClick={insertBibliographyOnce} title="Insert Bibliography" aria-label="Insert bibliography">
                <BookMarked {...ICON} />
              </button>
              <button className="document-editor-toolbar-btn" onClick={() => setShowRefManager(true)} title="Manage References" aria-label="Manage references">
                <Library {...ICON} />
              </button>
            </div>

            {/* Document Fields (Phase 3) */}
            <div className="document-editor-toolbar-group">
              <button className="document-editor-toolbar-btn" onClick={() => editor && setShowFieldsManager(true)} title="Fields (insert {{value}})" aria-label="Fields">
                <Braces {...ICON} />
              </button>
            </div>


        </div>

        {/* === TABLE TAB (contextual) === */}
        {activeTab === 'table' && (
          <div className="ribbon-panel-content" role="tabpanel">


            {/* Columns - disabled when not in table */}
            <div className="document-editor-toolbar-group">
              <button className="document-editor-toolbar-btn" onClick={() => editor && cmd.addColumnBefore(editor)} title="Insert column left" aria-label="Insert column left">
                <BetweenVerticalStart {...ICON} />
              </button>
              <button className="document-editor-toolbar-btn" onClick={() => editor && cmd.addColumnAfter(editor)} title="Insert column right" aria-label="Insert column right">
                <BetweenVerticalEnd {...ICON} />
              </button>
              <button className="document-editor-toolbar-btn" onClick={() => editor && cmd.moveColumnLeft(editor)} title="Move column left" aria-label="Move column left">
                <ArrowLeft {...ICON} />
              </button>
              <button className="document-editor-toolbar-btn" onClick={() => editor && cmd.moveColumnRight(editor)} title="Move column right" aria-label="Move column right">
                <ArrowRight {...ICON} />
              </button>
              <button className="document-editor-toolbar-btn" onClick={() => editor && cmd.deleteColumn(editor)} title="Delete column" aria-label="Delete column">
                <span className="toolbar-icon">-⇥</span>
              </button>
            </div>

            {/* Rows - disabled when not in table */}
            <div className="document-editor-toolbar-group">
              <button className="document-editor-toolbar-btn" onClick={() => editor && cmd.addRowBefore(editor)} title="Insert row above" aria-label="Insert row above">
                <BetweenHorizontalStart {...ICON} />
              </button>
              <button className="document-editor-toolbar-btn" onClick={() => editor && cmd.addRowAfter(editor)} title="Insert row below" aria-label="Insert row below">
                <BetweenHorizontalEnd {...ICON} />
              </button>
              <button className="document-editor-toolbar-btn" onClick={() => editor && cmd.moveRowUp(editor)} title="Move row up" aria-label="Move row up">
                <ArrowUp {...ICON} />
              </button>
              <button className="document-editor-toolbar-btn" onClick={() => editor && cmd.moveRowDown(editor)} title="Move row down" aria-label="Move row down">
                <ArrowDown {...ICON} />
              </button>
              <button className="document-editor-toolbar-btn" onClick={() => editor && cmd.deleteRow(editor)} title="Delete row" aria-label="Delete row">
                <span className="toolbar-icon">-↓</span>
              </button>
            </div>


            {/* Options - disabled when not in table */}
            <div className="document-editor-toolbar-group">
              <ToolbarDropdown
                trigger={<Settings2 {...ICON} />}
                isOpen={showTableStyles}
                onToggle={() => setShowTableStyles(!showTableStyles)}
                onClose={() => setShowTableStyles(false)}
                triggerClassName="document-editor-toolbar-btn"
                title="Table Options"
              >
                <div className="table-styles-menu">
                  <button onClick={() => { editor && cmd.selectRow(editor); setShowTableStyles(false); }}>Select Row</button>
                  <button onClick={() => { editor && cmd.selectColumn(editor); setShowTableStyles(false); }}>Select Column</button>
                  <button onClick={() => { editor && cmd.selectAllCells(editor); setShowTableStyles(false); }}>Select All Cells</button>
                  <button onClick={() => { editor && cmd.toggleHeaderRow(editor); setShowTableStyles(false); }}>Toggle Header Row</button>
                  <button onClick={() => { editor && cmd.toggleHeaderColumn(editor); setShowTableStyles(false); }}>Toggle Header Column</button>
                  <button onClick={() => { editor && cmd.mergeCells(editor); setShowTableStyles(false); }}>Merge Cells</button>
                  <button onClick={() => { editor && cmd.splitCell(editor); setShowTableStyles(false); }}>Split Cell</button>
                  <button onClick={() => { editor && cmd.mergeOrSplit(editor); setShowTableStyles(false); }}>Merge / Split (toggle)</button>
                </div>
              </ToolbarDropdown>
              <ToolbarDropdown
                trigger={<PaintBucket {...ICON} />}
                isOpen={showCellBgColor}
                onToggle={() => setShowCellBgColor(!showCellBgColor)}
                onClose={() => setShowCellBgColor(false)}
                triggerClassName="document-editor-toolbar-btn"
                title="Cell Background"
              >
                {/* Neutrals lead here: table styling is overwhelmingly header
                    greys and zebra tints, which the old highlighter palette
                    could not express at all. */}
                <ColorPicker
                  value={cellBgColor}
                  onChange={handleSetCellBg}
                  preset="document"
                  specials={cellBgSpecials}
                  contrastAgainst="#000000"
                  compact
                />
              </ToolbarDropdown>
            </div>


            {/* Cell alignment - disabled when not in table */}
            <div className="document-editor-toolbar-group">
              <button className="document-editor-toolbar-btn" onClick={() => editor && cmd.setCellAlign(editor, 'left')} title="Align left" aria-label="Align cell left">
                <AlignLeft {...ICON} />
              </button>
              <button className="document-editor-toolbar-btn" onClick={() => editor && cmd.setCellAlign(editor, 'center')} title="Align center" aria-label="Align cell center">
                <AlignCenter {...ICON} />
              </button>
              <button className="document-editor-toolbar-btn" onClick={() => editor && cmd.setCellAlign(editor, 'right')} title="Align right" aria-label="Align cell right">
                <AlignRight {...ICON} />
              </button>
            </div>


            {/* Delete table */}
            <div className="document-editor-toolbar-group">
              <button className="document-editor-toolbar-btn danger" onClick={() => editor && cmd.deleteTable(editor)} title="Delete Table" aria-label="Delete table">
                <Trash2 {...ICON} />
              </button>
            </div>
          </div>
        )}

        {/* === IMAGE TAB (contextual) === — the context menu's image actions. */}
        {activeTab === 'image' && image && (
          <div className="ribbon-panel-content" role="tabpanel">
            <div className="document-editor-toolbar-group">
              <button className="document-editor-toolbar-btn" onClick={() => replaceInputRef.current?.click()} title="Replace image" aria-label="Replace image">
                <ImageUp {...ICON} />
              </button>
              <input ref={replaceInputRef} type="file" accept={IMAGE_FILE_ACCEPT} onChange={handleReplaceImage} hidden aria-hidden="true" tabIndex={-1} />
            </div>
            {image.inGallery && (
              <div className="document-editor-toolbar-group">
                <button className="document-editor-toolbar-btn" onClick={() => editor?.commands.moveGalleryImage(-1)} disabled={!image.canLeft} title="Move image left" aria-label="Move image left">
                  <ArrowLeft {...ICON} />
                </button>
                <button className="document-editor-toolbar-btn" onClick={() => editor?.commands.moveGalleryImage(1)} disabled={!image.canRight} title="Move image right" aria-label="Move image right">
                  <ArrowRight {...ICON} />
                </button>
              </div>
            )}
            <div className="document-editor-toolbar-group">
              <button className="document-editor-toolbar-btn danger" onClick={() => editor?.commands.removeSelectedImage()} title="Remove image" aria-label="Remove image">
                <Trash2 {...ICON} />
              </button>
            </div>
          </div>
        )}

        {/* Find, at the end of the row. */}
        <div className="document-editor-toolbar-group ribbon-end">
          <button className={`document-editor-toolbar-btn ${showSearchReplace ? 'active' : ''}`} onClick={() => setShowSearchReplace(!showSearchReplace)} title={`Find & Replace (${formatCombo('Mod+F')})`} aria-label="Find and replace">
            <Search {...ICON} />
          </button>
        </div>
      </div>

      {/* Math input modal (portal) */}
      {showMathInput && createPortal(
        <div className="math-input-modal" onClick={() => setShowMathInput(false)}>
          <div className="math-input-content" onClick={(e) => e.stopPropagation()}>
            <label>
              {mathIsBlock ? 'Block Equation (LaTeX):' : 'Inline Equation (LaTeX):'}
            </label>
            {mathIsBlock ? (
              <textarea
                value={mathInput}
                onChange={(e) => setMathInput(e.target.value)}
                placeholder={'\\int_0^\\infty e^{-x} dx\n\n\\frac{d}{dx} \\sin(x) = \\cos(x)'}
                autoFocus
                rows={4}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) insertMath();
                  else if (e.key === 'Escape') setShowMathInput(false);
                }}
              />
            ) : (
              <input
                type="text"
                value={mathInput}
                onChange={(e) => setMathInput(e.target.value)}
                placeholder="x^2 + y^2 = z^2"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') insertMath();
                  else if (e.key === 'Escape') setShowMathInput(false);
                }}
              />
            )}
            <div className="math-input-hint">
              {mathIsBlock ? `Press ${formatCombo('Mod+Enter')} to insert, Escape to cancel` : 'Press Enter to insert, Escape to cancel'}
            </div>
            <div className="math-input-actions">
              <button onClick={() => setShowMathInput(false)}>Cancel</button>
              <button onClick={insertMath} className="primary">Insert</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Insert Link Dialog */}
      {showLinkDialog && editor && (
        <InsertLinkDialog editor={editor} onClose={() => setShowLinkDialog(false)} />
      )}

      {/* Citations (JP-89) */}
      {showCitationPicker && editor && (
        <CitationPickerDialog
          editor={editor}
          onClose={() => setShowCitationPicker(false)}
          onManageReferences={() => setShowRefManager(true)}
        />
      )}
      {showRefManager && (
        <ReferenceManagerDialog onClose={() => setShowRefManager(false)} />
      )}

      {/* Document Fields (Phase 3) */}
      {showFieldsManager && editor && (
        <FieldsManagerDialog editor={editor} onClose={() => setShowFieldsManager(false)} />
      )}

      {/* Search & Replace Panel */}
      {showSearchReplace && editor && (
        <SearchReplacePanel
          editor={editor}
          onClose={() => setShowSearchReplace(false)}
        />
      )}
    </div>
  );
}
