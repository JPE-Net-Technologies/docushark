/**
 * The collab editor's mirror of its fragment in the pages store (DSK-230). It writes
 * by page id, and most documents share `rt-page-1`, so a write from a session that
 * has ended lands in whichever document is open now: opening a local document after
 * a workspace one replaced its text, and autosave made that permanent.
 *
 * A real `YjsDocument`, session and Tiptap editor. Only the network is mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import type { Editor } from '@tiptap/core';

vi.mock('../collaboration/UnifiedSyncProvider', () => ({
  UnifiedSyncProvider: vi.fn(() => ({
    connect: vi.fn(),
    destroy: vi.fn(),
    isReady: () => false,
    setLocalAwareness: vi.fn(),
    onAwarenessChange: () => () => {},
    updateCursor: vi.fn(),
    updateSelection: vi.fn(),
    joinDocument: vi.fn(),
    requestSync: vi.fn(),
  })),
}));
vi.mock('y-indexeddb', () => ({
  IndexeddbPersistence: vi.fn(() => ({ whenSynced: Promise.resolve(), destroy: vi.fn() })),
}));
vi.mock('../store/relayDocumentStore', () => ({
  useRelayDocumentStore: {
    getState: () => ({
      setHostConnected: vi.fn(),
      setError: vi.fn(),
      setAuthenticated: vi.fn(),
      handleDocumentEvent: vi.fn(),
      setProvider: vi.fn(),
      clearRelayDocuments: vi.fn(),
    }),
  },
}));
vi.mock('../store/connectionStore', () => {
  const state = {
    status: 'authenticated' as const,
    setHost: vi.fn(),
    reset: vi.fn(),
    setToken: vi.fn(),
    token: null,
    tokenExpiresAt: null,
  };
  const useConnectionStore = Object.assign(
    (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
    { getState: () => state, subscribe: () => () => {} },
  );
  return {
    useConnectionStore,
    isRelayAuthenticated: () => state.status === 'authenticated',
    startTokenExpirationMonitor: vi.fn(),
    stopTokenExpirationMonitor: vi.fn(),
    muteConnectionToasts: vi.fn(),
  };
});
vi.mock('../store/presenceStore', () => ({
  usePresenceStore: {
    getState: () => ({ setLocalUser: vi.fn(), clearRemoteUsers: vi.fn(), syncRemoteUsers: vi.fn() }),
  },
}));
vi.mock('../store/persistenceStore', () => ({ applyRemoteDocumentName: vi.fn() }));

import { useCollaborationStore } from '../collaboration/collaborationStore';
import { registerOpenDocumentIdSource } from '../collaboration/openDocumentSource';
import { usePageStore } from '../store/pageStore';
import { useRichTextPagesStore } from '../store/richTextPagesStore';
import { useRichTextStore } from '../store/richTextStore';
import { CollaborativeProseEditor } from './CollaborativeProseEditor';

const PAGE = 'rt-page-1';
const OTHER_TEXT = '<p>Text of the document open now</p>';

let openDocument: string | null = 'workspace-doc';
let editor: Editor | null = null;

function startSession(documentId: string) {
  act(() => {
    useCollaborationStore.getState().startSession({
      serverUrl: 'ws://localhost:9876/ws',
      documentId,
      token: 'test-token',
      user: { id: 'u', name: 'U', color: '#fff' },
    });
    useCollaborationStore.getState().getYjsDocument()!.rebindActivePage('p1');
  });
}

const session = () => useCollaborationStore.getState().getYjsDocument()!.getDoc();

async function mountEditor() {
  loadNextDocument('workspace-doc');
  const ydoc = session();
  await act(async () => {
    render(
      <CollaborativeProseEditor
        ydoc={ydoc}
        field={`prose:${PAGE}`}
        pageId={PAGE}
        onEditorReady={(ready) => {
          if (ready) editor = ready;
        }}
      />,
    );
  });
  expect(editor).not.toBeNull();
}

/** The next document, loaded into the same page slot. */
function loadNextDocument(id: string | null) {
  openDocument = id;
  useRichTextPagesStore.setState({
    pages: { [PAGE]: { id: PAGE, name: 'Prose', content: OTHER_TEXT, createdAt: 0, modifiedAt: 0 } },
    pageOrder: [PAGE],
    activePageId: PAGE,
  } as never);
}

const mirrored = () => useRichTextPagesStore.getState().pages[PAGE]?.content;
const type = (text: string) => editor!.commands.insertContent(text);
const microtasks = () => act(async () => {});

beforeEach(() => {
  editor = null;
  openDocument = 'workspace-doc';
  registerOpenDocumentIdSource(() => openDocument);
  act(() => {
    useCollaborationStore.getState().stopSession?.();
    usePageStore.getState().reset();
    useRichTextPagesStore.setState({ pages: {}, pageOrder: [], activePageId: null } as never);
    useRichTextStore.getState().reset();
  });
  startSession('workspace-doc');
});

afterEach(() => {
  cleanup();
  act(() => {
    useCollaborationStore.getState().stopSession?.();
  });
});

describe('the collab editor mirroring its fragment', () => {
  it('keeps the projection current while its session is the open document', async () => {
    await mountEditor();
    act(() => {
      type('Workspace text');
    });
    await microtasks();
    expect(mirrored()).toContain('Workspace text');
    expect(JSON.stringify(useRichTextStore.getState().content)).toContain('Workspace text');
  });

  it('writes nothing once its session has ended', async () => {
    await mountEditor();
    act(() => {
      useCollaborationStore.getState().leaveDocument();
      loadNextDocument('local-doc');
    });
    const before = JSON.stringify(useRichTextStore.getState().content);
    act(() => {
      type('Late update');
    });
    await microtasks();
    expect(mirrored()).toBe(OTHER_TEXT);
    expect(JSON.stringify(useRichTextStore.getState().content)).toBe(before);
  });

  it('drops an update already on its way when the document changes', async () => {
    await mountEditor();
    act(() => {
      type('Update in flight');
      useCollaborationStore.getState().leaveDocument();
      loadNextDocument('local-doc');
    });
    await microtasks();
    expect(mirrored()).toBe(OTHER_TEXT);
  });

  it('writes nothing into a new document, which has no id yet', async () => {
    await mountEditor();
    act(() => {
      useCollaborationStore.getState().leaveDocument();
      loadNextDocument(null);
    });
    act(() => {
      type('Late update');
    });
    await microtasks();
    expect(mirrored()).toBe(OTHER_TEXT);
  });

  it('writes nothing once another session has taken over', async () => {
    await mountEditor();
    startSession('second-workspace-doc');
    act(() => loadNextDocument('second-workspace-doc'));
    act(() => {
      type('Late update');
    });
    await microtasks();
    expect(mirrored()).toBe(OTHER_TEXT);
  });

  it('writes nothing while another document is open and the session has not been left yet', async () => {
    await mountEditor();
    act(() => loadNextDocument('local-doc'));
    act(() => {
      type('Late update');
    });
    await microtasks();
    expect(mirrored()).toBe(OTHER_TEXT);
  });
});
