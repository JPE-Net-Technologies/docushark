import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Mocks for the modules ensureCollabSession depends on -------------------

const collab = {
  isActive: false,
  config: null as { documentId: string; serverUrl: string; token?: string } | null,
  startSession: vi.fn(),
  switchDocument: vi.fn(),
  leaveDocument: vi.fn(),
};

vi.mock('./collaborationStore', () => ({
  useCollaborationStore: { getState: () => collab },
}));

let flagEnabled = true;
vi.mock('./offlineFirstEngine', () => ({
  isOfflineFirstEngineEnabled: () => flagEnabled,
}));

let record: { type: 'local' | 'remote' | 'cached' } | undefined;
vi.mock('../store/documentRegistry', () => ({
  useDocumentRegistry: { getState: () => ({ getRecord: () => record }) },
}));

let connection: { relayUrl: string } | null;
vi.mock('../api/relayConnection', () => ({
  loadConnection: () => Promise.resolve(connection),
}));

// Use the real restUrlToWsUrl (pure string transform) and the real
// connectionStore (a plain zustand store, no import side effects) so the
// token-aware reopen reads a realistic in-memory relay identity.
import { ensureCollabSessionForDoc } from './ensureCollabSession';
import { useConnectionStore } from '../store/connectionStore';

describe('ensureCollabSessionForDoc', () => {
  beforeEach(() => {
    collab.isActive = false;
    collab.config = null;
    collab.startSession.mockReset();
    collab.switchDocument.mockReset();
    collab.leaveDocument.mockReset();
    flagEnabled = true;
    record = { type: 'remote' };
    connection = { relayUrl: 'http://relay.example:9876' };
    useConnectionStore.getState().reset(); // no token → cold-boot (engine-only)
  });

  it('no-ops when already active for the same doc', async () => {
    collab.isActive = true;
    collab.config = { documentId: 'doc-1', serverUrl: 'ws://x/ws' };

    await ensureCollabSessionForDoc('doc-1');

    expect(collab.switchDocument).not.toHaveBeenCalled();
    expect(collab.startSession).not.toHaveBeenCalled();
  });

  it('switches the engine when active for a different doc', async () => {
    collab.isActive = true;
    collab.config = { documentId: 'doc-1', serverUrl: 'ws://x/ws', token: 't' };

    await ensureCollabSessionForDoc('doc-2');

    expect(collab.switchDocument).toHaveBeenCalledWith('doc-2');
    expect(collab.startSession).not.toHaveBeenCalled();
  });

  it('starts an engine-only session (no token) on a cold open', async () => {
    await ensureCollabSessionForDoc('doc-9');

    expect(collab.startSession).toHaveBeenCalledTimes(1);
    const arg = collab.startSession.mock.calls[0]![0] as {
      serverUrl: string;
      documentId: string;
      token?: string;
    };
    expect(arg.documentId).toBe('doc-9');
    expect(arg.serverUrl).toBe('ws://relay.example:9876/ws');
    // Engine-only: no token attached, so startSession won't attach the provider.
    expect(arg.token).toBeUndefined();
  });

  it('never starts an engine for a local-only doc', async () => {
    record = { type: 'local' };

    await ensureCollabSessionForDoc('local-1');

    expect(collab.startSession).not.toHaveBeenCalled();
    expect(collab.switchDocument).not.toHaveBeenCalled();
  });

  it('leaves the doc (stays signed in) when a local-only doc is opened (JP-188/JP-190)', async () => {
    // Left a relay doc (session live) for a local doc — leave the doc cleanly
    // but stay signed in (leaveDocument, not stopSession).
    record = { type: 'local' };
    collab.isActive = true;
    collab.config = { documentId: 'relay-1', serverUrl: 'ws://x/ws', token: 't' };

    await ensureCollabSessionForDoc('local-1');

    expect(collab.leaveDocument).toHaveBeenCalledTimes(1);
    expect(collab.startSession).not.toHaveBeenCalled();
    expect(collab.switchDocument).not.toHaveBeenCalled();
  });

  it('does not call leaveDocument for a local doc when no session is active', async () => {
    record = { type: 'local' };

    await ensureCollabSessionForDoc('local-1');

    expect(collab.leaveDocument).not.toHaveBeenCalled();
  });

  it('reconnects WITH the live token on cold open when signed in (JP-190)', async () => {
    // connectionStore holds a valid token (signed in this session, then left a
    // doc) — reopening a relay doc should reconnect authenticated, not engine-only.
    useConnectionStore.getState().setToken('live-token', Date.now() + 60_000);

    await ensureCollabSessionForDoc('doc-9');

    expect(collab.startSession).toHaveBeenCalledTimes(1);
    const arg = collab.startSession.mock.calls[0]![0] as { token?: string };
    expect(arg.token).toBe('live-token');
  });

  it('respects the kill-switch for cold starts', async () => {
    flagEnabled = false;

    await ensureCollabSessionForDoc('doc-9');

    expect(collab.startSession).not.toHaveBeenCalled();
  });

  it('still switches an already-active session when the kill-switch is off', async () => {
    flagEnabled = false;
    collab.isActive = true;
    collab.config = { documentId: 'doc-1', serverUrl: 'ws://x/ws', token: 't' };

    await ensureCollabSessionForDoc('doc-2');

    expect(collab.switchDocument).toHaveBeenCalledWith('doc-2');
  });

  it('leaves the doc on the local path when no relay is configured', async () => {
    connection = null;

    await ensureCollabSessionForDoc('doc-9');

    expect(collab.startSession).not.toHaveBeenCalled();
  });
});
