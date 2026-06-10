/**
 * Tests for reference import + dedup (JP-89 slice 2).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { dedupeReferences, importReferences } from './referenceImport';
import { useReferenceStore } from '../../store/referenceStore';
import type { CSLItem } from '../../types/Citation';

function item(id: string, extra: Partial<CSLItem> = {}): CSLItem {
  return { id, type: 'article-journal', title: `Title ${id}`, ...extra };
}

describe('dedupeReferences', () => {
  it('treats a shared id as a duplicate', () => {
    const { unique, duplicates } = dedupeReferences([item('a')], [item('a'), item('b')]);
    expect(unique.map((i) => i.id)).toEqual(['b']);
    expect(duplicates.map((i) => i.id)).toEqual(['a']);
  });

  it('treats a shared DOI (case-insensitive, different id) as a duplicate', () => {
    const existing = [item('a', { DOI: '10.1/X' })];
    const incoming = [item('b', { DOI: '10.1/x' })];
    const { unique, duplicates } = dedupeReferences(existing, incoming);
    expect(unique).toEqual([]);
    expect(duplicates.map((i) => i.id)).toEqual(['b']);
  });

  it('dedups within the incoming batch itself', () => {
    const incoming = [item('a', { DOI: '10.1/x' }), item('b', { DOI: '10.1/x' })];
    const { unique, duplicates } = dedupeReferences([], incoming);
    expect(unique.map((i) => i.id)).toEqual(['a']);
    expect(duplicates.map((i) => i.id)).toEqual(['b']);
  });

  it('keeps items with no DOI distinct when ids differ', () => {
    const { unique } = dedupeReferences([item('a')], [item('b'), item('c')]);
    expect(unique.map((i) => i.id)).toEqual(['b', 'c']);
  });
});

describe('importReferences', () => {
  beforeEach(() => {
    useReferenceStore.getState().clear();
  });

  it('adds new references to the store', () => {
    const result = importReferences([item('a'), item('b')]);
    expect(result).toEqual({ added: 2, duplicates: 0 });
    expect(useReferenceStore.getState().listReferences().map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('skips items already in the library', () => {
    importReferences([item('a', { DOI: '10.1/x' })]);
    const result = importReferences([item('a-again', { DOI: '10.1/x' }), item('c')]);
    expect(result).toEqual({ added: 1, duplicates: 1 });
    expect(useReferenceStore.getState().listReferences().map((r) => r.id)).toEqual(['a', 'c']);
  });
});
