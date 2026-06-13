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
import * as cmd from '../ui/editorCommands';

/** A single `/` command. `group` buckets related commands in the menu. */
export interface SlashCommand {
  id: string;
  title: string;
  /** Extra search terms (matched case-insensitively alongside the title/id). */
  keywords: string[];
  group: string;
  run: (editor: Editor) => void;
}

// ─── UI-flow seam (inserts whose UI lives in React) ──────────────────────────

/** Inserts that open React UI rather than running a pure editor command. */
export type SlashUiAction = 'image' | 'citation';

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
  { id: 'h1', title: 'Heading 1', keywords: ['h1', 'title', 'heading'], group: 'Headings', run: (e) => cmd.setHeading(e, 1) },
  { id: 'h2', title: 'Heading 2', keywords: ['h2', 'subtitle', 'heading'], group: 'Headings', run: (e) => cmd.setHeading(e, 2) },
  { id: 'h3', title: 'Heading 3', keywords: ['h3', 'heading'], group: 'Headings', run: (e) => cmd.setHeading(e, 3) },
  { id: 'paragraph', title: 'Text', keywords: ['paragraph', 'body', 'plain'], group: 'Basic', run: (e) => cmd.setParagraph(e) },
  { id: 'bullet', title: 'Bulleted list', keywords: ['ul', 'bullet', 'list', 'unordered'], group: 'Lists', run: (e) => cmd.toggleBulletList(e) },
  { id: 'ordered', title: 'Numbered list', keywords: ['ol', 'ordered', 'list', 'number'], group: 'Lists', run: (e) => cmd.toggleOrderedList(e) },
  { id: 'task', title: 'Task list', keywords: ['todo', 'task', 'checklist', 'checkbox'], group: 'Lists', run: (e) => cmd.toggleTaskList(e) },
  { id: 'quote', title: 'Quote', keywords: ['blockquote', 'quote'], group: 'Basic', run: (e) => cmd.toggleBlockquote(e) },
  { id: 'code', title: 'Code block', keywords: ['code', 'pre', 'snippet'], group: 'Basic', run: (e) => cmd.toggleCodeBlock(e) },
  { id: 'divider', title: 'Divider', keywords: ['hr', 'divider', 'rule', 'separator'], group: 'Basic', run: (e) => cmd.insertHorizontalRule(e) },
  { id: 'callout', title: 'Callout', keywords: ['callout', 'note', 'admonition', 'aside', 'info', 'warning'], group: 'Basic', run: (e) => cmd.setCallout(e, 'note') },
  { id: 'toggle', title: 'Toggle section', keywords: ['toggle', 'collapse', 'details', 'expand', 'accordion', 'fold'], group: 'Basic', run: (e) => cmd.insertToggle(e) },
  { id: 'table', title: 'Table', keywords: ['table', 'grid'], group: 'Insert', run: (e) => cmd.insertTable(e) },
  { id: 'math', title: 'Math block', keywords: ['math', 'latex', 'equation', 'formula'], group: 'Insert', run: (e) => cmd.setMathBlock(e, '') },
  { id: 'image', title: 'Image', keywords: ['image', 'picture', 'photo', 'upload'], group: 'Insert', run: () => runUi('image') },
  { id: 'citation', title: 'Citation', keywords: ['cite', 'citation', 'reference', 'source'], group: 'References', run: () => runUi('citation') },
  { id: 'bibliography', title: 'Bibliography', keywords: ['bibliography', 'references', 'works cited'], group: 'References', run: (e) => cmd.insertBibliography(e) },
];

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
