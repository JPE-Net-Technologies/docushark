import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useDocumentStore } from './documentStore';
import { RectangleShape } from '../shapes/Shape';

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

describe('documentStore.loadSnapshot integrity', () => {
  beforeEach(() => {
    useDocumentStore.getState().clear();
  });

  it('reports ok=true for a clean snapshot', () => {
    useDocumentStore.getState().loadSnapshot({
      shapes: { a: rect('a'), b: rect('b') },
      shapeOrder: ['a', 'b'],
      version: 1,
    });
    const integrity = useDocumentStore.getState().getLastSnapshotIntegrity();
    expect(integrity.ok).toBe(true);
    expect(integrity.droppedFromOrder).toEqual([]);
    expect(integrity.unorderedShapes).toEqual([]);
  });

  it('flags shapeOrder ids that have no shape and logs an error', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    useDocumentStore.getState().loadSnapshot({
      shapes: { a: rect('a') },
      shapeOrder: ['a', 'ghost'],
      version: 1,
    });
    const integrity = useDocumentStore.getState().getLastSnapshotIntegrity();
    expect(integrity.ok).toBe(false);
    expect(integrity.droppedFromOrder).toEqual(['ghost']);
    expect(errSpy).toHaveBeenCalled();
    // shapeOrder is still filtered so render stays stable.
    expect(useDocumentStore.getState().shapeOrder).toEqual(['a']);
    errSpy.mockRestore();
  });

  const group = (id: string, childIds: string[]) =>
    ({ ...rect(id), type: 'group', childIds }) as unknown as RectangleShape;

  it('does not flag a group\'s children missing from shapeOrder (they are normal)', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    useDocumentStore.getState().loadSnapshot({
      shapes: { a: rect('a'), b: rect('b'), g: group('g', ['b']) },
      shapeOrder: ['a', 'g'],
      version: 1,
    });
    const integrity = useDocumentStore.getState().getLastSnapshotIntegrity();
    expect(integrity.ok).toBe(true);
    expect(integrity.unorderedShapes).toEqual([]);
    expect(useDocumentStore.getState().shapeOrder).toEqual(['a', 'g']);
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('draws a shape in no group and not in shapeOrder, logs it, and still allows a save (DSK-221)', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    useDocumentStore.getState().loadSnapshot({
      shapes: { a: rect('a'), b: rect('b') },
      shapeOrder: ['a'],
      version: 1,
    });
    const integrity = useDocumentStore.getState().getLastSnapshotIntegrity();
    expect(integrity.ok).toBe(true);
    expect(integrity.unorderedShapes).toEqual(['b']);
    expect(useDocumentStore.getState().shapeOrder).toEqual(['a', 'b']);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('takes a group\'s children out of shapeOrder, which would draw them twice (DSK-221)', () => {
    useDocumentStore.getState().loadSnapshot({
      shapes: { a: rect('a'), b: rect('b'), g: group('g', ['b']) },
      shapeOrder: ['a', 'b', 'g'],
      version: 1,
    });
    expect(useDocumentStore.getState().shapeOrder).toEqual(['a', 'g']);
  });
});
