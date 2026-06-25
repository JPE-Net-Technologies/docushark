import { describe, it, expect } from 'vitest';
import { migrateDocument, DocumentVersionError } from './documentMigrations';
import { createDocument, DOCUMENT_VERSION, type DiagramDocument } from '../types/Document';

function sampleDoc(overrides: Partial<DiagramDocument> = {}): DiagramDocument {
  return { ...createDocument('Sample', 'doc-1', 'page-1'), ...overrides };
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
