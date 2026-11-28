/**
 * DSK-244 spike (a probe, not for merge): what it costs the PDF exporter to lay
 * out a long document. A full export, drawing included, is an upper bound for a
 * measure-only pagination pass that would run as the user edits.
 *
 * Each document is exported twice and the second run is timed, so font loading
 * and warm-up don't count. jsdom is slower than a browser, so these are upper
 * bounds too. Run: bun run test src/utils/paginatorSpike.test.ts
 */
import { describe, it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';
import { DOMParser as PMDOMParser, type Schema } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import { sharedProseExtensions } from '../ui/TiptapEditor';
import { DEFAULT_PDF_OPTIONS } from '../types/PDFExport';
import type { RichTextContent } from '../types/RichText';
import { exportToPdf } from './pdfExportUtils';

const schema: Schema = getSchema([
  StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] }, codeBlock: false, history: false }),
  ...sharedProseExtensions,
]);

function content(html: string): RichTextContent {
  const container = document.createElement('div');
  container.innerHTML = html;
  return { content: PMDOMParser.fromSchema(schema).parse(container).toJSON(), version: 1 };
}

const VOCABULARY = [
  'canvas', 'document', 'relay', 'shape', 'prose', 'export', 'layout', 'citation',
  'page', 'table', 'diagram', 'heading', 'outline', 'figure', 'source', 'review',
];
function sentence(seed: number, words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(VOCABULARY[(seed * 7 + i * 3 + (i >> 2)) % VOCABULARY.length]!);
  return `${out.join(' ')}.`;
}

/** Roughly a page: a heading, paragraphs, a list, a table and a code block. */
function section(s: number): string {
  const rows = [1, 2, 3, 4].map(
    (r) => `<tr><td><p>${sentence(s * 10 + r, 3)}</p></td><td><p>${sentence(s * 20 + r, 4)}</p></td><td><p>${r * s}</p></td></tr>`,
  );
  const code = Array.from({ length: 8 }, (_, i) => `const value${i} = compute(${s}, ${i}); // step ${i}`).join('\n');
  return [
    `<h2>Section ${s}</h2>`,
    `<p>${sentence(s, 80)}</p>`,
    `<p>${sentence(s + 1, 60)}</p>`,
    `<ul>${[1, 2, 3, 4].map((i) => `<li><p>${sentence(s * 100 + i, 12)}</p></li>`).join('')}</ul>`,
    `<table><tr><th><p>Item</p></th><th><p>Detail</p></th><th><p>Count</p></th></tr>${rows.join('')}</table>`,
    `<pre><code>${code}</code></pre>`,
    `<p>${sentence(s + 2, 50)}</p>`,
  ].join('');
}

/** jsdom's Blob has no `arrayBuffer()`; its FileReader does the job (as in the golden test). */
function blobBytes(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolveBytes, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolveBytes(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

async function pageCount(blob: Blob): Promise<number> {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await blobBytes(blob)) }).promise;
  return pdf.numPages;
}

describe('DSK-244 spike: the exporter’s layout cost', () => {
  for (const sections of [10, 25, 50]) {
    it(`lays out ${sections} sections`, async () => {
      const rich = content(Array.from({ length: sections }, (_, i) => section(i + 1)).join(''));
      await exportToPdf(DEFAULT_PDF_OPTIONS, rich);
      const start = performance.now();
      const blob = await exportToPdf(DEFAULT_PDF_OPTIONS, rich);
      const ms = performance.now() - start;
      const pages = await pageCount(blob);
      console.log(`DSK-244 | ${sections} sections | ${pages} pages | ${ms.toFixed(0)} ms | ${(ms / pages).toFixed(1)} ms/page`);
      expect(pages).toBeGreaterThan(0);
    }, 180_000);
  }
});
