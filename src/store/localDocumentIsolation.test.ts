/**
 * "Local docs never touch the relay" integration invariant.
 *
 * Even with the post-Slice-E architecture (`persistenceStore` no
 * longer dual-writes to a host on save), an accidental future
 * change could put a `fetch('/api/...')` back into the local-doc
 * code path. This test stubs `globalThis.fetch` with a recorder
 * and exercises a sequence of local-only workflows: create / edit
 * via documentStore / save / load / delete / importJSON. If any
 * step fires a single fetch request the test fails.
 *
 * Pair with `documentStore.imports.test.ts` (origin-blindness via
 * static import analysis). This test catches *runtime* leaks where
 * an import is allowed but a code path still routes through the
 * network — e.g. a notification dispatching a webhook, a blob
 * helper trying to upload, etc.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { usePersistenceStore } from './persistenceStore';
import { useDocumentStore } from './documentStore';
import { useConnectionStore } from './connectionStore';
import { useCollaborationStore } from '../collaboration/collaborationStore';

interface FetchCall {
  url: string;
  method: string;
}

let calls: FetchCall[];
let originalFetch: typeof globalThis.fetch | undefined;

function installFetchRecorder(): void {
  calls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, method: (init?.method ?? 'GET').toUpperCase() });
    // Tests should never get here; throw so a stray call surfaces clearly.
    throw new Error(`Unexpected fetch in local-only flow: ${url}`);
  }) as typeof globalThis.fetch;
}

function uninstallFetchRecorder(): void {
  if (originalFetch !== undefined) {
    globalThis.fetch = originalFetch;
  }
}

describe('Local document operations do not touch the relay', () => {
  beforeEach(() => {
    installFetchRecorder();
    // Ensure no relay session is active — this is the invariant
    // condition under which the assertion must hold.
    useConnectionStore.getState().reset();
    // Wipe persisted state so we start from a clean slate.
    localStorage.clear();
    // Pop the persistenceStore back to a fresh new-doc.
    usePersistenceStore.getState().newDocument('Test Doc');
  });

  afterEach(() => {
    uninstallFetchRecorder();
    localStorage.clear();
  });

  it('newDocument does not fetch', () => {
    usePersistenceStore.getState().newDocument('Another doc');
    expect(calls).toEqual([]);
  });

  it('saveDocument does not fetch', () => {
    usePersistenceStore.getState().saveDocument();
    expect(calls).toEqual([]);
  });

  it('document mutations + save do not fetch', () => {
    const doc = useDocumentStore.getState();
    doc.addShape({
      id: 'shape-1',
      type: 'rectangle',
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      rotation: 0,
      style: {},
    } as unknown as Parameters<typeof doc.addShape>[0]);

    usePersistenceStore.getState().saveDocument();
    expect(calls).toEqual([]);
  });

  it('loadDocument does not fetch', () => {
    // Save twice with different names to populate the index.
    const { newDocument, saveDocument, documents } = usePersistenceStore.getState();
    saveDocument();
    newDocument('Second doc');
    saveDocument();
    const ids = Object.keys(usePersistenceStore.getState().documents);
    expect(ids.length).toBeGreaterThanOrEqual(2);

    usePersistenceStore.getState().loadDocument(ids[0]!);
    expect(calls).toEqual([]);

    // Silence unused-binding lint in the destructure above.
    void documents;
  });

  it('deleteDocument does not fetch', () => {
    const { saveDocument, currentDocumentId } = usePersistenceStore.getState();
    saveDocument();
    const id = currentDocumentId ?? Object.keys(usePersistenceStore.getState().documents)[0]!;
    usePersistenceStore.getState().deleteDocument(id);
    expect(calls).toEqual([]);
  });

  it('importJSON does not fetch', () => {
    const payload = JSON.stringify({
      id: 'imported-doc',
      name: 'Imported',
      version: 1,
      createdAt: Date.now(),
      modifiedAt: Date.now(),
      pages: {
        'p-1': {
          id: 'p-1',
          name: 'Page 1',
          shapes: {},
          shapeOrder: [],
          connections: {},
        },
      },
      pageOrder: ['p-1'],
      activePageId: 'p-1',
      shapes: {},
      shapeOrder: [],
      connections: {},
    });

    const ok = usePersistenceStore.getState().importJSON(payload);
    expect(ok).toBe(true);
    expect(calls).toEqual([]);
  });

  // JP-64: loading a local doc with an active collab session must
  // NOT emit JOIN_DOC. `persistenceStore.loadDocument` gates the
  // `collabStore.switchDocument(id)` call on `doc.isRelayDocument`.
  it('loading a local doc with active collab does not call switchDocument', () => {
    // Persist a local doc to load.
    const { newDocument, saveDocument } = usePersistenceStore.getState();
    newDocument('Local Only');
    saveDocument();
    const localId = usePersistenceStore.getState().currentDocumentId!;

    // Spy on the collab store's switchDocument. Force `isActive` true
    // so the gate inside loadDocument is actually evaluated.
    const switchSpy = vi.fn();
    useCollaborationStore.setState({
      isActive: true,
      switchDocument: switchSpy,
    } as unknown as Parameters<typeof useCollaborationStore.setState>[0]);

    const ok = usePersistenceStore.getState().loadDocument(localId);
    expect(ok).toBe(true);
    expect(switchSpy).not.toHaveBeenCalled();
  });

  it('long local-edit session does not fetch', () => {
    const doc = useDocumentStore.getState();
    // Simulate a stream of edits + intermediate saves.
    for (let i = 0; i < 5; i++) {
      doc.addShape({
        id: `shape-${i}`,
        type: 'rectangle',
        x: i * 20,
        y: i * 10,
        width: 50,
        height: 50,
        rotation: 0,
        style: {},
      } as unknown as Parameters<typeof doc.addShape>[0]);
      usePersistenceStore.getState().saveDocument();
    }
    expect(calls).toEqual([]);
  });
});
