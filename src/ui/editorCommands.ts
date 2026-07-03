/**
 * editorCommands - Shared formatting command functions for the Tiptap editor.
 *
 * Used by both DocumentEditorToolbar and DocumentEditorContextMenu
 * to avoid duplicating editor command logic.
 */

import type { Editor } from '@tiptap/core';
import type { CalloutVariant } from '../tiptap/CalloutExtension';
import {
  addColumnAfterKeepHeader,
  addColumnBeforeKeepHeader,
  addRowAfterKeepHeader,
  addRowBeforeKeepHeader,
  moveColumnLeft as moveColumnLeftCmd,
  moveColumnRight as moveColumnRightCmd,
  moveRowUp as moveRowUpCmd,
  moveRowDown as moveRowDownCmd,
} from '../tiptap/tableStructureCommands';
import {
  selectRow as selectRowCmd,
  selectColumn as selectColumnCmd,
  selectAllCells as selectAllCellsCmd,
} from '../tiptap/tableSelectCommands';

// Text formatting
export const toggleBold = (editor: Editor) => editor.chain().focus().toggleBold().run();
export const toggleItalic = (editor: Editor) => editor.chain().focus().toggleItalic().run();
export const toggleUnderline = (editor: Editor) => editor.chain().focus().toggleUnderline().run();
export const toggleStrike = (editor: Editor) => editor.chain().focus().toggleStrike().run();
export const toggleCode = (editor: Editor) => editor.chain().focus().toggleCode().run();
export const toggleSubscript = (editor: Editor) => editor.chain().focus().toggleSubscript().run();
export const toggleSuperscript = (editor: Editor) => editor.chain().focus().toggleSuperscript().run();
export const clearFormatting = (editor: Editor) => editor.chain().focus().unsetAllMarks().run();

// Block-level formatting
export const toggleBlockquote = (editor: Editor) => editor.chain().focus().toggleBlockquote().run();
export const toggleCodeBlock = (editor: Editor) => editor.chain().focus().toggleCodeBlock().run();
export const insertHorizontalRule = (editor: Editor) => editor.chain().focus().setHorizontalRule().run();

// Callouts — wrap the selection in an admonition (or re-style the current one).
export const setCallout = (editor: Editor, variant: CalloutVariant) =>
  editor.chain().focus().setCallout(variant).run();

// Headings
export const setHeading = (editor: Editor, level: 1 | 2 | 3 | 4 | 5 | 6) =>
  editor.chain().focus().toggleHeading({ level }).run();
export const setParagraph = (editor: Editor) => editor.chain().focus().setParagraph().run();

// Lists
export const toggleBulletList = (editor: Editor) => editor.chain().focus().toggleBulletList().run();
export const toggleOrderedList = (editor: Editor) => editor.chain().focus().toggleOrderedList().run();
export const toggleTaskList = (editor: Editor) => editor.chain().focus().toggleTaskList().run();

// Alignment
export const setTextAlign = (editor: Editor, alignment: 'left' | 'center' | 'right' | 'justify') =>
  editor.chain().focus().setTextAlign(alignment).run();

// Colors
export const setTextColor = (editor: Editor, color: string) =>
  editor.chain().focus().setColor(color).run();
export const setHighlight = (editor: Editor, color: string) =>
  editor.chain().focus().setHighlight({ color }).run();
export const unsetHighlight = (editor: Editor) =>
  editor.chain().focus().unsetHighlight().run();

// Tables
export const insertTable = (editor: Editor) =>
  editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
// Insert commands keep the table-header style on the new row/column (JP-416):
// a fresh cell in the header row/column is promoted back to `tableHeader` so it
// no longer needs a manual re-toggle.
export const addColumnAfter = (editor: Editor) => addColumnAfterKeepHeader(editor);
export const addColumnBefore = (editor: Editor) => addColumnBeforeKeepHeader(editor);
export const addRowAfter = (editor: Editor) => addRowAfterKeepHeader(editor);
export const addRowBefore = (editor: Editor) => addRowBeforeKeepHeader(editor);
export const deleteColumn = (editor: Editor) => editor.chain().focus().deleteColumn().run();
export const deleteRow = (editor: Editor) => editor.chain().focus().deleteRow().run();
export const deleteTable = (editor: Editor) => editor.chain().focus().deleteTable().run();
export const toggleHeaderRow = (editor: Editor) => editor.chain().focus().toggleHeaderRow().run();
export const toggleHeaderColumn = (editor: Editor) => editor.chain().focus().toggleHeaderColumn().run();
export const mergeCells = (editor: Editor) => editor.chain().focus().mergeCells().run();
export const splitCell = (editor: Editor) => editor.chain().focus().splitCell().run();
export const mergeOrSplit = (editor: Editor) => editor.chain().focus().mergeOrSplit().run();
// Move the column/row containing the selection one step (JP-416). No-op at the
// table edge or when the table has merged cells.
export const moveColumnLeft = (editor: Editor) => moveColumnLeftCmd(editor);
export const moveColumnRight = (editor: Editor) => moveColumnRightCmd(editor);
export const moveRowUp = (editor: Editor) => moveRowUpCmd(editor);
export const moveRowDown = (editor: Editor) => moveRowDownCmd(editor);
// Select the current row(s) / column(s) / whole table as a CellSelection (JP-416).
export const selectRow = (editor: Editor) => selectRowCmd(editor);
export const selectColumn = (editor: Editor) => selectColumnCmd(editor);
export const selectAllCells = (editor: Editor) => selectAllCellsCmd(editor);
export const setCellBackground = (editor: Editor, color: string | null) =>
  editor.chain().focus().setCellAttribute('backgroundColor', color).run();
// Text alignment for the selected cells (JP-416). With a column selected this
// aligns the whole column; `null` clears back to the default (left).
export const setCellAlign = (editor: Editor, align: 'left' | 'center' | 'right' | null) =>
  editor.chain().focus().setCellAttribute('align', align).run();

// Math
export const setMathInline = (editor: Editor, latex: string) =>
  editor.chain().focus().setMathInline(latex).run();
export const setMathBlock = (editor: Editor, latex: string) =>
  editor.chain().focus().setMathBlock(latex).run();

// Citations (JP-89)
export const setCitation = (editor: Editor, refId: string, locator?: string) =>
  editor.chain().focus().setCitation(refId, locator).run();
export const insertBibliography = (editor: Editor) =>
  editor.chain().focus().insertBibliography().run();
