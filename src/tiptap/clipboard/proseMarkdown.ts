/**
 * Prose as Markdown or plain text, for "Copy as" (DSK-208).
 *
 * One rule per node and mark of the prose schema, in two flavours:
 *
 * - **Markdown** (GitHub-flavoured): headings, emphasis, strikethrough, code,
 *   links, nested and task lists, quotes, fences, tables, images, `$`math`$`.
 *   Underline, colour and highlight have no Markdown form and come out as
 *   their text.
 * - **Plain text**: the words, with list markers and table rows kept so the
 *   structure still reads, and no other syntax.
 *
 * Every node and mark has an explicit rule here; a test fails when the schema
 * gains one without it. At runtime an unknown node still renders its content
 * (`strict: false`), so new content is never lost from a copy.
 */
import {
  MarkdownSerializer,
  defaultMarkdownSerializer,
  type MarkdownSerializerState,
} from '@tiptap/pm/markdown';
import type { Mark, Node as PMNode } from '@tiptap/pm/model';

type NodeRule = (state: MarkdownSerializerState, node: PMNode, parent: PMNode, index: number) => void;
interface MarkRule {
  open: string | ((state: MarkdownSerializerState, mark: Mark, parent: PMNode, index: number) => string);
  close: string | ((state: MarkdownSerializerState, mark: Mark, parent: PMNode, index: number) => string);
  mixable?: boolean;
  expelEnclosingWhitespace?: boolean;
  escape?: boolean;
}

const base = defaultMarkdownSerializer.nodes;

const listRules = {
  bulletList(state, node) {
    state.renderList(node, '  ', () => '- ');
  },
  orderedList(state, node) {
    const start = Number(node.attrs['start'] ?? 1) || 1;
    const width = String(start + node.childCount - 1).length;
    state.renderList(node, state.repeat(' ', width + 2), (i) => {
      const n = String(start + i);
      return state.repeat(' ', width - n.length) + n + '. ';
    });
  },
  listItem: base['list_item']!,
  taskList(state, node) {
    state.renderList(node, '  ', () => '- ');
  },
  taskItem(state, node) {
    state.write(node.attrs['checked'] ? '[x] ' : '[ ] ');
    state.renderContent(node);
  },
} satisfies Record<string, NodeRule>;

/** Rules both flavours share. */
const commonRules = {
  ...listRules,
  paragraph: base['paragraph']!,
  horizontalRule: base['horizontal_rule']!,
  figure(state, node) {
    state.renderContent(node);
  },
  gallery(state, node) {
    state.renderContent(node);
  },
  fieldRef(state, node) {
    state.text(String(node.attrs['label'] || node.attrs['name'] || ''), false);
  },
  citationInline(state, node) {
    state.text(String(node.attrs['label'] || '[citation]'), false);
  },
  bibliography(state, node) {
    for (const entry of htmlEntries(String(node.attrs['bibHtml'] ?? ''))) {
      state.text(entry, false);
      state.closeBlock(node);
    }
  },
  embeddedGroup(state, node) {
    state.text(`[Diagram: ${String(node.attrs['groupName'] || 'untitled')}]`, false);
    state.closeBlock(node);
  },
} satisfies Record<string, NodeRule>;

const markdownNodeRules: Record<string, NodeRule> = {
  ...commonRules,
  text: base['text']!,
  heading: base['heading']!,
  blockquote: base['blockquote']!,
  callout: base['blockquote']!,
  hardBreak: base['hard_break']!,
  codeBlock(state, node) {
    const backticks = node.textContent.match(/`{3,}/gm);
    const fence = backticks ? backticks.sort().slice(-1)[0] + '`' : '```';
    state.write(fence + String(node.attrs['language'] ?? '') + '\n');
    state.text(node.textContent, false);
    state.write('\n');
    state.write(fence);
    state.closeBlock(node);
  },
  image(state, node) {
    const src = String(node.attrs['src'] ?? '');
    if (src) {
      const title = node.attrs['title'] ? ` "${String(node.attrs['title']).replace(/"/g, '\\"')}"` : '';
      state.write(`![${state.esc(String(node.attrs['alt'] ?? ''))}](${src.replace(/[()]/g, '\\$&')}${title})`);
    }
    if (node.isBlock) state.closeBlock(node);
  },
  figcaption(state, node) {
    state.write('*');
    state.renderInline(node);
    state.write('*');
    state.closeBlock(node);
  },
  mathInline(state, node) {
    state.write(`$${String(node.attrs['latex'] ?? '')}$`);
  },
  mathBlock(state, node) {
    state.write('$$');
    state.ensureNewLine();
    state.text(String(node.attrs['latex'] ?? ''), false);
    state.ensureNewLine();
    state.write('$$');
    state.closeBlock(node);
  },
  fileRef(state, node) {
    const name = String(node.attrs['fileName'] || 'file');
    const ref = node.attrs['blobRef'];
    state.write(ref ? `[${state.esc(name)}](blob://${String(ref)})` : state.esc(name));
  },
  table: tableRule('markdown'),
  tableRow: rowRule,
  tableCell: cellRule,
  tableHeader: cellRule,
};

const plainNodeRules: Record<string, NodeRule> = {
  ...commonRules,
  text(state, node) {
    state.text(node.text ?? '', false);
  },
  heading(state, node) {
    state.renderInline(node, false);
    state.closeBlock(node);
  },
  blockquote(state, node) {
    state.renderContent(node);
  },
  callout(state, node) {
    state.renderContent(node);
  },
  hardBreak(state) {
    state.write('\n');
  },
  codeBlock(state, node) {
    state.text(node.textContent, false);
    state.closeBlock(node);
  },
  image(state, node) {
    const alt = String(node.attrs['alt'] ?? '').trim();
    state.text(alt ? `[Image: ${alt}]` : '[Image]', false);
    if (node.isBlock) state.closeBlock(node);
  },
  figcaption(state, node) {
    state.renderInline(node);
    state.closeBlock(node);
  },
  mathInline(state, node) {
    state.text(String(node.attrs['latex'] ?? ''), false);
  },
  mathBlock(state, node) {
    state.text(String(node.attrs['latex'] ?? ''), false);
    state.closeBlock(node);
  },
  fileRef(state, node) {
    state.text(String(node.attrs['fileName'] || 'file'), false);
  },
  table: tableRule('plain'),
  tableRow: rowRule,
  tableCell: cellRule,
  tableHeader: cellRule,
};

const plainMark: MarkRule = { open: '', close: '', mixable: true };

const markdownMarkRules: Record<string, MarkRule> = {
  bold: { open: '**', close: '**', mixable: true, expelEnclosingWhitespace: true },
  italic: { open: '*', close: '*', mixable: true, expelEnclosingWhitespace: true },
  strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
  code: defaultMarkdownSerializer.marks['code'] as MarkRule,
  link: defaultMarkdownSerializer.marks['link'] as MarkRule,
  subscript: { open: '<sub>', close: '</sub>', mixable: true },
  superscript: { open: '<sup>', close: '</sup>', mixable: true },
  underline: plainMark,
  highlight: plainMark,
  textStyle: plainMark,
};

const plainMarkRules: Record<string, MarkRule> = Object.fromEntries(
  Object.keys(markdownMarkRules).map((name) => [name, plainMark]),
);

/** Node and mark names with an explicit rule (the schema test checks these). */
export const RULED_NODES: ReadonlySet<string> = new Set(Object.keys(markdownNodeRules));
export const RULED_MARKS: ReadonlySet<string> = new Set(Object.keys(markdownMarkRules));

const options = { strict: false, hardBreakNodeName: 'hardBreak' } as const;
const markdownSerializer = new MarkdownSerializer(markdownNodeRules, markdownMarkRules, options);
const plainSerializer = new MarkdownSerializer(plainNodeRules, plainMarkRules, options);

/** A prose document (or a cut of one) as GitHub-flavoured Markdown. */
export function proseToMarkdown(doc: PMNode): string {
  return markdownSerializer.serialize(doc, { tightLists: true }).trim();
}

/** A prose document (or a cut of one) as plain text. */
export function proseToPlainText(doc: PMNode): string {
  return plainSerializer.serialize(doc, { tightLists: true }).trim();
}

// --- Tables ------------------------------------------------------------------

/** GFM pipe tables (first row as the header), or tab-separated rows in plain text. */
function tableRule(flavour: 'markdown' | 'plain'): NodeRule {
  return (state, node) => {
    const serializer = flavour === 'markdown' ? markdownSerializer : plainSerializer;
    const rows: string[][] = [];
    node.forEach((row) => {
      const cells: string[] = [];
      row.forEach((cell) => {
        const text = serializer.serialize(cell, { tightLists: true }).trim();
        cells.push(flavour === 'markdown' ? text.replace(/\|/g, '\\|').replace(/\n+/g, '<br>') : text.replace(/\s*\n+\s*/g, ' '));
      });
      rows.push(cells);
    });
    if (rows.length === 0) return;
    const width = Math.max(...rows.map((r) => r.length));
    const pad = (cells: string[]) => Array.from({ length: width }, (_, i) => cells[i] ?? '');
    rows.forEach((cells, i) => {
      state.write(flavour === 'markdown' ? `| ${pad(cells).join(' | ')} |` : pad(cells).join('\t'));
      state.ensureNewLine();
      if (flavour === 'markdown' && i === 0) {
        state.write(`| ${Array.from({ length: width }, () => '---').join(' | ')} |`);
        state.ensureNewLine();
      }
    });
    state.closeBlock(node);
  };
}

/** Rows and cells are written by their table; on their own they render their content. */
function rowRule(state: MarkdownSerializerState, node: PMNode): void {
  state.renderContent(node);
}

function cellRule(state: MarkdownSerializerState, node: PMNode): void {
  state.renderContent(node);
}

/** The text of each entry in a bibliography's rendered HTML. */
function htmlEntries(html: string): string[] {
  if (!html) return [];
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  const entries = body.querySelectorAll('li, .csl-entry, p');
  const texts = (entries.length > 0 ? Array.from(entries) : [body]).map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim());
  return texts.filter(Boolean);
}
