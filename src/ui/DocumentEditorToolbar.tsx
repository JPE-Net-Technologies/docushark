/**
 * DocumentEditorToolbar - Ribbon-style formatting toolbar for the rich text editor.
 *
 * Organized into 3 tabs:
 * - Home: Text formatting, colors, lists, alignment
 * - Insert: Tables, math, images, search
 * - Table: Table-specific tools (always visible, tools enabled when in table)
 */

import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  Bold, Italic, Underline, Strikethrough, Code, Subscript, Superscript,
  Highlighter, RemoveFormatting, List, ListOrdered, ListTodo, Quote, SquareCode,
  Link, AlignLeft, AlignCenter, AlignRight, AlignJustify,
  Table, Sigma, SquareSigma, Minus, Search, Settings2, PaintBucket, Trash2,
  BookMarked, Library, Info, Braces,
  BetweenVerticalStart, BetweenVerticalEnd, BetweenHorizontalStart, BetweenHorizontalEnd,
  ArrowLeft, ArrowRight, ArrowUp, ArrowDown,
} from 'lucide-react';
import type { CalloutVariant } from '../tiptap/CalloutExtension';
import { useTiptapEditor } from './TiptapEditorContext';
import * as cmd from './editorCommands';
import { registerSlashUiHandler } from '../tiptap/slashCommands';
import { ImageUploadButton } from './ImageUploadButton';
import { GalleryUploadButton } from './GalleryUploadButton';
import { SearchReplacePanel } from './SearchReplacePanel';
import { ToolbarDropdown } from './ToolbarDropdown';
import { RichSelect, type RichSelectItem } from './components/RichSelect';
import { InsertLinkDialog } from './InsertLinkDialog';
import { CitationPickerDialog } from './CitationPickerDialog';
import { ReferenceManagerDialog } from './ReferenceManagerDialog';
import { FieldsManagerDialog } from './FieldsManagerDialog';
import { useNotificationStore } from '../store/notificationStore';
import { ICON } from './icons';
import './DocumentEditorToolbar.css';

/** Color palette for text and highlight colors */
const COLOR_PALETTE = [
  '#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#efefef', '#f3f3f3', '#ffffff',
  '#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff',
  '#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc',
  '#dd7e6b', '#ea9999', '#f9cb9c', '#ffe599', '#b6d7a8', '#a2c4c9', '#a4c2f4', '#9fc5e8', '#b4a7d6', '#d5a6bd',
];

const HIGHLIGHT_PALETTE = [
  '#ffff00', '#00ff00', '#00ffff', '#ff00ff', '#ff0000', '#0000ff',
  '#fff2cc', '#d9ead3', '#d0e0e3', '#cfe2f3', '#d9d2e9', '#ead1dc',
];

type RibbonTab = 'home' | 'insert' | 'table';

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

export function DocumentEditorToolbar() {
  const editor = useTiptapEditor();
  const [, forceUpdate] = useState({});
  const [activeTab, setActiveTab] = useState<RibbonTab>('home');

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

  // Auto-switch to Table tab when cursor enters a table
  const isInTable = editor?.isActive('table') ?? false;
  useEffect(() => {
    if (isInTable) {
      setActiveTab('table');
    }
  }, [isInTable]);

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

  // Color handlers that also close the picker
  const handleSetTextColor = useCallback((color: string) => {
    if (editor) cmd.setTextColor(editor, color);
    setShowColorPicker(null);
  }, [editor]);

  const handleSetHighlight = useCallback((color: string) => {
    if (editor) cmd.setHighlight(editor, color);
    setShowColorPicker(null);
  }, [editor]);

  const handleSetCellBg = useCallback((color: string | null) => {
    if (editor) cmd.setCellBackground(editor, color);
    setShowCellBgColor(false);
  }, [editor]);

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

  return (
    <div className="document-editor-toolbar">
      {/* Ribbon tab bar */}
      <div className="ribbon-tab-bar">
        <button
          className={`ribbon-tab ${activeTab === 'home' ? 'active' : ''}`}
          onClick={() => setActiveTab('home')}
        >
          Home
        </button>
        <button
          className={`ribbon-tab ${activeTab === 'insert' ? 'active' : ''}`}
          onClick={() => setActiveTab('insert')}
        >
          Insert
        </button>
        <button
          className={`ribbon-tab ${activeTab === 'table' ? 'active' : ''}`}
          onClick={() => setActiveTab('table')}
        >
          Table
        </button>
      </div>

      {/* Ribbon panel */}
      <div className="ribbon-panel">

        {/* === HOME TAB === */}
        {activeTab === 'home' && (
          <div className="ribbon-panel-content">
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
              <button className={`document-editor-toolbar-btn ${isActive('bold') ? 'active' : ''}`} onClick={() => editor && cmd.toggleBold(editor)} title="Bold (Ctrl+B)" aria-label="Bold">
                <Bold {...ICON} />
              </button>
              <button className={`document-editor-toolbar-btn ${isActive('italic') ? 'active' : ''}`} onClick={() => editor && cmd.toggleItalic(editor)} title="Italic (Ctrl+I)" aria-label="Italic">
                <Italic {...ICON} />
              </button>
              <button className={`document-editor-toolbar-btn ${isActive('underline') ? 'active' : ''}`} onClick={() => editor && cmd.toggleUnderline(editor)} title="Underline (Ctrl+U)" aria-label="Underline">
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
                <div className="color-picker-grid">
                  {COLOR_PALETTE.map((color) => (
                    <button key={color} className="color-picker-swatch" style={{ backgroundColor: color }} onClick={() => handleSetTextColor(color)} title={color} />
                  ))}
                </div>
              </ToolbarDropdown>

              <ToolbarDropdown
                trigger={<span className="highlight-btn-icon"><Highlighter {...ICON} /></span>}
                isOpen={showColorPicker === 'highlight'}
                onToggle={() => setShowColorPicker(showColorPicker === 'highlight' ? null : 'highlight')}
                onClose={() => setShowColorPicker(null)}
                triggerClassName="document-editor-toolbar-btn"
                title="Highlight"
              >
                <div className="color-picker-grid" style={{ gridTemplateColumns: 'repeat(6, 1fr)' }}>
                  {HIGHLIGHT_PALETTE.map((color) => (
                    <button key={color} className="color-picker-swatch" style={{ backgroundColor: color }} onClick={() => handleSetHighlight(color)} title={color} />
                  ))}
                </div>
                <button className="color-picker-clear" onClick={() => { if (editor) cmd.unsetHighlight(editor); setShowColorPicker(null); }}>
                  Remove Highlight
                </button>
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

        {/* === INSERT TAB === */}
        {activeTab === 'insert' && (
          <div className="ribbon-panel-content">
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


            {/* Search */}
            <div className="document-editor-toolbar-group">
              <button className={`document-editor-toolbar-btn ${showSearchReplace ? 'active' : ''}`} onClick={() => setShowSearchReplace(!showSearchReplace)} title="Search & Replace (Ctrl+F)" aria-label="Search and replace">
                <Search {...ICON} />
              </button>
            </div>
          </div>
        )}

        {/* === TABLE TAB === */}
        {activeTab === 'table' && (
          <div className="ribbon-panel-content">
            {/* Insert table - always active */}
            <div className="document-editor-toolbar-group">
              <button className="document-editor-toolbar-btn" onClick={() => editor && cmd.insertTable(editor)} title="Insert Table" aria-label="Insert table">
                <Table {...ICON} />
              </button>
            </div>


            {/* Columns - disabled when not in table */}
            <div className={`document-editor-toolbar-group ${!isInTable ? 'disabled-group' : ''}`}>
              <button className="document-editor-toolbar-btn" onClick={() => editor && isInTable && cmd.addColumnBefore(editor)} title="Insert column left" aria-label="Insert column left" disabled={!isInTable}>
                <BetweenVerticalStart {...ICON} />
              </button>
              <button className="document-editor-toolbar-btn" onClick={() => editor && isInTable && cmd.addColumnAfter(editor)} title="Insert column right" aria-label="Insert column right" disabled={!isInTable}>
                <BetweenVerticalEnd {...ICON} />
              </button>
              <button className="document-editor-toolbar-btn" onClick={() => editor && isInTable && cmd.moveColumnLeft(editor)} title="Move column left" aria-label="Move column left" disabled={!isInTable}>
                <ArrowLeft {...ICON} />
              </button>
              <button className="document-editor-toolbar-btn" onClick={() => editor && isInTable && cmd.moveColumnRight(editor)} title="Move column right" aria-label="Move column right" disabled={!isInTable}>
                <ArrowRight {...ICON} />
              </button>
              <button className="document-editor-toolbar-btn" onClick={() => editor && isInTable && cmd.deleteColumn(editor)} title="Delete column" aria-label="Delete column" disabled={!isInTable}>
                <span className="toolbar-icon">-⇥</span>
              </button>
            </div>

            {/* Rows - disabled when not in table */}
            <div className={`document-editor-toolbar-group ${!isInTable ? 'disabled-group' : ''}`}>
              <button className="document-editor-toolbar-btn" onClick={() => editor && isInTable && cmd.addRowBefore(editor)} title="Insert row above" aria-label="Insert row above" disabled={!isInTable}>
                <BetweenHorizontalStart {...ICON} />
              </button>
              <button className="document-editor-toolbar-btn" onClick={() => editor && isInTable && cmd.addRowAfter(editor)} title="Insert row below" aria-label="Insert row below" disabled={!isInTable}>
                <BetweenHorizontalEnd {...ICON} />
              </button>
              <button className="document-editor-toolbar-btn" onClick={() => editor && isInTable && cmd.moveRowUp(editor)} title="Move row up" aria-label="Move row up" disabled={!isInTable}>
                <ArrowUp {...ICON} />
              </button>
              <button className="document-editor-toolbar-btn" onClick={() => editor && isInTable && cmd.moveRowDown(editor)} title="Move row down" aria-label="Move row down" disabled={!isInTable}>
                <ArrowDown {...ICON} />
              </button>
              <button className="document-editor-toolbar-btn" onClick={() => editor && isInTable && cmd.deleteRow(editor)} title="Delete row" aria-label="Delete row" disabled={!isInTable}>
                <span className="toolbar-icon">-↓</span>
              </button>
            </div>


            {/* Options - disabled when not in table */}
            <div className={`document-editor-toolbar-group ${!isInTable ? 'disabled-group' : ''}`}>
              <ToolbarDropdown
                trigger={<Settings2 {...ICON} />}
                isOpen={showTableStyles}
                onToggle={() => isInTable && setShowTableStyles(!showTableStyles)}
                onClose={() => setShowTableStyles(false)}
                triggerClassName={`document-editor-toolbar-btn ${!isInTable ? 'disabled' : ''}`}
                title="Table Options"
              >
                <div className="table-styles-menu">
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
                onToggle={() => isInTable && setShowCellBgColor(!showCellBgColor)}
                onClose={() => setShowCellBgColor(false)}
                triggerClassName={`document-editor-toolbar-btn ${!isInTable ? 'disabled' : ''}`}
                title="Cell Background"
              >
                <div className="color-picker-grid" style={{ gridTemplateColumns: 'repeat(6, 1fr)' }}>
                  {HIGHLIGHT_PALETTE.map((color) => (
                    <button key={color} className="color-picker-swatch" style={{ backgroundColor: color }} onClick={() => handleSetCellBg(color)} title={color} />
                  ))}
                </div>
                <button className="color-picker-clear" onClick={() => handleSetCellBg(null)}>
                  Remove Background
                </button>
              </ToolbarDropdown>
            </div>


            {/* Delete table */}
            <div className={`document-editor-toolbar-group ${!isInTable ? 'disabled-group' : ''}`}>
              <button className="document-editor-toolbar-btn danger" onClick={() => editor && isInTable && cmd.deleteTable(editor)} title="Delete Table" disabled={!isInTable} aria-label="Delete table">
                <Trash2 {...ICON} />
              </button>
            </div>
          </div>
        )}
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
              {mathIsBlock ? 'Press Ctrl+Enter to insert, Escape to cancel' : 'Press Enter to insert, Escape to cancel'}
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
