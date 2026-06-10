/**
 * JP-89 — reference library as a Y.Doc shared type. Asserts the per-item
 * `references` Y.Map + `referenceOrder` Y.Array round-trip, and — the headline
 * guarantee — that a concurrent MCP-style add and author-style add merge instead
 * of clobbering (the client-side mirror of the relay's concurrency test).
 */
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { YjsDocument } from './YjsDocument';
import type { CSLItem } from '../types/Citation';

function ref(id: string, doi?: string): CSLItem {
  return { id, type: 'book', title: id, ...(doi ? { DOI: doi } : {}) } as CSLItem;
}

describe('YjsDocument references (JP-89)', () => {
  it('setReference stores per-item + appends order; getReferenceLibrary merges', () => {
    const doc = new YjsDocument();
    doc.setReference(ref('knuth1997'));
    doc.setReference(ref('shannon'));
    doc.setReferenceStyle('mla');

    const lib = doc.getReferenceLibrary();
    expect(Object.keys(lib.items).sort()).toEqual(['knuth1997', 'shannon']);
    expect(lib.itemOrder).toEqual(['knuth1997', 'shannon']);
    expect(lib.style).toBe('mla');
  });

  it('re-setting an existing id does not duplicate the order entry', () => {
    const doc = new YjsDocument();
    doc.setReference(ref('a'));
    doc.setReference({ ...ref('a'), title: 'updated' } as CSLItem);
    const lib = doc.getReferenceLibrary();
    expect(lib.itemOrder).toEqual(['a']);
    expect(lib.items['a']?.title).toBe('updated');
  });

  it('deleteReference removes from the map and the order', () => {
    const doc = new YjsDocument();
    doc.setReference(ref('a'));
    doc.setReference(ref('b'));
    doc.deleteReference('a');
    const lib = doc.getReferenceLibrary();
    expect(lib.items['a']).toBeUndefined();
    expect(lib.itemOrder).toEqual(['b']);
  });

  it('getReferenceLibrary drops order ids with no item and appends unordered items', () => {
    const doc = new YjsDocument();
    // Simulate a stale/duplicated order entry + an item missing from order.
    doc.getDoc().transact(() => {
      doc.getDoc().getMap('references').set('present', ref('present'));
      const order = doc.getDoc().getArray<string>('referenceOrder');
      order.push(['ghost', 'present', 'present']); // ghost has no item; dup id
    });
    const lib = doc.getReferenceLibrary();
    expect(lib.itemOrder).toEqual(['present']);
  });

  it('concurrent MCP-style add and author add BOTH survive (no clobber)', () => {
    // Two docs sharing a base, each adds a DIFFERENT ref without seeing the other.
    const relay = new YjsDocument();
    const client = new YjsDocument();

    // Sync the (empty) base both ways so they share history.
    Y.applyUpdate(client.getDoc(), Y.encodeStateAsUpdate(relay.getDoc()));

    // MCP-style add on the relay; author-style add on the client — concurrently.
    relay.setReference(ref('refA', '10.1/a'));
    client.setReference(ref('refB', '10.1/b'));

    // Exchange updates (merge both directions, as the relay rebroadcast would).
    const relayUpdate = Y.encodeStateAsUpdate(relay.getDoc());
    const clientUpdate = Y.encodeStateAsUpdate(client.getDoc());
    Y.applyUpdate(client.getDoc(), relayUpdate);
    Y.applyUpdate(relay.getDoc(), clientUpdate);

    for (const doc of [relay, client]) {
      const lib = doc.getReferenceLibrary();
      expect(Object.keys(lib.items).sort()).toEqual(['refA', 'refB']);
      expect([...lib.itemOrder].sort()).toEqual(['refA', 'refB']);
    }
  });

  it('onReferenceChange fires for a remote update, not for a local write', () => {
    const local = new YjsDocument();
    const remote = new YjsDocument();
    Y.applyUpdate(remote.getDoc(), Y.encodeStateAsUpdate(local.getDoc()));

    let fired = 0;
    local.onReferenceChange(() => {
      fired += 1;
    });

    // Local write must NOT fire the remote callback (origin === this).
    local.setReference(ref('local'));
    expect(fired).toBe(0);

    // A remote peer's add, applied as an external update, fires it.
    remote.setReference(ref('fromRemote'));
    Y.applyUpdate(local.getDoc(), Y.encodeStateAsUpdate(remote.getDoc()));
    expect(fired).toBeGreaterThan(0);
    expect(local.getReferenceLibrary().items['fromRemote']).toBeDefined();
  });
});
