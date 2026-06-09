import { beforeEach, describe, expect, it } from 'vitest';
import { useCollectionStore } from './collectionStore';

function reset() {
  useCollectionStore.getState().reset();
}

describe('collectionStore', () => {
  beforeEach(reset);

  it('creates collections with unique ids and incrementing order', () => {
    const { createCollection, listCollections } = useCollectionStore.getState();
    const a = createCollection('Work');
    const b = createCollection('Personal', '#3b82f6');
    expect(a).not.toBe('');
    expect(b).not.toBe('');
    expect(a).not.toBe(b);

    const collections = listCollections();
    expect(collections).toHaveLength(2);
    expect(collections[0]?.name).toBe('Work');
    expect(collections[0]?.order).toBe(0);
    expect(collections[1]?.name).toBe('Personal');
    expect(collections[1]?.color).toBe('#3b82f6');
    expect(collections[1]?.order).toBe(1);
  });

  it('ignores empty collection names', () => {
    const id = useCollectionStore.getState().createCollection('   ');
    expect(id).toBe('');
    expect(useCollectionStore.getState().listCollections()).toHaveLength(0);
  });

  it('renames collections, trimming whitespace', () => {
    const id = useCollectionStore.getState().createCollection('Old');
    useCollectionStore.getState().renameCollection(id, '  New Name  ');
    expect(useCollectionStore.getState().collections[id]?.name).toBe('New Name');
  });

  it('does not rename to empty', () => {
    const id = useCollectionStore.getState().createCollection('Keep');
    useCollectionStore.getState().renameCollection(id, '   ');
    expect(useCollectionStore.getState().collections[id]?.name).toBe('Keep');
  });

  it('assigns and reassigns a document to collections', () => {
    const a = useCollectionStore.getState().createCollection('A');
    const b = useCollectionStore.getState().createCollection('B');
    useCollectionStore.getState().assignDocument('doc-1', a);
    expect(useCollectionStore.getState().getCollectionForDocument('doc-1')?.id).toBe(a);
    useCollectionStore.getState().assignDocument('doc-1', b);
    expect(useCollectionStore.getState().getCollectionForDocument('doc-1')?.id).toBe(b);
    useCollectionStore.getState().assignDocument('doc-1', null);
    expect(useCollectionStore.getState().getCollectionForDocument('doc-1')).toBeUndefined();
  });

  it('ignores assignment to unknown collection', () => {
    useCollectionStore.getState().assignDocument('doc-1', 'nonexistent');
    expect(useCollectionStore.getState().getCollectionForDocument('doc-1')).toBeUndefined();
  });

  it('assignMany applies to all documents', () => {
    const a = useCollectionStore.getState().createCollection('A');
    useCollectionStore.getState().assignMany(['d1', 'd2', 'd3'], a);
    expect(useCollectionStore.getState().assignments).toEqual({ d1: a, d2: a, d3: a });
    useCollectionStore.getState().assignMany(['d1', 'd3'], null);
    expect(useCollectionStore.getState().assignments).toEqual({ d2: a });
  });

  it('deleting a collection unassigns its documents but leaves others intact', () => {
    const a = useCollectionStore.getState().createCollection('A');
    const b = useCollectionStore.getState().createCollection('B');
    useCollectionStore.getState().assignMany(['d1', 'd2'], a);
    useCollectionStore.getState().assignDocument('d3', b);
    useCollectionStore.getState().deleteCollection(a);
    const state = useCollectionStore.getState();
    expect(state.collections[a]).toBeUndefined();
    expect(state.assignments).toEqual({ d3: b });
  });

  it('recolorCollection sets and clears color', () => {
    const id = useCollectionStore.getState().createCollection('A', '#ef4444');
    useCollectionStore.getState().recolorCollection(id, '#10b981');
    expect(useCollectionStore.getState().collections[id]?.color).toBe('#10b981');
    useCollectionStore.getState().recolorCollection(id, undefined);
    expect(useCollectionStore.getState().collections[id]?.color).toBeUndefined();
  });

  it('reorderCollections updates order to match given sequence', () => {
    const a = useCollectionStore.getState().createCollection('A');
    const b = useCollectionStore.getState().createCollection('B');
    const c = useCollectionStore.getState().createCollection('C');
    useCollectionStore.getState().reorderCollections([c, a, b]);
    const ordered = useCollectionStore.getState().listCollections().map((x) => x.id);
    expect(ordered).toEqual([c, a, b]);
  });
});
