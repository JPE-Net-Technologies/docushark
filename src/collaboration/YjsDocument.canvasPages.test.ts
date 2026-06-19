/**
 * JP-339 — canvas page LIST (tabs) as a Y.Doc shared type. Asserts the per-item
 * `canvasPages` Y.Map + `canvasPageOrder` Y.Array round-trip, the order-array
 * reorder, and that a concurrent MCP-style add and an author-style add merge
 * instead of clobbering (mirrors the prose page-list / fields tests). Metadata
 * only — a page's shapes live in the active-page `shapes` surface, never here.
 */
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { YjsDocument } from './YjsDocument';
import type { CanvasPageMeta } from './YjsDocument';

function page(id: string, name = id): CanvasPageMeta {
  return { id, name };
}

describe('YjsDocument canvas page-list (JP-339)', () => {
  it('setCanvasPage stores per-item + appends order; getCanvasPageList merges', () => {
    const doc = new YjsDocument();
    doc.setCanvasPage(page('p1', 'Page 1'));
    doc.setCanvasPage(page('p2', 'Diagram'));

    const list = doc.getCanvasPageList();
    expect(Object.keys(list.pages).sort()).toEqual(['p1', 'p2']);
    expect(list.pageOrder).toEqual(['p1', 'p2']);
    expect(list.pages['p2']?.name).toBe('Diagram');
  });

  it('re-setting an existing id is a metadata update, no duplicate order entry', () => {
    const doc = new YjsDocument();
    doc.setCanvasPage(page('p1', 'Page 1'));
    doc.setCanvasPage(page('p1', 'Renamed'));
    const list = doc.getCanvasPageList();
    expect(list.pageOrder).toEqual(['p1']);
    expect(list.pages['p1']?.name).toBe('Renamed');
  });

  it('deleteCanvasPage removes from the map and the order', () => {
    const doc = new YjsDocument();
    doc.setCanvasPage(page('a'));
    doc.setCanvasPage(page('b'));
    doc.deleteCanvasPage('a');
    const list = doc.getCanvasPageList();
    expect(list.pages['a']).toBeUndefined();
    expect(list.pageOrder).toEqual(['b']);
  });

  it('setCanvasPageOrder reorders the tabs (array-driven order)', () => {
    const doc = new YjsDocument();
    doc.setCanvasPage(page('a'));
    doc.setCanvasPage(page('b'));
    doc.setCanvasPage(page('c'));
    doc.setCanvasPageOrder(['c', 'a', 'b']);
    expect(doc.getCanvasPageList().pageOrder).toEqual(['c', 'a', 'b']);
  });

  it('getCanvasPageList drops order ids with no page and appends unordered pages', () => {
    const doc = new YjsDocument();
    doc.getDoc().transact(() => {
      doc.getDoc().getMap('canvasPages').set('present', page('present'));
      const order = doc.getDoc().getArray<string>('canvasPageOrder');
      order.push(['ghost', 'present', 'present']);
    });
    const list = doc.getCanvasPageList();
    expect(list.pageOrder).toEqual(['present']);
  });

  it('concurrent MCP-style add and author add BOTH survive (no clobber)', () => {
    const relay = new YjsDocument();
    const client = new YjsDocument();
    Y.applyUpdate(client.getDoc(), Y.encodeStateAsUpdate(relay.getDoc()));

    relay.setCanvasPage(page('p-mcp', 'From MCP'));
    client.setCanvasPage(page('p-author', 'From Author'));

    Y.applyUpdate(client.getDoc(), Y.encodeStateAsUpdate(relay.getDoc()));
    Y.applyUpdate(relay.getDoc(), Y.encodeStateAsUpdate(client.getDoc()));

    for (const doc of [relay, client]) {
      const list = doc.getCanvasPageList();
      expect(Object.keys(list.pages).sort()).toEqual(['p-author', 'p-mcp']);
      expect([...list.pageOrder].sort()).toEqual(['p-author', 'p-mcp']);
    }
  });

  it('onCanvasPagesChange fires for a remote update, not for a local write', () => {
    const local = new YjsDocument();
    const remote = new YjsDocument();
    Y.applyUpdate(remote.getDoc(), Y.encodeStateAsUpdate(local.getDoc()));

    let fired = 0;
    local.onCanvasPagesChange(() => {
      fired += 1;
    });

    local.setCanvasPage(page('local'));
    expect(fired).toBe(0);

    remote.setCanvasPage(page('fromRemote', 'Remote'));
    Y.applyUpdate(local.getDoc(), Y.encodeStateAsUpdate(remote.getDoc()));
    expect(fired).toBeGreaterThan(0);
    expect(local.getCanvasPageList().pages['fromRemote']?.name).toBe('Remote');
  });
});
