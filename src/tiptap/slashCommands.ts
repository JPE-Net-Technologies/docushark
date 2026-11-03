/**
 * slashCommands — the `/` command registry + matcher for the prose slash menu.
 *
 * Each command is a small descriptor the `SlashMenu` extension renders and runs.
 * Most commands delegate to the shared `editorCommands` helpers (the same ones the
 * toolbar + context menu use) so a slash insert and a toolbar insert are identical.
 *
 * A couple of inserts (image upload, citation picker) are driven by React UI that
 * lives outside the editor, so they go through a tiny handler seam
 * (`registerSlashUiHandler`) — the React component registers the handler on mount,
 * and the slash command invokes it. When no handler is registered (e.g. a headless
 * editor), those commands are harmless no-ops. Later slices (Fields, file embed,
 * callouts, …) append to `SLASH_COMMANDS`.
 */

import type { Editor } from '@tiptap/core';
import {
  BookMarked, Braces, Heading1, Heading2, Heading3, Image, Images, Info, List, ListOrdered, ListTodo,
  Minus, Paperclip, Pilcrow, Quote, SquareCode, SquareSigma, Table, TextQuote, type LucideIcon,
} from 'lucide-react';
import * as cmd from '../ui/editorCommands';

/** A single `/` command. `group` buckets related commands in the menu. */
export interface SlashCommand {
  id: string;
  title: string;
  /** Extra search terms (matched case-insensitively alongside the title/id). */
  keywords: string[];
  group: string;
  /**
   * `format` reshapes the current block (the ribbon's Home tab has these as
   * toggles); `insert` adds something, and the ribbon's Insert tab offers every
   * one of them, so Insert and "/" can't drift apart.
   */
  place: 'format' | 'insert';
  icon: LucideIcon;
  run: (editor: Editor) => void;
}

// ─── UI-flow seam (inserts whose UI lives in React) ──────────────────────────

/** Inserts that open React UI rather than running a pure editor command. */
export type SlashUiAction = 'image' | 'citation' | 'gallery' | 'field' | 'file';

const uiHandlers = new Map<SlashUiAction, () => void>();

/**
 * Register the handler for a UI-flow slash command (image upload / citation
 * picker). Call from a React effect; the returned function unregisters it.
 * Identity-checked on cleanup so a remount doesn't clobber a newer handler.
 */
export function registerSlashUiHandler(action: SlashUiAction, fn: () => void): () => void {
  uiHandlers.set(action, fn);
  return () => {
    if (uiHandlers.get(action) === fn) uiHandlers.delete(action);
  };
}

function runUi(action: SlashUiAction): void {
  uiHandlers.get(action)?.();
}

// ─── The registry ────────────────────────────────────────────────────────────

export const SLASH_COMMANDS: SlashCommand[] = [
  { id: 'h1', title: 'Heading 1', keywords: ['h1', 'title', 'heading'], group: 'Headings', place: 'format', icon: Heading1, run: (e) => cmd.setHeading(e, 1) },
  { id: 'h2', title: 'Heading 2', keywords: ['h2', 'subtitle', 'heading'], group: 'Headings', place: 'format', icon: Heading2, run: (e) => cmd.setHeading(e, 2) },
  { id: 'h3', title: 'Heading 3', keywords: ['h3', 'heading'], group: 'Headings', place: 'format', icon: Heading3, run: (e) => cmd.setHeading(e, 3) },
  { id: 'paragraph', title: 'Text', keywords: ['paragraph', 'body', 'plain'], group: 'Basic', place: 'format', icon: Pilcrow, run: (e) => cmd.setParagraph(e) },
  { id: 'bullet', title: 'Bulleted list', keywords: ['ul', 'bullet', 'list', 'unordered'], group: 'Lists', place: 'format', icon: List, run: (e) => cmd.toggleBulletList(e) },
  { id: 'ordered', title: 'Numbered list', keywords: ['ol', 'ordered', 'list', 'number'], group: 'Lists', place: 'format', icon: ListOrdered, run: (e) => cmd.toggleOrderedList(e) },
  { id: 'task', title: 'Task list', keywords: ['todo', 'task', 'checklist', 'checkbox'], group: 'Lists', place: 'format', icon: ListTodo, run: (e) => cmd.toggleTaskList(e) },
  { id: 'quote', title: 'Quote', keywords: ['blockquote', 'quote'], group: 'Basic', place: 'format', icon: TextQuote, run: (e) => cmd.toggleBlockquote(e) },
  { id: 'code', title: 'Code block', keywords: ['code', 'pre', 'snippet'], group: 'Basic', place: 'insert', icon: SquareCode, run: (e) => cmd.toggleCodeBlock(e) },
  { id: 'divider', title: 'Divider', keywords: ['hr', 'divider', 'rule', 'separator'], group: 'Basic', place: 'insert', icon: Minus, run: (e) => cmd.insertHorizontalRule(e) },
  { id: 'callout', title: 'Callout', keywords: ['callout', 'note', 'admonition', 'aside', 'info', 'warning'], group: 'Basic', place: 'insert', icon: Info, run: (e) => cmd.setCallout(e, 'note') },
  { id: 'table', title: 'Table', keywords: ['table', 'grid'], group: 'Insert', place: 'insert', icon: Table, run: (e) => cmd.insertTable(e) },
  { id: 'math', title: 'Math block', keywords: ['math', 'latex', 'equation', 'formula'], group: 'Insert', place: 'insert', icon: SquareSigma, run: (e) => cmd.setMathBlock(e, '') },
  { id: 'image', title: 'Image', keywords: ['image', 'picture', 'photo', 'upload'], group: 'Insert', place: 'insert', icon: Image, run: () => runUi('image') },
  { id: 'file', title: 'File attachment', keywords: ['file', 'attach', 'attachment', 'document', 'pdf', 'upload'], group: 'Insert', place: 'insert', icon: Paperclip, run: () => runUi('file') },
  { id: 'gallery', title: 'Image gallery', keywords: ['gallery', 'images', 'grid', 'photos', 'album'], group: 'Insert', place: 'insert', icon: Images, run: () => runUi('gallery') },
  { id: 'field', title: 'Field', keywords: ['field', 'variable', 'merge', 'term', 'placeholder', 'value'], group: 'Insert', place: 'insert', icon: Braces, run: () => runUi('field') },
  { id: 'citation', title: 'Citation', keywords: ['cite', 'citation', 'reference', 'source'], group: 'References', place: 'insert', icon: Quote, run: () => runUi('citation') },
  { id: 'bibliography', title: 'Bibliography', keywords: ['bibliography', 'references', 'works cited'], group: 'References', place: 'insert', icon: BookMarked, run: (e) => cmd.insertBibliographyOnce(e) },
];

/**
 * What "/" inserts (as opposed to formats), in the registry's groups and order:
 * the ribbon's Insert tab and the right-click Insert menu both list these, so
 * neither can drift from "/" (DSK-200, DSK-213).
 */
export const INSERT_COMMANDS = SLASH_COMMANDS.filter((command) => command.place === 'insert');
export const INSERT_GROUPS = [...new Set(INSERT_COMMANDS.map((command) => command.group))];

// ─── Matcher + filter (pure, unit-tested) ────────────────────────────────────

/**
 * Match a slash trigger at the end of the text before the caret: a `/` at a word
 * boundary (block start, or after whitespace), followed by the query (letters /
 * digits, no spaces). Returns the query and the `/` offset within `textBefore`,
 * or `null`. The boundary keeps it from firing inside URLs / paths (`http://`,
 * `a/b`), where the `/` is preceded by a non-space character.
 */
export function matchSlashTrigger(textBefore: string): { query: string; from: number } | null {
  const m = /(?:^|\s)\/([a-zA-Z0-9]*)$/.exec(textBefore);
  if (!m) return null;
  const query = m[1] ?? '';
  const from = m.index + m[0].length - query.length - 1;
  return { query, from };
}

/**
 * Filter the registry by `query` (matched against title, id, and keywords). An
 * empty query returns the first `limit` commands so a bare `/` shows the menu.
 */
export function filterCommands(query: string, limit = 8): SlashCommand[] {
  const q = query.trim().toLowerCase();
  const matched = q
    ? SLASH_COMMANDS.filter(
        (c) =>
          c.title.toLowerCase().includes(q) ||
          c.id.includes(q) ||
          c.keywords.some((k) => k.includes(q))
      )
    : SLASH_COMMANDS;
  return matched.slice(0, limit);
}
