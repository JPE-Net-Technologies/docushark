/**
 * Per-user canvas undo/redo in collaboration (JP-402).
 *
 * Safety properties (the scar-tissue cases from JP-178 / JP-330):
 *  - Tracked-origin isolation: undo reverts only THIS user's edits; a remote edit
 *    (applied with a foreign origin) is never on the undo stack and survives undo.
 *  - Round-trip: an add (shape + order) is one undo step; undo removes both, redo
 *    restores both — through the same observers a remote edit drives.
 *  - Baseline not undoable: after the seed/adopt baseline, history is cleared so the
 *    user can't undo into an empty doc (a never-synced `initializeFromState` seed
 *    transacts with the tracked origin and would otherwise be captured).
 *  - Per-page scoping: undo on the active page never touches another page.
 */
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { YjsDocument } from './YjsDocument';
import type { Shape } from '../shapes/Shape';

function shape(id: string): Shape {
  return {
    id,
    type: 'rectangle',
    position: { x: 0, y: 0 },
    size: { width: 1, height: 1 },
    rotation: 0,
    style: {},
  } as unknown as Shape;
}

describe('YjsDocument canvas undo/redo (JP-402)', () => {
  it('tracks only local edits; a remote edit is not undoable and survives undo', () => {
    const doc = new YjsDocument();
    doc.rebindActivePage('p1');

    // A peer's edit arrives via the provider (foreign transaction origin).
    const peer = new YjsDocument();
    peer.rebindActivePage('p1');
    peer.setShape(shape('remote-1'));
    peer.setShapeOrder(['remote-1']);
    Y.applyUpdate(doc.getDoc(), Y.encodeStateAsUpdate(peer.getDoc()));

    // Remote change is not on our undo stack.
    expect(doc.canUndo()).toBe(false);

    // A local edit IS undoable.
    doc.setShape(shape('local-1'));
    expect(doc.canUndo()).toBe(true);

    doc.undo();
    expect(doc.getShape('local-1')).toBeUndefined(); // our edit reverted
    expect(doc.getShape('remote-1')).toBeDefined(); // peer's edit untouched
    expect(doc.canRedo()).toBe(true);

    doc.redo();
    expect(doc.getShape('local-1')).toBeDefined();

    doc.destroy();
    peer.destroy();
  });

  it('add → undo → redo round-trips both shape and order in one step', () => {
    const doc = new YjsDocument();
    doc.rebindActivePage('p1');

    // Two transactions in the same burst (no stopCapturing between) → one step.
    doc.setShape(shape('s1'));
    doc.setShapeOrder(['s1']);
    expect(doc.getShapeOrder()).toEqual(['s1']);

    doc.undo();
    expect(doc.getAllShapes().has('s1')).toBe(false);
    expect(doc.getShapeOrder()).toEqual([]); // order reverted too

    doc.redo();
    expect(doc.getAllShapes().has('s1')).toBe(true);
    expect(doc.getShapeOrder()).toEqual(['s1']);

    doc.destroy();
  });

  it('closeUndoStep splits consecutive edits into separate undo steps', () => {
    const doc = new YjsDocument();
    doc.rebindActivePage('p1');

    doc.setShape(shape('s1'));
    doc.closeUndoStep(); // action anchor between the two edits
    doc.setShape(shape('s2'));

    // First undo removes only the second edit.
    doc.undo();
    expect(doc.getAllShapes().has('s2')).toBe(false);
    expect(doc.getAllShapes().has('s1')).toBe(true);

    // Second undo removes the first.
    doc.undo();
    expect(doc.getAllShapes().has('s1')).toBe(false);

    doc.destroy();
  });

  it('clearUndoHistory makes the seed baseline non-undoable (shapes kept)', () => {
    const doc = new YjsDocument();
    doc.rebindActivePage('p1');

    // A never-synced seed transacts with the tracked origin → would be captured.
    doc.initializeFromState([shape('seed')], ['seed']);
    expect(doc.canUndo()).toBe(true);

    doc.clearUndoHistory();
    expect(doc.canUndo()).toBe(false);
    expect(doc.getShape('seed')).toBeDefined(); // baseline preserved, just not undoable

    doc.destroy();
  });

  it('undo is scoped per page', () => {
    const doc = new YjsDocument();
    doc.rebindActivePage('p1');
    doc.setShape(shape('s1'));

    doc.rebindActivePage('p2');
    doc.setShape(shape('s2'));

    // Undo on the active page (p2) removes only p2's shape.
    doc.undo();
    expect(doc.getShapesForPage('p2')).toHaveLength(0);
    expect(doc.getShapesForPage('p1').map((s) => s.id)).toEqual(['s1']);

    // Switching back to p1 keeps its stack — undo there removes p1's shape.
    doc.rebindActivePage('p1');
    doc.undo();
    expect(doc.getShapesForPage('p1')).toHaveLength(0);

    doc.destroy();
  });
});
