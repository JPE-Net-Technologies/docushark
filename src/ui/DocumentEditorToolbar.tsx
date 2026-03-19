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
import { useTiptapEditor } from './TiptapEditorContext';
import * as cmd from './editorCommands';
import { ImageUploadButton } from './ImageUploadButton';
import { SearchReplacePanel } from './SearchReplacePanel';
import { ToolbarDropdown } from './ToolbarDropdown';
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
            {/* Heading dropdown */}
            <div className="document-editor-toolbar-group">
              <select
                className="document-editor-toolbar-select"
                value={headingValue}
                onChange={(e) => {
                  if (!editor) return;
                  const value = e.target.value;
                  if (value === 'p') cmd.setParagraph(editor);
                  else cmd.setHeading(editor, parseInt(value.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6);
                }}
              >
                <option value="p">Paragraph</option>
                <option value="h1">Heading 1</option>
                <option value="h2">Heading 2</option>
                <option value="h3">Heading 3</option>
                <option value="h4">Heading 4</option>
                <option value="h5">Heading 5</option>
                <option value="h6">Heading 6</option>
              </select>
            </div>

            <div className="document-editor-toolbar-divider" />

            {/* Text formatting */}
            <div className="document-editor-toolbar-group">
              <button className={`document-editor-toolbar-btn ${isActive('bold') ? 'active' : ''}`} onClick={() => editor && cmd.toggleBold(editor)} title="Bold (Ctrl+B)">
                <strong>B</strong>
              </button>
              <button className={`document-editor-toolbar-btn ${isActive('italic') ? 'active' : ''}`} onClick={() => editor && cmd.toggleItalic(editor)} title="Italic (Ctrl+I)">
                <em>I</em>
              </button>
              <button className={`document-editor-toolbar-btn ${isActive('underline') ? 'active' : ''}`} onClick={() => editor && cmd.toggleUnderline(editor)} title="Underline (Ctrl+U)">
                <span style={{ textDecoration: 'underline' }}>U</span>
              </button>
              <button className={`document-editor-toolbar-btn ${isActive('strike') ? 'active' : ''}`} onClick={() => editor && cmd.toggleStrike(editor)} title="Strikethrough">
                <span style={{ textDecoration: 'line-through' }}>S</span>
              </button>
              <button className={`document-editor-toolbar-btn ${isActive('code') ? 'active' : ''}`} onClick={() => editor && cmd.toggleCode(editor)} title="Inline Code">
                <code>&lt;/&gt;</code>
              </button>
            </div>

            <div className="document-editor-toolbar-divider" />

            {/* Subscript/Superscript */}
            <div className="document-editor-toolbar-group">
              <button className={`document-editor-toolbar-btn ${isActive('subscript') ? 'active' : ''}`} onClick={() => editor && cmd.toggleSubscript(editor)} title="Subscript">
                <span>X<sub>2</sub></span>
              </button>
              <button className={`document-editor-toolbar-btn ${isActive('superscript') ? 'active' : ''}`} onClick={() => editor && cmd.toggleSuperscript(editor)} title="Superscript">
                <span>X<sup>2</sup></span>
              </button>
            </div>

            <div className="document-editor-toolbar-divider" />

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
                trigger={<span className="highlight-btn-icon">🖍</span>}
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

              <button className="document-editor-toolbar-btn" onClick={() => editor && cmd.clearFormatting(editor)} title="Clear Formatting">
                <span className="toolbar-icon">⌫</span>
              </button>
            </div>

            <div className="document-editor-toolbar-divider" />

            {/* Lists & Blockquote */}
            <div className="document-editor-toolbar-group">
              <button className={`document-editor-toolbar-btn ${isActive('bulletList') ? 'active' : ''}`} onClick={() => editor && cmd.toggleBulletList(editor)} title="Bullet List">
                <span className="toolbar-icon">•≡</span>
              </button>
              <button className={`document-editor-toolbar-btn ${isActive('orderedList') ? 'active' : ''}`} onClick={() => editor && cmd.toggleOrderedList(editor)} title="Numbered List">
                <span className="toolbar-icon">1.</span>
              </button>
              <button className={`document-editor-toolbar-btn ${isActive('taskList') ? 'active' : ''}`} onClick={() => editor && cmd.toggleTaskList(editor)} title="Task List">
                <span className="toolbar-icon">☑</span>
              </button>
              <button className={`document-editor-toolbar-btn ${isActive('blockquote') ? 'active' : ''}`} onClick={() => editor && cmd.toggleBlockquote(editor)} title="Block Quote">
                <span className="toolbar-icon">❝</span>
              </button>
            </div>

            <div className="document-editor-toolbar-divider" />

            {/* Text Alignment */}
            <div className="document-editor-toolbar-group">
              <button className={`document-editor-toolbar-btn ${editor?.isActive({ textAlign: 'left' }) ? 'active' : ''}`} onClick={() => editor && cmd.setTextAlign(editor, 'left')} title="Align Left">
                <span className="align-icon align-left"><span /><span /><span /></span>
              </button>
              <button className={`document-editor-toolbar-btn ${editor?.isActive({ textAlign: 'center' }) ? 'active' : ''}`} onClick={() => editor && cmd.setTextAlign(editor, 'center')} title="Align Center">
                <span className="align-icon align-center"><span /><span /><span /></span>
              </button>
              <button className={`document-editor-toolbar-btn ${editor?.isActive({ textAlign: 'right' }) ? 'active' : ''}`} onClick={() => editor && cmd.setTextAlign(editor, 'right')} title="Align Right">
                <span className="align-icon align-right"><span /><span /><span /></span>
              </button>
              <button className={`document-editor-toolbar-btn ${editor?.isActive({ textAlign: 'justify' }) ? 'active' : ''}`} onClick={() => editor && cmd.setTextAlign(editor, 'justify')} title="Justify">
                <span className="align-icon align-justify"><span /><span /><span /></span>
              </button>
            </div>
          </div>
        )}

        {/* === INSERT TAB === */}
        {activeTab === 'insert' && (
          <div className="ribbon-panel-content">
            {/* Table insert */}
            <div className="document-editor-toolbar-group">
              <button className="document-editor-toolbar-btn" onClick={() => editor && cmd.insertTable(editor)} title="Insert Table">
                <span className="toolbar-icon">⊞</span>
              </button>
            </div>

            <div className="document-editor-toolbar-divider" />

            {/* Math/LaTeX */}
            <div className="document-editor-toolbar-group">
              <button className="document-editor-toolbar-btn" onClick={() => openMathInput(false)} title="Insert Inline Equation ($...$)">
                <span className="toolbar-icon">∑</span>
              </button>
              <button className="document-editor-toolbar-btn" onClick={() => openMathInput(true)} title="Insert Block Equation ($$...$$)">
                <span className="toolbar-icon">∫</span>
              </button>
            </div>

            <div className="document-editor-toolbar-divider" />

            {/* Media */}
            <div className="document-editor-toolbar-group">
              <ImageUploadButton className="document-editor-toolbar-btn" />
              <button className="document-editor-toolbar-btn" onClick={() => editor && cmd.insertHorizontalRule(editor)} title="Horizontal Rule">
                <span className="toolbar-icon">—</span>
              </button>
            </div>

            <div className="document-editor-toolbar-divider" />

            {/* Search */}
            <div className="document-editor-toolbar-group">
              <button className={`document-editor-toolbar-btn ${showSearchReplace ? 'active' : ''}`} onClick={() => setShowSearchReplace(!showSearchReplace)} title="Search & Replace (Ctrl+F)">
                <span className="toolbar-icon">🔍</span>
              </button>
            </div>
          </div>
        )}

        {/* === TABLE TAB === */}
        {activeTab === 'table' && (
          <div className="ribbon-panel-content">
            {/* Insert table - always active */}
            <div className="document-editor-toolbar-group">
              <button className="document-editor-toolbar-btn" onClick={() => editor && cmd.insertTable(editor)} title="Insert Table">
                <span className="toolbar-icon">⊞</span>
              </button>
            </div>

            <div className="document-editor-toolbar-divider" />

            {/* Structure - disabled when not in table */}
            <div className={`document-editor-toolbar-group ${!isInTable ? 'disabled-group' : ''}`}>
              <button className="document-editor-toolbar-btn" onClick={() => editor && isInTable && cmd.addColumnAfter(editor)} title="Add Column" disabled={!isInTable}>
                <span className="toolbar-icon">+⇥</span>
              </button>
              <button className="document-editor-toolbar-btn" onClick={() => editor && isInTable && cmd.addRowAfter(editor)} title="Add Row" disabled={!isInTable}>
                <span className="toolbar-icon">+↓</span>
              </button>
              <button className="document-editor-toolbar-btn" onClick={() => editor && isInTable && cmd.deleteColumn(editor)} title="Delete Column" disabled={!isInTable}>
                <span className="toolbar-icon">-⇥</span>
              </button>
              <button className="document-editor-toolbar-btn" onClick={() => editor && isInTable && cmd.deleteRow(editor)} title="Delete Row" disabled={!isInTable}>
                <span className="toolbar-icon">-↓</span>
              </button>
            </div>

            <div className="document-editor-toolbar-divider" />

            {/* Options - disabled when not in table */}
            <div className={`document-editor-toolbar-group ${!isInTable ? 'disabled-group' : ''}`}>
              <ToolbarDropdown
                trigger={<span className="toolbar-icon">⚙</span>}
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
                </div>
              </ToolbarDropdown>
              <ToolbarDropdown
                trigger={<span className="toolbar-icon" style={{ fontSize: '0.75rem' }}>🎨</span>}
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

            <div className="document-editor-toolbar-divider" />

            {/* Delete table */}
            <div className={`document-editor-toolbar-group ${!isInTable ? 'disabled-group' : ''}`}>
              <button className="document-editor-toolbar-btn danger" onClick={() => editor && isInTable && cmd.deleteTable(editor)} title="Delete Table" disabled={!isInTable}>
                <span className="toolbar-icon">⊟</span>
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
