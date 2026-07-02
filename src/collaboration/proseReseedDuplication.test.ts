/**
 * JP-282 root-cause probe: two *independent* seedings of the same prose into the
 * same `prose:<pageId>` fragment merge into DUPLICATED content.
 *
 * This is the promote-to-Cloud dup mechanism: the client reloads a stale prose
 * CRDT from y-indexeddb (lineage from a prior relay session, kept on disk
 * because leaveDocument/stopSession don't purge it) while the relay re-hydrates
 * the same doc fresh and re-seeds prose from richTextPages (json_prose_to_ydoc) —
 * a *different* CRDT lineage. On join the two fragments sync and concatenate.
 */
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';

/** Append one `<p>text</p>` paragraph to a prose fragment (independent items). */
function seedParagraph(doc: Y.Doc, field: string, text: string): void {
  const frag = doc.getXmlFragment(field);
  const p = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  t.insert(0, text);
  p.insert(0, [t]);
  frag.insert(frag.length, [p]);
}

describe('JP-282: independent prose seedings merge to duplicates', () => {
  it('doubles when a stale client fragment syncs with a fresh relay seed', () => {
    // Stale local CRDT (y-indexeddb survivor from a previous relay session).
    const client = new Y.Doc();
    seedParagraph(client, 'prose:p1', 'hello world');

    // Relay re-hydrates the (now fresh) doc and re-seeds the same prose — its own
    // lineage, no shared item identity with the client's stale copy.
    const relay = new Y.Doc();
    seedParagraph(relay, 'prose:p1', 'hello world');

    // Join: exchange state both ways (the Yjs sync handshake).
    Y.applyUpdate(client, Y.encodeStateAsUpdate(relay));
    Y.applyUpdate(relay, Y.encodeStateAsUpdate(client));

    // Both ends now hold the paragraph TWICE — the reported per-page dup.
    expect(client.getXmlFragment('prose:p1').length).toBe(2);
    expect(relay.getXmlFragment('prose:p1').length).toBe(2);
  });

  it('does NOT double when the client starts empty and adopts the relay seed', () => {
    // The fix: client purges its stale room → empty fragment → pure adopt.
    const client = new Y.Doc(); // empty (room purged on the transfer boundary)
    const relay = new Y.Doc();
    seedParagraph(relay, 'prose:p1', 'hello world');

    Y.applyUpdate(client, Y.encodeStateAsUpdate(relay));
    Y.applyUpdate(relay, Y.encodeStateAsUpdate(client));

    expect(client.getXmlFragment('prose:p1').length).toBe(1);
    expect(relay.getXmlFragment('prose:p1').length).toBe(1);
  });

  it('does NOT double for a page CREATED offline when the relay never seeds it (JP-335)', () => {
    // Offline new-page creation: the client authors `prose:<newId>` (its live
    // random-clientID lineage) while the relay never learns the page — the
    // collab body-save suppression + the pending-page body-withhold keep its
    // HTML out of the relay's stored JSON, so json_prose_to_ydoc has nothing to
    // seed. On reconnect the client's fragment is the SOLE lineage.
    const client = new Y.Doc();
    seedParagraph(client, 'prose:new-offline', 'typed while offline');

    const relay = new Y.Doc(); // hydrated from a body with content: '' for this page

    Y.applyUpdate(relay, Y.encodeStateAsUpdate(client));
    Y.applyUpdate(client, Y.encodeStateAsUpdate(relay));

    expect(client.getXmlFragment('prose:new-offline').length).toBe(1);
    expect(relay.getXmlFragment('prose:new-offline').length).toBe(1);

    // Control — the hazard the withhold exists to prevent: if the page's HTML
    // HAD reached the relay body, the relay would mint its own lineage and the
    // merge doubles (the first test's mechanism, restated for the new-page case).
    const leakyRelay = new Y.Doc();
    seedParagraph(leakyRelay, 'prose:new-offline', 'typed while offline');
    Y.applyUpdate(leakyRelay, Y.encodeStateAsUpdate(client));
    expect(leakyRelay.getXmlFragment('prose:new-offline').length).toBe(2);
  });
});
