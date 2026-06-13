/**
 * Phase 3b — document field library as a Y.Doc shared type. Asserts the per-item
 * `fields` Y.Map + `fieldOrder` Y.Array round-trip, and — the headline guarantee
 * — that a concurrent MCP-style set and author-style set merge instead of
 * clobbering (mirrors the references concurrency test / the relay's).
 */
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { YjsDocument } from './YjsDocument';
import type { Field } from '../types/Field';

function field(name: string, value = name): Field {
  return { name, value };
}

describe('YjsDocument fields (Phase 3b)', () => {
  it('setField stores per-item + appends order; getFieldLibrary merges', () => {
    const doc = new YjsDocument();
    doc.setField(field('Company', 'Acme'));
    doc.setField(field('Version', '2.0'));

    const lib = doc.getFieldLibrary();
    expect(Object.keys(lib.fields).sort()).toEqual(['Company', 'Version']);
    expect(lib.order).toEqual(['Company', 'Version']);
    expect(lib.fields['Company']?.value).toBe('Acme');
  });

  it('re-setting an existing name is a value update, no duplicate order entry', () => {
    const doc = new YjsDocument();
    doc.setField(field('Company', 'Acme'));
    doc.setField(field('Company', 'Globex'));
    const lib = doc.getFieldLibrary();
    expect(lib.order).toEqual(['Company']);
    expect(lib.fields['Company']?.value).toBe('Globex');
  });

  it('deleteField removes from the map and the order', () => {
    const doc = new YjsDocument();
    doc.setField(field('A'));
    doc.setField(field('B'));
    doc.deleteField('A');
    const lib = doc.getFieldLibrary();
    expect(lib.fields['A']).toBeUndefined();
    expect(lib.order).toEqual(['B']);
  });

  it('getFieldLibrary drops order names with no field and appends unordered fields', () => {
    const doc = new YjsDocument();
    doc.getDoc().transact(() => {
      doc.getDoc().getMap('fields').set('present', field('present'));
      const order = doc.getDoc().getArray<string>('fieldOrder');
      order.push(['ghost', 'present', 'present']); // ghost has no field; dup name
    });
    const lib = doc.getFieldLibrary();
    expect(lib.order).toEqual(['present']);
  });

  it('concurrent MCP-style set and author set BOTH survive (no clobber)', () => {
    const relay = new YjsDocument();
    const client = new YjsDocument();

    // Share the (empty) base so the two have common history.
    Y.applyUpdate(client.getDoc(), Y.encodeStateAsUpdate(relay.getDoc()));

    // MCP-style set on the relay; author-style set on the client — concurrently.
    relay.setField(field('Company', 'Acme'));
    client.setField(field('Version', '2.0'));

    // Exchange updates both ways (as the relay rebroadcast would).
    const relayUpdate = Y.encodeStateAsUpdate(relay.getDoc());
    const clientUpdate = Y.encodeStateAsUpdate(client.getDoc());
    Y.applyUpdate(client.getDoc(), relayUpdate);
    Y.applyUpdate(relay.getDoc(), clientUpdate);

    for (const doc of [relay, client]) {
      const lib = doc.getFieldLibrary();
      expect(Object.keys(lib.fields).sort()).toEqual(['Company', 'Version']);
      expect([...lib.order].sort()).toEqual(['Company', 'Version']);
    }
  });

  it('onFieldChange fires for a remote update, not for a local write', () => {
    const local = new YjsDocument();
    const remote = new YjsDocument();
    Y.applyUpdate(remote.getDoc(), Y.encodeStateAsUpdate(local.getDoc()));

    let fired = 0;
    local.onFieldChange(() => {
      fired += 1;
    });

    // Local write must NOT fire the remote callback (origin === this).
    local.setField(field('local'));
    expect(fired).toBe(0);

    // A remote peer's set, applied as an external update, fires it.
    remote.setField(field('fromRemote', 'x'));
    Y.applyUpdate(local.getDoc(), Y.encodeStateAsUpdate(remote.getDoc()));
    expect(fired).toBeGreaterThan(0);
    expect(local.getFieldLibrary().fields['fromRemote']?.value).toBe('x');
  });
});
