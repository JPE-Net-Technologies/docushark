import { describe, it, expect, vi, beforeEach } from 'vitest';

// Seams: assert sign-in stands up the REST-only provider and never starts a WS
// collab session for a placeholder doc (the JOIN_DOC=default bug).
const h = vi.hoisted(() => ({
  saveConnection: vi.fn(async () => {}),
  setToken: vi.fn(),
  standUpRestProvider: vi.fn(),
  getRecord: vi.fn((_id: string) => undefined as unknown),
  ensureCollabSessionForDoc: vi.fn(async () => {}),
  // A live collab engine is itself proof of a relay doc (local docs never get one),
  // so an already-active session for the doc is a valid sign-in reopen signal even
  // when the registry record hasn't loaded yet (JP-392 boot-cached path).
  collabState: { isActive: false, config: null as { documentId: string } | null },
}));

vi.mock('./relayConnection', () => ({ saveConnection: h.saveConnection }));
vi.mock('./restoreCloudSession', () => ({ standUpRestProvider: h.standUpRestProvider }));
vi.mock('../store/connectionStore', () => ({
  useConnectionStore: { getState: () => ({ setToken: h.setToken }) },
}));
vi.mock('../store/documentRegistry', () => ({
  useDocumentRegistry: { getState: () => ({ getRecord: h.getRecord }) },
}));
vi.mock('../collaboration/collaborationStore', () => ({
  useCollaborationStore: { getState: () => h.collabState },
}));
vi.mock('../collaboration/ensureCollabSession', () => ({
  ensureCollabSessionForDoc: h.ensureCollabSessionForDoc,
}));

import { completeCloudSignIn } from './completeCloudSignIn';

const base = {
  relayUrl: 'http://localhost:9876',
  cloudBaseUrl: 'https://cloud.test',
  token: 'JWT',
  expiresAt: 123,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.getRecord.mockReturnValue(undefined);
  h.collabState.isActive = false;
  h.collabState.config = null;
});

describe('completeCloudSignIn (REST-only sign-in, JP — phantom-join fix)', () => {
  it('persists, sets token, and stands up the REST provider — no doc id', async () => {
    await completeCloudSignIn(base);
    expect(h.saveConnection).toHaveBeenCalledWith('http://localhost:9876', 'JWT', {
      cloudBaseUrl: 'https://cloud.test',
      jwtExpiresAt: 123,
    });
    expect(h.setToken).toHaveBeenCalledWith('JWT', 123);
    expect(h.standUpRestProvider).toHaveBeenCalledWith('http://localhost:9876', 'JWT');
    expect(h.ensureCollabSessionForDoc).not.toHaveBeenCalled();
  });

  it('does NOT open a session for a local doc (no phantom JOIN)', async () => {
    h.getRecord.mockReturnValue({ type: 'local' });
    await completeCloudSignIn({ ...base, documentId: 'default' });
    expect(h.standUpRestProvider).toHaveBeenCalled();
    expect(h.ensureCollabSessionForDoc).not.toHaveBeenCalled();
  });

  it('does NOT open a session for an unknown doc id (e.g. the scratch default)', async () => {
    h.getRecord.mockReturnValue(undefined);
    await completeCloudSignIn({ ...base, documentId: 'default' });
    expect(h.ensureCollabSessionForDoc).not.toHaveBeenCalled();
  });

  it('JP-392: opens the live session for the active doc when its registry record is missing', async () => {
    // Boot-cached doc: warmupCache loaded its content but no record, and the REST
    // list re-fetch is still async — so getRecord is undefined at sign-in. The live
    // engine for this exact doc is the reliable signal that it's a relay doc.
    h.getRecord.mockReturnValue(undefined);
    h.collabState.isActive = true;
    h.collabState.config = { documentId: 'doc-9' };

    await completeCloudSignIn({ ...base, documentId: 'doc-9' });

    expect(h.ensureCollabSessionForDoc).toHaveBeenCalledWith('doc-9');
  });

  it('opens the live session only for a known relay doc', async () => {
    h.getRecord.mockReturnValue({ type: 'remote' });
    await completeCloudSignIn({ ...base, documentId: 'doc-42' });
    expect(h.ensureCollabSessionForDoc).toHaveBeenCalledWith('doc-42');

    h.getRecord.mockReturnValue({ type: 'cached' });
    await completeCloudSignIn({ ...base, documentId: 'doc-7' });
    expect(h.ensureCollabSessionForDoc).toHaveBeenCalledWith('doc-7');
  });
});
