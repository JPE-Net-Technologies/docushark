/**
 * Golden tests for the PDF exporter (DSK-242).
 *
 * Every case in the shared prose corpus (`relay/tests/prose-fixtures/cases.json`),
 * the whole corpus as one multi-page export, and a few long documents that break
 * across pages are exported with the default options and read back with pdf.js.
 * For each, the page count, the text of every page, the links on every page and
 * the outline (titles and target pages) must match `pdfExportGolden.json`.
 *
 * That pins what a reader gets out of the exporter while it is split up and
 * changed, without pinning bytes: fonts, compression and the creation date may
 * all move without failing it.
 *
 * jsdom has no canvas, so math (a formula waits forever on an image load) is
 * left out, and diagrams come out as their fallback. Both join properly once
 * DSK-44 draws them as vectors.
 *
 * After an intended change, rewrite the golden file and review its diff like
 * any other code change:
 *   UPDATE_PDF_GOLDEN=1 bun run test src/utils/pdfExportGolden.test.ts
 *
 * Style isn't pinned (bold table headers could turn plain without failing it),
 * because pdf.js numbers fonts by first use, which would churn on harmless
 * reordering. A refactor that must change nothing can be checked byte for byte
 * instead: run once before and once after with `PDF_DUMP_DIR=<dir>` set, and
 * compare the two directories. Each export is written there with its creation
 * date and file id blanked out, the only parts that vary between runs.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getSchema, type JSONContent } from '@tiptap/core';
import { DOMParser as PMDOMParser, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
// Defines `globalThis.pdfjsWorker`, so pdf.js parses in this thread instead of
// looking for a worker file.
import 'pdfjs-dist/legacy/build/pdf.worker.mjs';

import { sharedProseExtensions } from '../ui/TiptapEditor';
import { DEFAULT_PDF_OPTIONS } from '../types/PDFExport';
import type { RichTextContent } from '../types/RichText';
import { exportToPdf, exportToPdfWithLayout, type PDFRichTextPage } from './pdfExportUtils';
import { paginate, relayoutFrom, type BreakAt, type PdfLayout } from './pdfExport/paginate';
import { jsPDF } from 'jspdf';
import { MeasureDoc } from './pdfExport/doc';
import { pdfFontFor, registerPDFFonts } from './pdfExport/fonts';
import { layOut } from './pdfExport/layout';
import { positionOfBreak } from '../paper/breakPositions';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS = resolve(__dirname, '../../relay/tests/prose-fixtures/cases.json');
const GOLDEN = resolve(__dirname, 'pdfExportGolden.json');
const UPDATE = process.env['UPDATE_PDF_GOLDEN'] === '1';
const DUMP_DIR = process.env['PDF_DUMP_DIR'];

/** Node types that can't be drawn without a canvas (see the header). */
const NEEDS_A_CANVAS = new Set(['mathInline', 'mathBlock']);

interface GoldenLink {
  /** The page an internal link jumps to. */
  page?: number | null;
  /** Where an external link goes. */
  url?: string;
}

interface GoldenOutlineItem {
  title: string;
  page: number | null;
  items: GoldenOutlineItem[];
}

interface GoldenDoc {
  pages: number;
  /** Per page: its text, one entry per line. */
  text: string[][];
  /** Per page: its links, in the order the page lists them. */
  links: GoldenLink[][];
  outline: GoldenOutlineItem[];
}

interface CorpusCase {
  name: string;
  html: string;
}

// ─── Building the documents ─────────────────────────────────────────────────

/** The editor's schema, built as `proseFixtures.test.ts` builds it. */
const schema: Schema = getSchema([
  StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] }, codeBlock: false, history: false }),
  ...sharedProseExtensions,
]);

function parse(html: string): PMNode {
  const container = document.createElement('div');
  container.innerHTML = html;
  return PMDOMParser.fromSchema(schema).parse(container);
}

function content(html: string): RichTextContent {
  return { content: parse(html).toJSON(), version: 1 };
}

function needsACanvas(html: string): boolean {
  let found = false;
  parse(html).descendants((node) => {
    if (NEEDS_A_CANVAS.has(node.type.name)) found = true;
    return !found;
  });
  return found;
}

const VOCABULARY = [
  'canvas', 'document', 'relay', 'shape', 'prose', 'export', 'layout', 'citation',
  'page', 'table', 'diagram', 'heading', 'outline', 'figure', 'source', 'review',
];

/** Deterministic filler: no randomness, so the golden output never drifts. */
function sentence(seed: number, words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(VOCABULARY[(seed * 7 + i * 3 + (i >> 2)) % VOCABULARY.length]!);
  return `${out.join(' ')}.`;
}

/** Headings, paragraphs and lists over several pages, with two kinds of link. */
function longReport(): string {
  const parts = ['<h1 id="blk-report">Quarterly engineering report</h1>'];
  for (let s = 1; s <= 4; s++) {
    parts.push(`<h2 id="blk-s${s}">Section ${s}</h2>`);
    for (let p = 1; p <= 5; p++) parts.push(`<p>${sentence(s * 10 + p, 70)}</p>`);
    parts.push(`<h3 id="blk-s${s}-detail">Detail ${s}</h3>`);
    const items = [1, 2, 3, 4, 5, 6].map((i) => `<li><p>${sentence(s * 100 + i, 12)}</p></li>`);
    parts.push(`<ul>${items.join('')}</ul>`);
  }
  parts.push(
    '<p>Back to <a href="docushark://heading/report/id:blk-s2">Section 2</a> ' +
      'and on to <a href="https://docushark.app/">the website</a>.</p>',
  );
  return parts.join('');
}

/** A table long enough to break across pages, with a header row. */
function longTable(): string {
  const rows = ['<tr><th><p>Item</p></th><th><p>Owner</p></th><th><p>Notes</p></th></tr>'];
  for (let r = 1; r <= 50; r++) {
    rows.push(`<tr><td><p>Row ${r}</p></td><td><p>${sentence(r, 2)}</p></td><td><p>${sentence(r + 50, 9)}</p></td></tr>`);
  }
  return `<h2>Inventory</h2><table><tbody>${rows.join('')}</tbody></table><p>${sentence(7, 20)}</p>`;
}

/** A code block, a quote and a task list that each run past a page. */
function longBlocks(): string {
  const code = Array.from({ length: 90 }, (_, i) => `const line${i} = ${i} * ${(i * 7) % 13}; // ${sentence(i, 3)}`);
  const quote = [1, 2, 3, 4].map((p) => `<p>${sentence(p + 200, 40)}</p>`).join('');
  const tasks = Array.from(
    { length: 25 },
    (_, i) => `<li data-type="taskItem" data-checked="${i % 3 === 0}"><p>${sentence(i + 300, 10)}</p></li>`,
  );
  return (
    `<h2>Build notes</h2><pre><code class="language-ts">${code.join('\n')}</code></pre>` +
    `<blockquote>${quote}</blockquote><ul data-type="taskList">${tasks.join('')}</ul>`
  );
}

// ─── Reading a PDF back ─────────────────────────────────────────────────────

/** jsdom's Blob has no `arrayBuffer()`; its FileReader does the job. */
function blobBytes(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolveBytes, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolveBytes(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

type PDFDocument = Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>;

/** The 1-based page a destination points at, or null when it points nowhere. */
async function destinationPage(pdf: PDFDocument, dest: unknown): Promise<number | null> {
  const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
  if (!Array.isArray(explicit) || explicit.length === 0) return null;
  const target: unknown = explicit[0];
  if (typeof target === 'number') return target + 1;
  if (target && typeof target === 'object') {
    return (await pdf.getPageIndex(target as Parameters<PDFDocument['getPageIndex']>[0])) + 1;
  }
  return null;
}

interface RawOutlineItem {
  title: string;
  dest: unknown;
  items: RawOutlineItem[];
}

async function outlineOf(pdf: PDFDocument, items: RawOutlineItem[] | null): Promise<GoldenOutlineItem[]> {
  const out: GoldenOutlineItem[] = [];
  for (const item of items ?? []) {
    out.push({
      title: item.title,
      page: await destinationPage(pdf, item.dest),
      items: await outlineOf(pdf, item.items),
    });
  }
  return out;
}

/** The bytes with the creation date and file id blanked: the rest is deterministic. */
function stableBytes(bytes: Uint8Array): Uint8Array {
  // Node's latin1 maps each byte to one character and back unchanged. (A
  // TextDecoder 'latin1' is windows-1252, which rewrites bytes 0x80-0x9F and so
  // corrupted the compressed streams in the dumped files.)
  const text = Buffer.from(bytes).toString('latin1')
    .replace(/\/CreationDate \(D:[^)]*\)/g, '/CreationDate (D:0)')
    .replace(/\/ID \[ ?<[0-9A-Fa-f]+> ?<[0-9A-Fa-f]+> ?\]/g, '/ID [<0><0>]');
  return new Uint8Array(Buffer.from(text, 'latin1'));
}

async function readBack(bytes: Uint8Array): Promise<GoldenDoc> {
  // pdf.js takes ownership of the buffer it is given, so hand it a copy.
  const task = pdfjs.getDocument({ data: bytes.slice() });
  try {
    const pdf = await task.promise;
    const text: string[][] = [];
    const links: GoldenLink[][] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const items = (await page.getTextContent()).items;
      const joined = items.map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : '')).join('');
      text.push(joined.split('\n').map((line) => line.trimEnd()).filter((line) => line.length > 0));
      const pageLinks: GoldenLink[] = [];
      for (const annotation of await page.getAnnotations()) {
        if (annotation.subtype !== 'Link') continue;
        if (typeof annotation.url === 'string') pageLinks.push({ url: annotation.url });
        else pageLinks.push({ page: await destinationPage(pdf, annotation.dest) });
      }
      links.push(pageLinks);
    }
    const outline = await outlineOf(pdf, (await pdf.getOutline()) as RawOutlineItem[] | null);
    return { pages: pdf.numPages, text, links, outline };
  } finally {
    await task.destroy();
  }
}

// ─── The golden file ────────────────────────────────────────────────────────

const golden: Record<string, GoldenDoc> = existsSync(GOLDEN)
  ? (JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, GoldenDoc>)
  : {};
const produced: Record<string, GoldenDoc> = {};
/** Breaks whose opening word was found at the top of their PDF page (DSK-252). */
let openedPages = 0;

afterAll(() => {
  if (!UPDATE) return;
  const sorted = Object.fromEntries(Object.entries(produced).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(GOLDEN, `${JSON.stringify(sorted, null, 2)}\n`);
});

/** The node an index path leads to, from a prose page's root. */
function nodeAt(root: JSONContent, path: number[]): JSONContent | undefined {
  let node: JSONContent | undefined = root;
  for (const i of path) node = node?.content?.[i];
  return node;
}

/** A node's text, as the PDF prints it (atoms print their cached labels). */
function textOf(node: JSONContent | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.text ?? '';
  const label = node.attrs?.['label'];
  if (typeof label === 'string') return label;
  const children = node.content ?? [];
  // Inline content runs together; blocks (list items, paragraphs) are separate words.
  const inline = children.some((c) => c.type === 'text');
  const text = children.map(textOf).join(inline ? '' : ' ');
  // A callout prints its variant before its content.
  if (node.type === 'callout') {
    const variant = node.attrs?.['variant'];
    return `${(typeof variant === 'string' ? variant : 'note').toUpperCase()} ${text}`;
  }
  return text;
}

/**
 * The first word printed at a break, for the breaks that open with text:
 * a block, or a line from its inline position. Rows, code lines and sections
 * are left to the page-count and break-list checks.
 */
function firstWordAt(pages: PDFRichTextPage[], pageId: string | undefined, at: BreakAt): string | undefined {
  const page = pages.find((p) => p.id === pageId);
  if (at.kind === 'section' && at.section === 'prose') {
    // A prose page opens with its first block.
    return textOf(page?.content.content.content?.[0]).trim().split(/\s+/)[0] || undefined;
  }
  if (at.kind === 'codeLine') {
    // A code block's page opens at the line that starts at this offset (DSK-48).
    const code = page ? nodeAt(page.content.content, at.path) : undefined;
    return textOf(code).slice(at.offset).trim().split(/\s+/)[0] || undefined;
  }
  if (at.kind !== 'block' && at.kind !== 'line') return undefined;
  const block = page ? nodeAt(page.content.content, at.path) : undefined;
  if (!block) return undefined;
  let text = textOf(block);
  if (at.kind === 'line' && at.inline) {
    const children = block.content ?? [];
    text = textOf(children[at.inline.child]).slice(at.inline.offset)
      + children.slice(at.inline.child + 1).map(textOf).join('');
  }
  return text.trim().split(/\s+/)[0] || undefined;
}

/**
 * The paginator against the PDF (DSK-252): `paginate` must find exactly the
 * export's breaks without writing a PDF, the page counts must agree with what
 * pdf.js reads, and each break that opens with text must be the first thing
 * on its page.
 */
function checkLayout(name: string, pages: PDFRichTextPage[], exported: PdfLayout, measured: PdfLayout, got: GoldenDoc): number {
  expect(measured, `${name}: paginate() matches the export`).toEqual(exported);
  expect(exported.pages + exported.contentsPages, `${name}: page count`).toBe(got.pages);
  let opened = 0;
  for (const brk of exported.breaks) {
    const word = firstWordAt(pages, brk.pageId, brk.at);
    if (!word) continue;
    const firstLine = got.text[brk.page + exported.contentsPages - 1]?.[0] ?? '';
    // An ordered list's number is printed right against its first word ("3.c").
    const words = firstLine.replace(/^\d+\.\s*/, '').split(/\s+/);
    expect(words, `${name}: page ${brk.page} opens with "${word}"`).toContain(word);
    opened++;
  }
  return opened;
}

/** Export `pages` with the default options, then check what a reader gets out. */
async function check(name: string, pages: PDFRichTextPage[]): Promise<void> {
  const options = { ...DEFAULT_PDF_OPTIONS, coverPage: { ...DEFAULT_PDF_OPTIONS.coverPage, enabled: false } };
  const { blob, layout } = await exportToPdfWithLayout(options, pages[0]!.content, undefined, pages);
  const bytes = new Uint8Array(await blobBytes(blob));
  if (DUMP_DIR) {
    mkdirSync(DUMP_DIR, { recursive: true });
    writeFileSync(resolve(DUMP_DIR, `${name.replace(/\//g, '__')}.pdf`), stableBytes(bytes));
  }
  const got = await readBack(bytes);
  produced[name] = got;
  openedPages += checkLayout(name, pages, layout, await paginate(options, pages[0]!.content, undefined, pages), got);
  if (UPDATE) return;
  expect(golden[name], `no golden output for "${name}": run with UPDATE_PDF_GOLDEN=1`).toBeDefined();
  expect(got).toEqual(golden[name]);
}

// ─── The tests ──────────────────────────────────────────────────────────────

const corpus = (JSON.parse(readFileSync(CORPUS, 'utf8')) as { cases: CorpusCase[] }).cases;
const drawable = corpus.filter((c) => !needsACanvas(c.html));

describe('PDF export golden output (DSK-242)', () => {
  it('leaves out only the cases that need a canvas', () => {
    const left = corpus.filter((c) => needsACanvas(c.html)).map((c) => c.name);
    expect(left).toEqual(['math_inline_mid_sentence', 'math_block_alone', 'inline_atom_is_a_paragraphs_only_child']);
  });

  for (const c of drawable) {
    it(`corpus: ${c.name}`, async () => {
      await check(`corpus/${c.name}`, [{ id: c.name, name: c.name, content: content(c.html) }]);
    }, 30_000);
  }

  it('corpus: every case as its own page of one export', async () => {
    await check('corpus-as-pages', drawable.map((c) => ({ id: c.name, name: c.name, content: content(c.html) })));
  }, 60_000);

  it('long: a report over several pages, with a heading link and a web link', async () => {
    await check('long/report', [{ id: 'report', name: 'Report', content: content(longReport()) }]);
  }, 30_000);

  it('long: a table that breaks across pages', async () => {
    await check('long/table', [{ id: 'table', name: 'Table', content: content(longTable()) }]);
  }, 30_000);

  it('long: a code block, a quote and a task list past a page each', async () => {
    await check('long/blocks', [{ id: 'blocks', name: 'Blocks', content: content(longBlocks()) }]);
  }, 30_000);

  it('keeps every line of a code block taller than a page (DSK-251)', async () => {
    // Drawn in one piece, a block this long ran off the page and lost its end.
    const pages = [{ id: 'blocks', name: 'Blocks', content: content(longBlocks()) }];
    const blob = await exportToPdf(DEFAULT_PDF_OPTIONS, pages[0]!.content, undefined, pages);
    const { text } = await readBack(new Uint8Array(await blobBytes(blob)));
    const lines = new Set(text.flat().flatMap((line) => [...line.matchAll(/const line(\d+) =/g)].map((m) => m[1])));
    expect(lines.size).toBe(90);
  }, 30_000);

  it('writes every stream compressed (DSK-250)', async () => {
    // Uncompressed, the fonts and page contents make an export about four times
    // the size. Every stream, fonts included, must carry a Flate filter.
    const pages = [{ id: 'report', name: 'Report', content: content(longReport()) }];
    const blob = await exportToPdf(DEFAULT_PDF_OPTIONS, pages[0]!.content, undefined, pages);
    const raw = new TextDecoder('latin1').decode(new Uint8Array(await blobBytes(blob)));
    const streams = raw.match(/\bstream\r?\n/g)?.length ?? 0;
    expect(streams).toBeGreaterThan(0);
    expect(raw.match(/\/Filter\s*\/FlateDecode/g)?.length ?? 0).toBe(streams);
  }, 30_000);

  it('embeds the document’s font, and keeps every word (DSK-246)', async () => {
    const pages = [{ id: 'report', name: 'Report', content: content(longReport()) }];
    const exported = async (fontFamily?: string) => {
      // Page numbers and the contents page change with the page count, so leave
      // them out: what must match is the text itself.
      const furnitureless = { ...DEFAULT_PDF_OPTIONS, showPageNumbers: false, includeTableOfContents: false };
      const options = { ...furnitureless, ...(fontFamily !== undefined && { fontFamily }) };
      const bytes = new Uint8Array(await blobBytes(await exportToPdf(options, pages[0]!.content, undefined, pages)));
      const fonts = new Set(new TextDecoder('latin1').decode(bytes).match(/\/BaseFont\s*\/\w+/g));
      const words = (await readBack(bytes)).text.flat().join(' ').split(/\s+/).filter(Boolean);
      return { fonts, words };
    };
    const inter = await exported();
    const serif = await exported("'Source Serif 4', serif");
    expect(inter.fonts.has('/BaseFont /Inter')).toBe(true);
    expect(serif.fonts.has('/BaseFont /SourceSerif4')).toBe(true);
    expect(serif.fonts.has('/BaseFont /Inter'), 'only the document’s font is embedded').toBe(false);
    // Another font wraps lines elsewhere, but says the same thing.
    expect(serif.words).toEqual(inter.words);
    // A font the PDF can't embed falls back to the bundled font of its kind.
    expect((await exported("'Comic Sans MS', cursive")).fonts.has('/BaseFont /Caveat')).toBe(true);
    expect((await exported("'Atkinson Hyperlegible', sans-serif")).fonts.has('/BaseFont /Inter')).toBe(true);
  }, 60_000);

  it('found the paginator’s opening text at the top of the PDF’s pages (DSK-252)', () => {
    // Runs after the exports above: without it, a first-line check that never
    // matched a break would pass by checking nothing.
    expect(openedPages, 'breaks checked against the top of their page').toBeGreaterThan(20);
  });

  it('the golden file holds exactly the documents above', () => {
    if (UPDATE) return;
    const expected = [
      ...drawable.map((c) => `corpus/${c.name}`),
      'corpus-as-pages',
      'long/blocks',
      'long/report',
      'long/table',
    ].sort();
    expect(Object.keys(golden).sort()).toEqual(expected);
  });
});

// ─── Page-break rules (DSK-252) ─────────────────────────────────────────────

describe('page-break rules (DSK-252)', () => {
  const options = {
    ...DEFAULT_PDF_OPTIONS,
    coverPage: { ...DEFAULT_PDF_OPTIONS.coverPage, enabled: false },
    includeTableOfContents: false,
  };
  const onePage = (html: string): PDFRichTextPage[] => [{ id: 'page', name: 'Page', content: content(html) }];
  const layoutOfHtml = (html: string) => paginate(options, onePage(html)[0]!.content, undefined, onePage(html));

  /**
   * Filler that puts what comes next at many heights on the page: a first
   * paragraph of about `lines` lines, then `count` one-line paragraphs.
   */
  const filler = (lines: number, count: number): string =>
    `<p>${sentence(1, lines * 10 - 4)}</p>` +
    Array.from({ length: count }, (_, i) => `<p>${sentence(i + 2, 6)}</p>`).join('');

  it('keeps a heading with the first two lines after it', async () => {
    let movedHeadings = 0;
    for (let lines = 1; lines <= 4; lines++) {
      for (let count = 15; count <= 40; count++) {
        const heading = count + 1;
        const { breaks } = await layoutOfHtml(`${filler(lines, count)}<h4>Next section</h4><p>${sentence(99, 60)}</p>`);
        for (const b of breaks) {
          if (b.at.kind === 'block' && b.at.path[0] === heading) movedHeadings++;
          if ((b.at.kind === 'block' || b.at.kind === 'line') && b.at.path[0] === heading + 1) {
            // The paragraph after the heading may break only after its second line.
            expect(b.at.kind === 'line' && b.at.line >= 2, `${lines}/${count}: ${JSON.stringify(b.at)}`).toBe(true);
          }
        }
      }
    }
    expect(movedHeadings, 'some filler left the heading at the foot of a page').toBeGreaterThan(0);
  }, 120_000);

  it('lets a heading stay when the start of what follows doesn’t fit on any page', async () => {
    // The code block fits on a page alone, but not with the heading: no rule
    // can keep them together, so the layout must still finish.
    const code = Array.from({ length: 44 }, (_, i) => `const v${i} = ${i};`).join('\n');
    const layout = await layoutOfHtml(`${filler(1, 20)}<h1>Listing</h1><pre><code>${code}</code></pre><p>After.</p>`);
    expect(layout.pages).toBeGreaterThanOrEqual(2);
    expect(layout.pages).toBeLessThan(5);
  }, 30_000);

  it('starts a table with its header and first row, and repeats the header', async () => {
    const tall = sentence(5, 30); // a first body row three lines tall
    const rows = Array.from({ length: 30 }, (_, r) => `<tr><td><p>${r === 0 ? tall : `Row ${r}`}</p></td><td><p>${sentence(r, 3)}</p></td></tr>`);
    const table = `<table><tbody><tr><th><p>Item</p></th><th><p>Notes</p></th></tr>${rows.join('')}</tbody></table>`;
    let movedTables = 0;
    let rowBreaks = 0;
    for (let lines = 1; lines <= 4; lines++) {
      for (let count = 15; count <= 40; count++) {
        const tableIndex = count + 1;
        const { breaks } = await layoutOfHtml(`${filler(lines, count)}${table}`);
        for (const b of breaks) {
          if (b.at.kind === 'block' && b.at.path[0] === tableIndex) movedTables++;
          if (b.at.kind === 'row' && b.at.path[0] === tableIndex) {
            rowBreaks++;
            expect(b.at.row, `${lines}/${count}: the header would be left alone`).not.toBe(1);
            expect(b.at.header, 'the header is drawn again above the row').toBe(1);
          }
        }
      }
    }
    expect(movedTables, 'some filler left only the header room').toBeGreaterThan(0);
    expect(rowBreaks).toBeGreaterThan(0);
  }, 120_000);

  it('splits a row taller than a page by lines, keeping every word', async () => {
    const words = Array.from({ length: 1500 }, (_, i) => `w${String(i).padStart(4, '0')}`);
    const html = `<table><tbody><tr><th><p>Head</p></th><th><p>Side</p></th></tr>` +
      `<tr><td><p>${words.join(' ')}</p></td><td><p>short</p></td></tr></tbody></table>`;
    const pages = onePage(html);
    const { blob, layout } = await exportToPdfWithLayout(options, pages[0]!.content, undefined, pages);
    const { text } = await readBack(new Uint8Array(await blobBytes(blob)));
    const printed = text.flat().join(' ').split(/\s+/).filter((w) => /^w\d{4}$/.test(w));
    expect(printed).toEqual(words);
    const splits = layout.breaks.filter((b) => b.at.kind === 'row' && b.at.row === 1);
    expect(splits.length, 'the row continues over several pages').toBeGreaterThanOrEqual(2);
    for (const b of splits) {
      expect(text[b.page - 1]?.[0], `page ${b.page} opens with the header`).toBe('Head Side');
    }
  }, 60_000);

  it('draws a quote’s bar on every page it spans', async () => {
    const pdf = new jsPDF({ unit: 'mm', compress: true });
    const textFont = await registerPDFFonts(pdf, pdfFontFor(undefined));
    class RecordingDoc extends MeasureDoc {
      page = 1;
      lines: Array<{ page: number; x: number }> = [];
      override addPage(): void {
        super.addPage();
        this.page = this.getNumberOfPages();
      }
      override setPage(pageNumber: number): void {
        this.page = pageNumber;
      }
      override line(x1: number, _y1: number, x2: number): void {
        if (x1 === x2) this.lines.push({ page: this.page, x: x1 });
      }
    }
    const doc = new RecordingDoc(pdf);
    const quote = Array.from({ length: 60 }, (_, i) => `<p>${sentence(i, 40)}</p>`).join('');
    const pages = onePage(`<p>Before.</p><blockquote>${quote}</blockquote>`);
    const ctx = await layOut(doc, textFont, {
      options, richTextContent: pages[0]!.content, themeBackground: undefined, richTextPages: pages, canvasPages: undefined,
    });
    const barX = ctx.marginLeft + 2;
    const barPages = [...new Set(doc.lines.filter((l) => l.x === barX).map((l) => l.page))].sort((a, b) => a - b);
    expect(barPages.length, 'the quote spans at least three pages').toBeGreaterThanOrEqual(3);
    expect(barPages).toEqual(Array.from({ length: barPages.length }, (_, i) => barPages[0]! + i));
  }, 60_000);
});

describe('re-layout from an edited block (DSK-252)', () => {
  const options = { ...DEFAULT_PDF_OPTIONS, coverPage: { ...DEFAULT_PDF_OPTIONS.coverPage, enabled: false } };
  const documents: Array<[string, PDFRichTextPage[]]> = [
    ['long/report', [{ id: 'report', name: 'Report', content: content(longReport()) }]],
    ['long/blocks', [{ id: 'blocks', name: 'Blocks', content: content(longBlocks()) }]],
    ['long/table', [{ id: 'table', name: 'Table', content: content(longTable()) }]],
    ['corpus-as-pages', drawable.map((c) => ({ id: c.name, name: c.name, content: content(c.html) }))],
  ];

  for (const [name, pages] of documents) {
    it(`${name}: laying out again from any block gives the full layout`, async () => {
      const full = await paginate(options, pages[0]!.content, undefined, pages);
      expect(full.starts.length).toBeGreaterThan(0);
      for (const start of full.starts) {
        const pageId = pages[start.prosePage]!.id!;
        const again = await relayoutFrom(full, { pageId, block: start.block }, options, pages[0]!.content, undefined, pages);
        expect(again, `${name}: from block ${start.block} of page ${pageId}`).toEqual(full);
      }
    }, 120_000);
  }

  /** long/report with its top-level blocks changed by `change`. */
  const editedReport = (change: (blocks: JSONContent[]) => void): PDFRichTextPage[] => {
    const page = { id: 'report', name: 'Report', content: content(longReport()) };
    const doc = structuredClone(page.content.content) as JSONContent;
    change(doc.content!);
    return [{ ...page, content: { ...page.content, content: doc } }];
  };

  const edits: Array<[string, number, (blocks: JSONContent[]) => void]> = [
    ['a paragraph inserted', 9, (blocks) => blocks.splice(9, 0, { type: 'paragraph', content: [{ type: 'text', text: sentence(500, 90) }] })],
    ['a paragraph deleted', 12, (blocks) => blocks.splice(12, 1)],
    // Block 10 is the paragraph right after "Section 2": the heading's rule looks at it.
    ['the paragraph after a heading shortened', 10, (blocks) => { blocks[10] = { type: 'paragraph', content: [{ type: 'text', text: 'Short.' }] }; }],
    // Block 8 is the list right after "Detail 1".
    ['the list after a heading replaced', 8, (blocks) => { blocks[8] = { type: 'paragraph', content: [{ type: 'text', text: sentence(600, 120) }] }; }],
  ];

  for (const [what, block, change] of edits) {
    it(`long/report, ${what}: laying out from the edit gives what a full layout gives`, async () => {
      const before = [{ id: 'report', name: 'Report', content: content(longReport()) }];
      const previous = await paginate(options, before[0]!.content, undefined, before);
      const after = editedReport(change);
      const expected = await paginate(options, after[0]!.content, undefined, after);
      const again = await relayoutFrom(previous, { pageId: 'report', block }, options, after[0]!.content, undefined, after);
      expect(again).toEqual(expected);
    }, 60_000);
  }

  it('lays out again the heading before an edited block, since its rule looks ahead', async () => {
    const opts = { ...options, includeTableOfContents: false };
    const filler = (count: number): string => Array.from({ length: count }, (_, i) => `<p>${sentence(i + 2, 6)}</p>`).join('');
    const code = Array.from({ length: 30 }, (_, i) => `const v${i} = ${i};`).join('\n');
    let headingDecisionChanged = 0;
    for (let count = 15; count <= 40; count++) {
      const edited = count + 1; // the block after the heading
      const before = [{ id: 'p', name: 'P', content: content(`${filler(count)}<h4>Listing</h4><p>Short.</p>`) }];
      const after = [{ id: 'p', name: 'P', content: content(`${filler(count)}<h4>Listing</h4><pre><code>${code}</code></pre>`) }];
      const previous = await paginate(opts, before[0]!.content, undefined, before);
      const expected = await paginate(opts, after[0]!.content, undefined, after);
      const headingMoved = (l: PdfLayout) => l.breaks.some((b) => b.at.kind === 'block' && b.at.path[0] === count);
      if (headingMoved(previous) !== headingMoved(expected)) headingDecisionChanged++;
      const again = await relayoutFrom(previous, { pageId: 'p', block: edited }, opts, after[0]!.content, undefined, after);
      expect(again, `count ${count}`).toEqual(expected);
    }
    expect(headingDecisionChanged, 'some edit moved the heading').toBeGreaterThan(0);
  }, 120_000);

  it('the blocks edited above follow headings', () => {
    const blocks = content(longReport()).content.content!;
    expect(blocks.slice(7, 11).map((b) => b.type)).toEqual(['heading', 'bulletList', 'heading', 'paragraph']);
  });
});

describe('Paper Mode’s break positions (DSK-48)', () => {
  // Each break inside a prose page maps to a position in that page's editor
  // document, and the text there is what opens the exported PDF's page.
  const options = { ...DEFAULT_PDF_OPTIONS, coverPage: { ...DEFAULT_PDF_OPTIONS.coverPage, enabled: false } };
  const documents: Array<[string, PDFRichTextPage[]]> = [
    ['long/report', [{ id: 'report', name: 'Report', content: content(longReport()) }]],
    ['long/blocks', [{ id: 'blocks', name: 'Blocks', content: content(longBlocks()) }]],
    ['long/table', [{ id: 'table', name: 'Table', content: content(longTable()) }]],
    ['corpus-as-pages', drawable.map((c) => ({ id: c.name, name: c.name, content: content(c.html) }))],
  ];

  it('places every break at the text that opens its PDF page', async () => {
    let placed = 0;
    for (const [name, pages] of documents) {
      const layout = await paginate(options, pages[0]!.content, undefined, pages);
      const printed = golden[name]!;
      expect(layout.pages + layout.contentsPages, `${name}: the page count shown is the PDF's`).toBe(printed.pages);
      for (const b of layout.breaks) {
        const page = pages.find((p) => p.id === b.pageId)!;
        const doc = schema.nodeFromJSON(page.content.content);
        const at = positionOfBreak(doc, b.at);
        if (b.at.kind === 'section') {
          expect(at, `${name}: a prose page's own start isn't inside it`).toBeNull();
          continue;
        }
        expect(at, `${name}: ${JSON.stringify(b.at)}`).not.toBeNull();
        const text = at!.kind === 'row'
          ? doc.textBetween(at!.pos, at!.end, ' ')
          : doc.textBetween(at!.pos, Math.min(doc.content.size, at!.pos + 200), ' ', ' ');
        const word = text.trim().split(/\s+/)[0]!;
        // The top of the page: a callout's label or a repeated table header can
        // come first, and an ordered list's number sits against its first word.
        const top = (printed.text[b.page + layout.contentsPages - 1] ?? []).slice(0, 2).join(' ').replace(/(^|\s)\d+\./g, '$1');
        expect(top.split(/\s+/), `${name}: page ${b.page} opens with "${word}"`).toContain(word);
        placed++;
      }
    }
    expect(placed, 'breaks placed in the editor').toBeGreaterThan(8);
  }, 120_000);

  it('places nothing for a path that no longer resolves', () => {
    const doc = schema.nodeFromJSON(content('<p>One</p>').content);
    expect(positionOfBreak(doc, { kind: 'block', path: [3] })).toBeNull();
    expect(positionOfBreak(doc, { kind: 'row', path: [0], row: 0 })).toBeNull();
  });
});
