/**
 * JP-339 — prose page LIST (tabs) as a Y.Doc shared type. Asserts the per-item
 * `prosePages` Y.Map + `prosePageOrder` Y.Array round-trip, the order-array
 * reorder, and — the headline guarantee — that a concurrent MCP-style add and an
 * author-style add merge instead of clobbering (mirrors the fields/references
 * concurrency tests / the relay's). Metadata only — page content lives in the
 * `prose:<id>` fragment and is never carried here.
 */
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { YjsDocument } from './YjsDocument';
import type { ProsePageMeta } from './YjsDocument';

function page(id: string, name = id, order = 0): ProsePageMeta {
  return { id, name, order };
}

describe('YjsDocument prose page-list (JP-339)', () => {
  it('setProsePage stores per-item + appends order; getProsePageList merges', () => {
    const doc = new YjsDocument();
    doc.setProsePage(page('rt-page-1', 'Page 1', 0));
    doc.setProsePage(page('rt-2', 'Notes', 1));

    const list = doc.getProsePageList();
    expect(Object.keys(list.pages).sort()).toEqual(['rt-2', 'rt-page-1']);
    expect(list.pageOrder).toEqual(['rt-page-1', 'rt-2']);
    expect(list.pages['rt-2']?.name).toBe('Notes');
  });

  it('re-setting an existing id is a metadata update, no duplicate order entry', () => {
    const doc = new YjsDocument();
    doc.setProsePage(page('rt-page-1', 'Page 1'));
    doc.setProsePage(page('rt-page-1', 'Renamed'));
    const list = doc.getProsePageList();
    expect(list.pageOrder).toEqual(['rt-page-1']);
    expect(list.pages['rt-page-1']?.name).toBe('Renamed');
  });

  it('deleteProsePage removes from the map and the order', () => {
    const doc = new YjsDocument();
    doc.setProsePage(page('a'));
    doc.setProsePage(page('b'));
    doc.deleteProsePage('a');
    const list = doc.getProsePageList();
    expect(list.pages['a']).toBeUndefined();
    expect(list.pageOrder).toEqual(['b']);
  });

  it('setProsePageOrder reorders the tabs (array-driven order)', () => {
    const doc = new YjsDocument();
    doc.setProsePage(page('a'));
    doc.setProsePage(page('b'));
    doc.setProsePage(page('c'));
    doc.setProsePageOrder(['c', 'a', 'b']);
    expect(doc.getProsePageList().pageOrder).toEqual(['c', 'a', 'b']);
  });

  it('getProsePageList drops order ids with no page and appends unordered pages', () => {
    const doc = new YjsDocument();
    doc.getDoc().transact(() => {
      doc.getDoc().getMap('prosePages').set('present', page('present'));
      const order = doc.getDoc().getArray<string>('prosePageOrder');
      order.push(['ghost', 'present', 'present']); // ghost has no page; dup id
    });
    const list = doc.getProsePageList();
    expect(list.pageOrder).toEqual(['present']);
  });

  it('concurrent MCP-style add and author add BOTH survive (no clobber)', () => {
    const relay = new YjsDocument();
    const client = new YjsDocument();
    Y.applyUpdate(client.getDoc(), Y.encodeStateAsUpdate(relay.getDoc()));

    relay.setProsePage(page('rt-mcp', 'From MCP', 1));
    client.setProsePage(page('rt-author', 'From Author', 1));

    const relayUpdate = Y.encodeStateAsUpdate(relay.getDoc());
    const clientUpdate = Y.encodeStateAsUpdate(client.getDoc());
    Y.applyUpdate(client.getDoc(), relayUpdate);
    Y.applyUpdate(relay.getDoc(), clientUpdate);

    for (const doc of [relay, client]) {
      const list = doc.getProsePageList();
      expect(Object.keys(list.pages).sort()).toEqual(['rt-author', 'rt-mcp']);
      expect([...list.pageOrder].sort()).toEqual(['rt-author', 'rt-mcp']);
    }
  });

  it('onProsePagesChange fires for a remote update, not for a local write', () => {
    const local = new YjsDocument();
    const remote = new YjsDocument();
    Y.applyUpdate(remote.getDoc(), Y.encodeStateAsUpdate(local.getDoc()));

    let fired = 0;
    local.onProsePagesChange(() => {
      fired += 1;
    });

    local.setProsePage(page('local'));
    expect(fired).toBe(0);

    remote.setProsePage(page('fromRemote', 'Remote'));
    Y.applyUpdate(local.getDoc(), Y.encodeStateAsUpdate(remote.getDoc()));
    expect(fired).toBeGreaterThan(0);
    expect(local.getProsePageList().pages['fromRemote']?.name).toBe('Remote');
  });

  it('two clients seeding the default rt-page-1 converge to a single page', () => {
    // First-page identity reconciliation: a never-had-prose doc has both clients
    // create the SAME deterministic id, so the map merge is LWW on one key and
    // the order-array dup collapses in the merged snapshot.
    const a = new YjsDocument();
    const b = new YjsDocument();
    Y.applyUpdate(b.getDoc(), Y.encodeStateAsUpdate(a.getDoc()));

    a.setProsePage(page('rt-page-1', 'Page 1'));
    b.setProsePage(page('rt-page-1', 'Page 1'));

    Y.applyUpdate(a.getDoc(), Y.encodeStateAsUpdate(b.getDoc()));
    Y.applyUpdate(b.getDoc(), Y.encodeStateAsUpdate(a.getDoc()));

    for (const doc of [a, b]) {
      const list = doc.getProsePageList();
      expect(Object.keys(list.pages)).toEqual(['rt-page-1']);
      expect(list.pageOrder).toEqual(['rt-page-1']);
    }
  });
});
