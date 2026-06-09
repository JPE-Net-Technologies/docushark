import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { shouldSeedFragment } from './CollaborativeProseEditor';

/** Give a prose fragment one child so it reads as non-empty. */
function fillFragment(doc: Y.Doc, field: string): void {
  doc.getXmlFragment(field).insert(0, [new Y.XmlElement('paragraph')]);
}

describe('shouldSeedFragment', () => {
  it('seeds an empty, never-seeded fragment once the relay confirms state', () => {
    const doc = new Y.Doc();
    expect(shouldSeedFragment(doc, 'prose:p1', true)).toBe(true);
  });

  it('does not seed before the relay confirms state (offline)', () => {
    const doc = new Y.Doc();
    expect(shouldSeedFragment(doc, 'prose:p1', false)).toBe(false);
  });

  it('does NOT seed when the fragment already has content (relay already seeded)', () => {
    // The promote-to-Cloud dup: the relay seeds the fragment from richTextPages
    // (json_prose_to_ydoc) without setting the client proseSeeded flag. The
    // client must adopt that content, not re-seed on top of it.
    const doc = new Y.Doc();
    fillFragment(doc, 'prose:p1');
    expect(shouldSeedFragment(doc, 'prose:p1', true)).toBe(false);
  });

  it('does not re-seed a fragment this client already seeded', () => {
    const doc = new Y.Doc();
    doc.getMap<boolean>('proseSeeded').set('prose:p1', true);
    expect(shouldSeedFragment(doc, 'prose:p1', true)).toBe(false);
  });

  it('keys seeding per fragment field', () => {
    const doc = new Y.Doc();
    fillFragment(doc, 'prose:p1');
    expect(shouldSeedFragment(doc, 'prose:p1', true)).toBe(false);
    expect(shouldSeedFragment(doc, 'prose:p2', true)).toBe(true);
  });
});
