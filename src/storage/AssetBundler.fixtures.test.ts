/**
 * Cross-language blob-reference parity test (JP-494).
 *
 * Loads `relay/tests/blob-ref-fixtures/cases.json` and asserts the client
 * walker (`deriveBlobReferences`) returns exactly the expected hashes. A
 * matching Rust test (`relay/src/api.rs#blob_ref_fixture_tests`) consumes the
 * same file, so the client and relay walkers cannot drift apart.
 *
 * They had drifted once: the relay scanned inside strings and found a prose
 * page's `<img src="blob://…">`; the client only matched whole strings and
 * missed them, so the GC swept blobs that were still referenced.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deriveBlobReferences, collectBlobReferences } from './AssetBundler';
import type { DiagramDocument } from '../types/Document';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../../relay/tests/blob-ref-fixtures/cases.json');

interface Case {
  name: string;
  why: string;
  doc: Record<string, unknown>;
  expected: string[];
}

function loadCases(): Case[] {
  const raw = readFileSync(FIXTURES, 'utf8');
  return (JSON.parse(raw) as { cases: Case[] }).cases;
}

describe('blob-reference fixtures (cross-language)', () => {
  const cases = loadCases();

  it('discovers the shared fixtures', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    it(`${c.name} — ${c.why.split('.')[0]}`, () => {
      const found = deriveBlobReferences(c.doc as unknown as DiagramDocument);
      expect([...found].sort()).toEqual([...c.expected].sort());
    });
  }

  it('derive ignores the stored blobReferences array, collect unions it', () => {
    // The distinction that makes refcounts able to shrink: a recompute must not
    // resurrect a reference the content no longer has.
    const stale = 'f'.repeat(64);
    const doc = { blobReferences: [stale], pages: {} } as unknown as DiagramDocument;

    expect(deriveBlobReferences(doc)).toEqual([]);
    expect(collectBlobReferences(doc)).toEqual([stale]);
  });
});
