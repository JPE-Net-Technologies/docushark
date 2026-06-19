/**
 * Per-page canvas shape surfaces (JP-340).
 *
 * Proves the two acceptance properties at the client wrapper level:
 *  - A1 (write isolation): a shape added while bound to one page lives on THAT
 *    page's surface and never leaks onto another — switching pages can't
 *    contaminate the wrong page.
 *  - A2 (read on switch): `rebindActivePage` surfaces a page whose shapes were
 *    populated independently (as a remote/MCP edit on a remotely-created page
 *    would arrive), so switching to it renders its shapes with no reload.
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

describe('YjsDocument per-page shape surfaces (JP-340)', () => {
  it('A1: a shape added on the bound page does not leak to another page', () => {
    const doc = new YjsDocument();

    doc.rebindActivePage('p1');
    doc.setShape(shape('s1'));
    expect(doc.getAllShapes().has('s1')).toBe(true);

    // Switch to p2 — its surface is empty; s1 stayed on p1.
    const p2 = doc.rebindActivePage('p2');
    expect(p2.shapes).toHaveLength(0);
    expect(doc.getAllShapes().size).toBe(0);
    expect(doc.getShapesForPage('p1').map((s) => s.id)).toEqual(['s1']);
    expect(doc.getShapesForPage('p2')).toHaveLength(0);

    // An edit on p2 lands on p2 only.
    doc.setShape(shape('s2'));
    expect(doc.getShapesForPage('p2').map((s) => s.id)).toEqual(['s2']);
    expect(doc.getShapesForPage('p1').map((s) => s.id)).toEqual(['s1']);

    // Switching back to p1 surfaces p1's shape again (the snapshot).
    const back = doc.rebindActivePage('p1');
    expect(back.shapes.map((s) => s.id)).toEqual(['s1']);

    doc.destroy();
  });

  it('A2: rebinding surfaces a page populated independently (remote-created page)', () => {
    // A relay/MCP edit on a remotely-created page arrives as an update to that
    // page's `shapes:<id>` surface — simulate it by applying a peer's update for
    // a page the local wrapper never bound.
    const local = new YjsDocument();
    local.rebindActivePage('p1'); // viewing p1

    const peer = new YjsDocument();
    peer.rebindActivePage('p2'); // the remote author works on a different page
    peer.setShape(shape('remote-1'));
    peer.setShapeOrder(['remote-1']);

    // The peer's update reaches the local doc (the relay broadcast).
    Y.applyUpdate(local.getDoc(), Y.encodeStateAsUpdate(peer.getDoc()));

    // The local view (still on p1) is unaffected — no contamination.
    expect(local.getAllShapes().size).toBe(0);

    // Switching to the remote-created page surfaces its shapes immediately (the
    // snapshot the binding loads into the render surface) — no reload, no blank.
    const snapshot = local.rebindActivePage('p2');
    expect(snapshot.shapes.map((s) => s.id)).toEqual(['remote-1']);
    expect(snapshot.order).toEqual(['remote-1']);
    expect(local.hasAnyShapes()).toBe(true);

    local.destroy();
    peer.destroy();
  });

  it('mutators no-op before any page is bound', () => {
    const doc = new YjsDocument();
    // No rebind yet → unbound; mutators must be inert (never throw, never seed).
    expect(() => doc.setShape(shape('x'))).not.toThrow();
    expect(doc.getAllShapes().size).toBe(0);
    expect(doc.hasAnyShapes()).toBe(false);
    doc.destroy();
  });
});
