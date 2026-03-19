/**
 * editorCommands - Shared formatting command functions for the Tiptap editor.
 *
 * Used by both DocumentEditorToolbar and DocumentEditorContextMenu
 * to avoid duplicating editor command logic.
 */

import type { Editor } from '@tiptap/core';

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
export const insertHorizontalRule = (editor: Editor) => editor.chain().focus().setHorizontalRule().run();

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
export const addColumnAfter = (editor: Editor) => editor.chain().focus().addColumnAfter().run();
export const addColumnBefore = (editor: Editor) => editor.chain().focus().addColumnBefore().run();
export const addRowAfter = (editor: Editor) => editor.chain().focus().addRowAfter().run();
export const addRowBefore = (editor: Editor) => editor.chain().focus().addRowBefore().run();
export const deleteColumn = (editor: Editor) => editor.chain().focus().deleteColumn().run();
export const deleteRow = (editor: Editor) => editor.chain().focus().deleteRow().run();
export const deleteTable = (editor: Editor) => editor.chain().focus().deleteTable().run();
export const toggleHeaderRow = (editor: Editor) => editor.chain().focus().toggleHeaderRow().run();
export const toggleHeaderColumn = (editor: Editor) => editor.chain().focus().toggleHeaderColumn().run();
export const mergeCells = (editor: Editor) => editor.chain().focus().mergeCells().run();
export const splitCell = (editor: Editor) => editor.chain().focus().splitCell().run();
export const setCellBackground = (editor: Editor, color: string | null) =>
  editor.chain().focus().setCellAttribute('backgroundColor', color).run();

// Math
export const setMathInline = (editor: Editor, latex: string) =>
  editor.chain().focus().setMathInline(latex).run();
export const setMathBlock = (editor: Editor, latex: string) =>
  editor.chain().focus().setMathBlock(latex).run();
