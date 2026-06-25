import { describe, it, expect, vi, beforeEach } from 'vitest';

// Seams: assert sign-in stands up the REST-only provider and never starts a WS
// collab session for a placeholder doc (the JOIN_DOC=default bug).
const h = vi.hoisted(() => ({
  saveConnection: vi.fn(async () => {}),
  setToken: vi.fn(),
  standUpRestProvider: vi.fn(),
  getRecord: vi.fn((_id: string) => undefined as unknown),
  ensureCollabSessionForDoc: vi.fn(async () => {}),
}));

vi.mock('./relayConnection', () => ({ saveConnection: h.saveConnection }));
vi.mock('./restoreCloudSession', () => ({ standUpRestProvider: h.standUpRestProvider }));
vi.mock('../store/connectionStore', () => ({
  useConnectionStore: { getState: () => ({ setToken: h.setToken }) },
}));
vi.mock('../store/documentRegistry', () => ({
  useDocumentRegistry: { getState: () => ({ getRecord: h.getRecord }) },
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

  it('opens the live session only for a known relay doc', async () => {
    h.getRecord.mockReturnValue({ type: 'remote' });
    await completeCloudSignIn({ ...base, documentId: 'doc-42' });
    expect(h.ensureCollabSessionForDoc).toHaveBeenCalledWith('doc-42');

    h.getRecord.mockReturnValue({ type: 'cached' });
    await completeCloudSignIn({ ...base, documentId: 'doc-7' });
    expect(h.ensureCollabSessionForDoc).toHaveBeenCalledWith('doc-7');
  });
});
