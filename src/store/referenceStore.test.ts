/**
 * Tests for referenceStore (JP-89 slice 1).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useReferenceStore } from './referenceStore';
import type { CSLItem, ReferenceLibrary } from '../types/Citation';

function item(id: string, title = `Title ${id}`): CSLItem {
  return { id, type: 'article-journal', title };
}

beforeEach(() => {
  useReferenceStore.getState().clear();
});

describe('referenceStore CRUD', () => {
  it('adds references and preserves insertion order', () => {
    const s = useReferenceStore.getState();
    s.addReference(item('a'));
    s.addReference(item('b'));
    s.addReference(item('c'));

    expect(useReferenceStore.getState().listReferences().map((r) => r.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('generates an id when an item arrives without a citekey', () => {
    const id = useReferenceStore.getState().addReference({ id: '', type: 'book' });
    expect(id).toMatch(/^ref-/);
    expect(useReferenceStore.getState().getReference(id)?.type).toBe('book');
  });

  it('upserts by id without duplicating the order entry', () => {
    const s = useReferenceStore.getState();
    s.addReference(item('a', 'first'));
    s.upsertReference(item('a', 'second'));

    const state = useReferenceStore.getState();
    expect(state.itemOrder).toEqual(['a']);
    expect(state.getReference('a')?.title).toBe('second');
  });

  it('updates a reference via shallow merge, never re-keying it', () => {
    const s = useReferenceStore.getState();
    s.addReference(item('a'));
    s.updateReference('a', { title: 'patched', DOI: '10.1/x' });

    const ref = useReferenceStore.getState().getReference('a');
    expect(ref?.id).toBe('a');
    expect(ref?.title).toBe('patched');
    expect(ref?.DOI).toBe('10.1/x');
  });

  it('updateReference is a no-op for an unknown id', () => {
    useReferenceStore.getState().updateReference('missing', { title: 'x' });
    expect(useReferenceStore.getState().getReference('missing')).toBeUndefined();
  });

  it('removes a reference from both items and order', () => {
    const s = useReferenceStore.getState();
    s.addReference(item('a'));
    s.addReference(item('b'));
    s.removeReference('a');

    const state = useReferenceStore.getState();
    expect(state.getReference('a')).toBeUndefined();
    expect(state.itemOrder).toEqual(['b']);
  });

  it('clear() empties the library', () => {
    const s = useReferenceStore.getState();
    s.addReference(item('a'));
    s.clear();

    const state = useReferenceStore.getState();
    expect(state.itemOrder).toEqual([]);
    expect(state.listReferences()).toEqual([]);
  });
});

describe('referenceStore serialize / load round-trip', () => {
  it('round-trips serialize() -> loadReferences()', () => {
    const s = useReferenceStore.getState();
    s.addReference(item('a'));
    s.addReference(item('b'));
    const serialized = useReferenceStore.getState().serialize();

    s.clear();
    expect(useReferenceStore.getState().itemOrder).toEqual([]);

    useReferenceStore.getState().loadReferences(serialized);
    expect(useReferenceStore.getState().serialize()).toEqual(serialized);
  });

  it('degrades malformed input to an empty library without throwing', () => {
    useReferenceStore.getState().addReference(item('a'));
    // Deliberately malformed shape.
    useReferenceStore
      .getState()
      .loadReferences({ itemOrder: 'nope' } as unknown as ReferenceLibrary);

    const state = useReferenceStore.getState();
    expect(state.items).toEqual({});
    expect(state.itemOrder).toEqual([]);
  });

  it('normalizes inconsistent order vs items on load', () => {
    const lib: ReferenceLibrary = {
      items: { a: item('a'), b: item('b') },
      // order references a ghost id and omits a real one.
      itemOrder: ['a', 'ghost'],
    };
    useReferenceStore.getState().loadReferences(lib);

    const state = useReferenceStore.getState();
    expect(state.itemOrder).toContain('a');
    expect(state.itemOrder).toContain('b');
    expect(state.itemOrder).not.toContain('ghost');
    expect(state.itemOrder).toHaveLength(2);
  });
});
