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

import { getSchema } from '@tiptap/core';
import { DOMParser as PMDOMParser, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
// Defines `globalThis.pdfjsWorker`, so pdf.js parses in this thread instead of
// looking for a worker file.
import 'pdfjs-dist/legacy/build/pdf.worker.mjs';

import { sharedProseExtensions } from '../ui/TiptapEditor';
import { DEFAULT_PDF_OPTIONS } from '../types/PDFExport';
import type { RichTextContent } from '../types/RichText';
import { exportToPdf, type PDFRichTextPage } from './pdfExportUtils';

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
  const text = new TextDecoder('latin1').decode(bytes)
    .replace(/\/CreationDate \(D:[^)]*\)/g, '/CreationDate (D:0)')
    .replace(/\/ID \[ ?<[0-9A-Fa-f]+> ?<[0-9A-Fa-f]+> ?\]/g, '/ID [<0><0>]');
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
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

afterAll(() => {
  if (!UPDATE) return;
  const sorted = Object.fromEntries(Object.entries(produced).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(GOLDEN, `${JSON.stringify(sorted, null, 2)}\n`);
});

/** Export `pages` with the default options, then check what a reader gets out. */
async function check(name: string, pages: PDFRichTextPage[]): Promise<void> {
  const options = { ...DEFAULT_PDF_OPTIONS, coverPage: { ...DEFAULT_PDF_OPTIONS.coverPage, enabled: false } };
  const bytes = new Uint8Array(await blobBytes(await exportToPdf(options, pages[0]!.content, undefined, pages)));
  if (DUMP_DIR) {
    mkdirSync(DUMP_DIR, { recursive: true });
    writeFileSync(resolve(DUMP_DIR, `${name.replace(/\//g, '__')}.pdf`), stableBytes(bytes));
  }
  const got = await readBack(bytes);
  produced[name] = got;
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
