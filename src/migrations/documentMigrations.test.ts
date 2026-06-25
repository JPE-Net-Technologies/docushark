import { describe, it, expect } from 'vitest';
import { migrateDocument, DocumentVersionError } from './documentMigrations';
import { createDocument, DOCUMENT_VERSION, type DiagramDocument } from '../types/Document';
import type { GroupShape, RectangleShape } from '../shapes/Shape';

function sampleDoc(overrides: Partial<DiagramDocument> = {}): DiagramDocument {
  return { ...createDocument('Sample', 'doc-1', 'page-1'), ...overrides };
}

function group(id: string, ownerId?: string | null): GroupShape {
  const base: GroupShape = {
    id,
    type: 'group',
    x: 0,
    y: 0,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    fill: null,
    stroke: null,
    strokeWidth: 0,
    childIds: [],
  };
  return ownerId === undefined ? base : { ...base, ownerId };
}

function rect(id: string): RectangleShape {
  return {
    id,
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    fill: '#fff',
    stroke: '#000',
    strokeWidth: 1,
    cornerRadius: 0,
  };
}

describe('migrateDocument — version gate', () => {
  it('returns a current-version document unchanged (idempotent)', () => {
    const doc = sampleDoc();
    const out = migrateDocument(doc);
    expect(out.version).toBe(DOCUMENT_VERSION);
    // Running it again is a no-op.
    expect(migrateDocument(out)).toEqual(out);
  });

  it('stamps the current version onto a document with a missing version', () => {
    // Force an old/missing stamp the way a pre-versioning document on disk would look.
    const doc = sampleDoc({ version: undefined as unknown as number });
    const out = migrateDocument(doc);
    expect(out.version).toBe(DOCUMENT_VERSION);
  });

  it('throws DocumentVersionError for a document newer than this build', () => {
    const doc = sampleDoc({ version: DOCUMENT_VERSION + 1 });
    expect(() => migrateDocument(doc)).toThrow(DocumentVersionError);
    try {
      migrateDocument(doc);
    } catch (e) {
      expect(e).toBeInstanceOf(DocumentVersionError);
      const err = e as DocumentVersionError;
      expect(err.documentVersion).toBe(DOCUMENT_VERSION + 1);
      expect(err.supportedVersion).toBe(DOCUMENT_VERSION);
    }
  });

  it('preserves document content through the gate (no data loss)', () => {
    const doc = sampleDoc();
    const out = migrateDocument(doc);
    expect(out.id).toBe(doc.id);
    expect(out.name).toBe(doc.name);
    expect(out.pages).toEqual(doc.pages);
    expect(out.pageOrder).toEqual(doc.pageOrder);
    expect(out.activePageId).toBe(doc.activePageId);
  });
});

describe('migrateDocument — v2 invariants (JP-347)', () => {
  it('stamps ownerId: null on a group missing it, preserving set owners', () => {
    const doc = sampleDoc();
    doc.pages['page-1']!.shapes = {
      g1: group('g1'), // ownerId undefined
      g2: group('g2', 'user-7'), // explicit owner kept
      g3: group('g3', null), // already null
    };
    doc.pages['page-1']!.shapeOrder = ['g1', 'g2', 'g3'];

    const out = migrateDocument(doc);
    const shapes = out.pages['page-1']!.shapes;
    expect((shapes['g1'] as GroupShape).ownerId).toBeNull();
    expect((shapes['g2'] as GroupShape).ownerId).toBe('user-7');
    expect((shapes['g3'] as GroupShape).ownerId).toBeNull();
  });

  it('does not touch non-group shapes', () => {
    const doc = sampleDoc();
    doc.pages['page-1']!.shapes = { r1: rect('r1') };
    const out = migrateDocument(doc);
    expect(out.pages['page-1']!.shapes['r1']).toEqual(rect('r1'));
  });

  it('repoints a dangling canvas activePageId to a real page', () => {
    const doc = sampleDoc({ activePageId: 'ghost-page' });
    const out = migrateDocument(doc);
    expect(out.activePageId).toBe('page-1');
  });

  it('repoints a dangling prose activePageId; nulls it when there are no prose pages', () => {
    const withDangling = sampleDoc({
      richTextPages: { pages: { p1: { id: 'p1', name: 'A', content: '<p/>', order: 0, createdAt: 0, modifiedAt: 0 } }, pageOrder: ['p1'], activePageId: 'ghost' },
    });
    expect(migrateDocument(withDangling).richTextPages!.activePageId).toBe('p1');

    const empty = sampleDoc({ richTextPages: { pages: {}, pageOrder: [], activePageId: 'ghost' } });
    expect(migrateDocument(empty).richTextPages!.activePageId).toBeNull();
  });

  it('round-trips a v1 document to v2 with no data loss', () => {
    const v1 = sampleDoc({ version: 1 });
    v1.pages['page-1']!.shapes = { g1: group('g1'), r1: rect('r1') };
    v1.pages['page-1']!.shapeOrder = ['g1', 'r1'];
    v1.references = { items: {}, itemOrder: [] };
    v1.fields = { fields: {}, order: [] };

    const out = migrateDocument(v1);
    expect(out.version).toBe(DOCUMENT_VERSION);
    // content preserved
    expect(out.pages['page-1']!.shapeOrder).toEqual(['g1', 'r1']);
    expect(out.pages['page-1']!.shapes['r1']).toEqual(rect('r1'));
    expect(out.references).toEqual(v1.references);
    expect(out.fields).toEqual(v1.fields);
    // invariant applied
    expect((out.pages['page-1']!.shapes['g1'] as GroupShape).ownerId).toBeNull();
    // idempotent
    expect(migrateDocument(out)).toEqual(out);
  });
});
