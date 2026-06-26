/**
 * JP-384: closing/reloading the app while on an empty "Untitled Document" used
 * to mint a NEW empty Untitled doc every time, because `saveDocument()` invents
 * a fresh nanoid whenever `currentDocumentId` is null with no guard against
 * persisting a pristine, never-named document. The unload / boot-flush save
 * (useAutoSave `beforeunload` + `loadDocument`'s `flushAutoSaveNow`) is what
 * fired the bug while the untitled doc's id was still null.
 *
 * Fix: a pristine untitled (default name + no content + never saved) is never
 * persisted. It earns storage only once it gains content OR is renamed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const cacheMock = vi.hoisted(() => ({
  put: vi.fn(async () => {}),
  getMeta: vi.fn(() => null),
}));
vi.mock('../storage/RelayDocumentCache', () => ({ RelayDocumentCache: cacheMock }));

const syncManagerMock = vi.hoisted(() => ({
  queueSave: vi.fn(() => ({ id: 'op-1' })),
  hasPendingChanges: vi.fn(() => false),
  processQueueForHost: vi.fn(async () => []),
}));
vi.mock('../collaboration/SyncStateManager', () => ({
  getSyncStateManager: () => syncManagerMock,
}));

import { usePersistenceStore, UNTITLED_DOCUMENT_NAME } from './persistenceStore';
import { useRichTextStore } from './richTextStore';

/** Count locally-stored docs whose name is the default Untitled name. */
function untitledDocCount(): number {
  const docs = usePersistenceStore.getState().documents;
  return Object.values(docs).filter((d) => d.name === UNTITLED_DOCUMENT_NAME).length;
}

function totalDocCount(): number {
  return Object.keys(usePersistenceStore.getState().documents).length;
}

describe('JP-384 — Untitled duplication on reload', () => {
  beforeEach(() => {
    localStorage.clear();
    usePersistenceStore.setState({
      currentDocumentId: null,
      currentDocumentName: UNTITLED_DOCUMENT_NAME,
      documents: {},
    } as never);
    vi.restoreAllMocks();
  });

  it('never persists a pristine untitled doc across repeated reload cycles', () => {
    const store = usePersistenceStore.getState();

    // Three "open app on a fresh untitled page, then close/reload" cycles.
    // Each cycle: newDocument() (id=null, empty) then the unload/boot save
    // fires while the id is still null.
    for (let i = 0; i < 3; i++) {
      store.newDocument();
      usePersistenceStore.getState().saveDocument();
    }

    // The pristine untitled never earns storage — no duplicates, no doc at all.
    expect(untitledDocCount()).toBe(0);
    expect(totalDocCount()).toBe(0);
    expect(usePersistenceStore.getState().currentDocumentId).toBeNull();
  });

  it('persists exactly one doc once content is added, and reload does not duplicate it', () => {
    const store = usePersistenceStore.getState();
    store.newDocument();

    // User types prose — the doc now has content (still named "Untitled").
    useRichTextStore.getState().setContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
    });

    usePersistenceStore.getState().saveDocument();
    const firstId = usePersistenceStore.getState().currentDocumentId;
    expect(firstId).not.toBeNull();
    expect(totalDocCount()).toBe(1);

    // Simulate a reload-time save: same id, no duplicate.
    usePersistenceStore.getState().saveDocument();
    expect(totalDocCount()).toBe(1);
    expect(usePersistenceStore.getState().currentDocumentId).toBe(firstId);
  });

  it('persists a renamed-but-empty doc (the rename gate keeps working)', () => {
    usePersistenceStore.getState().newDocument();
    // Post-rename state: non-default name, still no content, never saved.
    usePersistenceStore.setState({ currentDocumentName: 'My Renamed Doc' } as never);

    usePersistenceStore.getState().saveDocument();

    expect(totalDocCount()).toBe(1);
    const docs = usePersistenceStore.getState().documents;
    expect(Object.values(docs)[0]?.name).toBe('My Renamed Doc');
  });
});
