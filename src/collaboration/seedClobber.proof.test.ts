/**
 * Regression guard (JP-179): proves WHY the collab adopt path must never seed a
 * provider-attached Y.Doc via `initializeFromState`.
 *
 * `initializeFromState` calls `this.shapes.clear()` on the shared Y.Doc. If that
 * runs while synced with a peer, the `clear()` propagates as a CRDT DELETION and
 * wipes the peer's shapes. The adopt path therefore uses "adopt-to-empty" (clear
 * the local view only) instead — see `useCollaborationSync`. If this test starts
 * failing because the behavior changed, do NOT "fix" it by re-seeding a
 * connected doc.
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

/** Apply `from`'s full state onto `to` — stands in for a relay sync exchange. */
function sync(from: YjsDocument, to: YjsDocument): void {
  Y.applyUpdate(to.getDoc(), Y.encodeStateAsUpdate(from.getDoc()));
}

describe('seed-clobber proof (JP-179)', () => {
  it('initializeFromState on a synced doc deletes the peer’s shapes', () => {
    // The relay's authoritative doc holds two shapes. JP-340: shapes are
    // per-page, so bind the active page before touching the shape surface.
    const relay = new YjsDocument();
    relay.rebindActivePage('p1');
    relay.setShapes([shape('S1'), shape('S2')]);
    expect(relay.getAllShapes().size).toBe(2);

    // A client connects and syncs — it now mirrors the relay.
    const client = new YjsDocument();
    sync(relay, client);
    client.rebindActivePage('p1');
    expect(client.getAllShapes().size).toBe(2);

    // Seeding the client (the OLD adopt behavior) clears its shapes map…
    client.initializeFromState([shape('S3')], ['S3']);

    // …and that clear propagates back to the relay, wiping S1 + S2.
    sync(client, relay);

    const relayShapes = relay.getAllShapes();
    expect(relayShapes.has('S1')).toBe(false);
    expect(relayShapes.has('S2')).toBe(false);
    expect(relayShapes.has('S3')).toBe(true);

    relay.destroy();
    client.destroy();
  });
});
