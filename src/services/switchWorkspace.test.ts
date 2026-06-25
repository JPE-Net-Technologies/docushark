import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  getWorkspaceToken: vi.fn(),
  completeCloudSignIn: vi.fn(async () => {}),
  stopSession: vi.fn(),
  newDocument: vi.fn(),
  activeWorkspaceId: vi.fn(() => 'ws-current'),
  currentDocumentId: { value: null as string | null },
  getRecord: vi.fn(() => undefined as unknown),
}));

vi.mock('../api/webClient', () => ({ webClient: { getWorkspaceToken: h.getWorkspaceToken } }));
vi.mock('../api/completeCloudSignIn', () => ({ completeCloudSignIn: h.completeCloudSignIn }));
vi.mock('../api/relayConnection', () => ({
  loadConnection: vi.fn(async () => ({ cloudBaseUrl: 'http://web:3000' })),
  DEFAULT_CLOUD_BASE_URL: 'http://default:3000',
}));
vi.mock('../store/activeWorkspace', () => ({
  activeWorkspaceId: h.activeWorkspaceId,
  DEFAULT_WORKSPACE_ID: 'default',
}));
vi.mock('../collaboration/collaborationStore', () => ({
  useCollaborationStore: { getState: () => ({ stopSession: h.stopSession }) },
}));
vi.mock('../store/persistenceStore', () => ({
  usePersistenceStore: { getState: () => ({ currentDocumentId: h.currentDocumentId.value, newDocument: h.newDocument }) },
}));
vi.mock('../store/documentRegistry', () => ({
  useDocumentRegistry: { getState: () => ({ getRecord: h.getRecord }) },
}));

import { switchWorkspace } from './switchWorkspace';

describe('switchWorkspace', () => {
  beforeEach(() => {
    Object.values(h).forEach((v) => typeof v === 'object' || (v as ReturnType<typeof vi.fn>).mockClear?.());
    h.activeWorkspaceId.mockReturnValue('ws-current');
    h.currentDocumentId.value = null;
    h.getRecord.mockReturnValue(undefined);
    h.getWorkspaceToken.mockResolvedValue({
      token: 'new.jwt', expiresAt: 1_700_000_000, relayUrl: 'https://relay-b', workspaceName: 'B', workspaceSlug: 'b',
    });
  });

  it('is a no-op when the target is already active', async () => {
    await switchWorkspace('ws-current');
    expect(h.getWorkspaceToken).not.toHaveBeenCalled();
    expect(h.stopSession).not.toHaveBeenCalled();
    expect(h.completeCloudSignIn).not.toHaveBeenCalled();
  });

  it('re-scopes the token, tears down the session, then stands up the target (expiry → ms)', async () => {
    await switchWorkspace('ws-target');

    expect(h.getWorkspaceToken).toHaveBeenCalledWith('ws-target');
    expect(h.stopSession).toHaveBeenCalledTimes(1);
    expect(h.completeCloudSignIn).toHaveBeenCalledWith(
      expect.objectContaining({
        relayUrl: 'https://relay-b',
        token: 'new.jwt',
        expiresAt: 1_700_000_000_000, // seconds → ms
        workspaceName: 'B',
      }),
    );
  });

  it('gets the token BEFORE tearing down (a token failure leaves the session intact)', async () => {
    h.getWorkspaceToken.mockRejectedValueOnce(new Error('network'));
    await expect(switchWorkspace('ws-target')).rejects.toThrow('network');
    expect(h.stopSession).not.toHaveBeenCalled();
    expect(h.completeCloudSignIn).not.toHaveBeenCalled();
  });

  it('resets the editor to a blank doc when leaving a relay doc open', async () => {
    h.currentDocumentId.value = 'doc-1';
    h.getRecord.mockReturnValue({ type: 'remote' });
    await switchWorkspace('ws-target');
    expect(h.newDocument).toHaveBeenCalledTimes(1);
  });
});
