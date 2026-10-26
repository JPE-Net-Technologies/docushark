import { describe, it, expect } from 'vitest';
import { shouldFlushMountedPage, shouldPersistLeavingPage } from './proseLeavingPageGuard';

describe('shouldPersistLeavingPage (JP-334)', () => {
  it('persists when the editor is bound to the page being left', () => {
    expect(shouldPersistLeavingPage('page-a', 'page-a')).toBe(true);
  });

  it('skips when the editor belongs to a different page (the read-only-page desync)', () => {
    // Leaving read-only page B, but the mounted editor is the incoming page A —
    // an unguarded save would write A's content into B's slot.
    expect(shouldPersistLeavingPage('page-a', 'page-b')).toBe(false);
  });

  it('skips when no editor is mounted (read-only ProsePreview page)', () => {
    expect(shouldPersistLeavingPage(null, 'page-b')).toBe(false);
  });

  it('skips when there is no leaving page', () => {
    expect(shouldPersistLeavingPage('page-a', null)).toBe(false);
    expect(shouldPersistLeavingPage(null, null)).toBe(false);
  });
});

describe('shouldFlushMountedPage (DSK-199)', () => {
  const ok = {
    editorPageId: 'rt-page-1',
    shownPageId: 'rt-page-1',
    panelDocId: 'doc-a',
    openDocId: 'doc-a',
    loading: false,
    editable: true,
    relay: false,
  };

  it('flushes the editor holding the open document’s shown page', () => {
    expect(shouldFlushMountedPage(ok)).toBe(true);
  });

  it('flushes a new document before its first save gives it an id', () => {
    expect(shouldFlushMountedPage({ ...ok, panelDocId: null, openDocId: null })).toBe(true);
  });

  it('never writes the previous document’s prose into the newly opened one', () => {
    // Doc B is open in the stores, but the panel's editor still holds doc A's
    // rt-page-1 — the same page id, so only the document check stops it.
    expect(shouldFlushMountedPage({ ...ok, openDocId: 'doc-b' })).toBe(false);
    expect(shouldFlushMountedPage({ ...ok, panelDocId: 'doc-a', openDocId: null })).toBe(false);
  });

  it('skips while a page load is in flight', () => {
    expect(shouldFlushMountedPage({ ...ok, loading: true })).toBe(false);
  });

  it('skips an editor bound to another page, or no editor at all', () => {
    expect(shouldFlushMountedPage({ ...ok, editorPageId: 'page-b' })).toBe(false);
    expect(shouldFlushMountedPage({ ...ok, editorPageId: null })).toBe(false);
  });

  it('skips a read-only editor and a workspace document', () => {
    expect(shouldFlushMountedPage({ ...ok, editable: false })).toBe(false);
    expect(shouldFlushMountedPage({ ...ok, relay: true })).toBe(false);
  });
});
