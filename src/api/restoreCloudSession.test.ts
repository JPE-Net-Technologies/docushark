/**
 * Boot auto-sign-in (Lean): restoreCloudSession reuses the saved token on
 * restart — asserts it into the connection store and (for a local/no-doc boot)
 * stands up a REST-only provider to load the live cloud list. Expired → no
 * connect.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  loadConnection,
  setToken,
  setUser,
  setHost,
  setProvider,
  setAuthenticated,
  info,
  attemptTokenRefresh,
  relayClientOpts,
  connState,
} = vi.hoisted(() => ({
  loadConnection: vi.fn(),
  setToken: vi.fn(),
  setUser: vi.fn(),
  setHost: vi.fn(),
  setProvider: vi.fn(),
  setAuthenticated: vi.fn(),
  info: vi.fn(),
  attemptTokenRefresh: vi.fn(),
  /** Options of every RelayClient constructed, so tests can fire onUnauthorized. */
  relayClientOpts: [] as Array<{ onUnauthorized?: () => void }>,
  /** Mutable connection-store state (token readable by the 401 refresh path). */
  connState: { user: null as unknown, token: null as string | null },
}));

vi.mock('./relayConnection', () => ({ loadConnection }));
vi.mock('./tokenRefresh', () => ({ attemptTokenRefresh }));
vi.mock('./relayClient', () => ({
  RelayClient: class {
    constructor(opts: { onUnauthorized?: () => void }) {
      relayClientOpts.push(opts);
    }
    setToken() {}
  },
}));
vi.mock('../store/connectionStore', () => ({
  useConnectionStore: { getState: () => ({ ...connState, setToken, setUser, setHost }) },
}));
vi.mock('../store/relayDocumentStore', () => ({
  useRelayDocumentStore: { getState: () => ({ setProvider, setAuthenticated }) },
}));
vi.mock('../store/notificationStore', () => ({
  useNotificationStore: { getState: () => ({ info }) },
}));

import { restoreCloudSession } from './restoreCloudSession';
import { activeWorkspaceId, clearRememberedWorkspaceId } from '../store/activeWorkspace';

const b64url = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const NOW = 1_000_000;
const future = { relayUrl: 'http://relay:9876', jwt: 'tok', jwtExpiresAt: NOW + 60_000, cloudBaseUrl: null };

describe('restoreCloudSession', () => {
  beforeEach(() => {
    [
      loadConnection,
      setToken,
      setUser,
      setHost,
      setProvider,
      setAuthenticated,
      info,
      attemptTokenRefresh,
    ].forEach((m) => m.mockReset());
    relayClientOpts.length = 0;
    connState.user = null;
    connState.token = null;
    clearRememberedWorkspaceId();
  });

  it("status 'none' when no connection / no token", async () => {
    loadConnection.mockResolvedValueOnce(null);
    expect(await restoreCloudSession({ proactiveList: true, now: () => NOW })).toEqual({ status: 'none' });

    loadConnection.mockResolvedValueOnce({ relayUrl: 'http://relay:9876', jwt: null, jwtExpiresAt: null });
    expect(await restoreCloudSession({ proactiveList: true, now: () => NOW })).toEqual({ status: 'none' });

    expect(setToken).not.toHaveBeenCalled();
    expect(setProvider).not.toHaveBeenCalled();
  });

  it("status 'expired' (no connect) when the token has expired", async () => {
    loadConnection.mockResolvedValueOnce({ ...future, jwtExpiresAt: NOW - 1 });

    const r = await restoreCloudSession({ proactiveList: true, now: () => NOW });

    expect(r).toEqual({ status: 'expired' });
    expect(setToken).not.toHaveBeenCalled();
    expect(setProvider).not.toHaveBeenCalled();
    expect(setAuthenticated).not.toHaveBeenCalled();
  });

  it("JP-390: recovers the workspace scope from an expired token (no connect)", async () => {
    // The token is dead (no auth), but it still names the workspace this session
    // belonged to — recover that scope so the cached relay docs stay listed.
    const jwt = `h.${b64url({ sub: 'u1', wsp: [{ id: 'ws-expired', role: 'owner' }] })}.s`;
    loadConnection.mockResolvedValueOnce({ ...future, jwt, jwtExpiresAt: NOW - 1 });

    const r = await restoreCloudSession({ proactiveList: true, now: () => NOW });

    expect(r).toEqual({ status: 'expired' });
    expect(setToken).not.toHaveBeenCalled(); // still never authenticates
    expect(activeWorkspaceId()).toBe('ws-expired'); // but the scope survives
  });

  it('restored + proactiveList: asserts token, stands up provider AND loads the live list', async () => {
    loadConnection.mockResolvedValueOnce(future);

    const r = await restoreCloudSession({ proactiveList: true, now: () => NOW });

    expect(r).toEqual({ status: 'restored' });
    expect(setToken).toHaveBeenCalledWith('tok', NOW + 60_000);
    expect(setProvider).toHaveBeenCalledTimes(1); // a REST provider was stood up
    // signed in + eager fetch (skipFetch false → fetchDocumentList)
    expect(setAuthenticated).toHaveBeenCalledWith(true, { skipFetch: false });
  });

  it('restored without proactiveList: still stands up provider (signed in) but skips the eager fetch', async () => {
    // The transfer-no-op fix: a relay-doc boot must still set authenticated +
    // provider (so isCloudSignedIn() is true and transfer works), just without
    // the eager list fetch — the WS handshake loads the list itself.
    loadConnection.mockResolvedValueOnce(future);

    const r = await restoreCloudSession({ proactiveList: false, now: () => NOW });

    expect(r).toEqual({ status: 'restored' });
    expect(setToken).toHaveBeenCalledWith('tok', NOW + 60_000);
    expect(setProvider).toHaveBeenCalledTimes(1);
    expect(setAuthenticated).toHaveBeenCalledWith(true, { skipFetch: true });
  });

  it('records the relay host so the REST list registers a real relayId (not "unknown")', async () => {
    // Without this, fetchDocumentList runs with connection.host null → every doc
    // registers as relayId 'unknown' → never matches the live relay → sync badge
    // stuck on 'idle'.
    loadConnection.mockResolvedValueOnce(future);

    await restoreCloudSession({ proactiveList: true, now: () => NOW });

    expect(setHost).toHaveBeenCalledWith({ address: 'relay:9876', url: 'http://relay:9876' });
  });

  it('populates the user from the token so identity-gated transfer works', async () => {
    // A REST-only session never gets a WS MESSAGE_AUTH_RESPONSE, so the user must
    // come from the token — else currentUser is null and the transfer no-ops.
    const b64url = (o: unknown) =>
      btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const jwt = `h.${b64url({ sub: 'user-9', wsp: [{ role: 'admin' }] })}.s`;
    loadConnection.mockResolvedValueOnce({ ...future, jwt });

    await restoreCloudSession({ proactiveList: false, now: () => NOW });

    expect(setUser).toHaveBeenCalledWith({ id: 'user-9', username: 'user-9', role: 'admin' });
  });

  it('treats a null expiry as valid (matches isTokenValid)', async () => {
    loadConnection.mockResolvedValueOnce({ ...future, jwtExpiresAt: null });

    const r = await restoreCloudSession({ proactiveList: false, now: () => NOW });

    expect(r).toEqual({ status: 'restored' });
    expect(setToken).toHaveBeenCalledWith('tok', null);
  });

  describe('REST 401 → silent refresh (JP-420)', () => {
    it('rebuilds the provider with the refreshed token instead of dropping', async () => {
      loadConnection.mockResolvedValue(future);
      await restoreCloudSession({ proactiveList: false, now: () => NOW });
      attemptTokenRefresh.mockResolvedValue(true);
      connState.token = 'fresh-tok';
      setProvider.mockClear();
      setAuthenticated.mockClear();

      relayClientOpts[0]!.onUnauthorized!();

      await vi.waitFor(() => expect(setProvider).toHaveBeenCalledTimes(1));
      // Rebuilt as signed-in (not dropped), no expiry prompt.
      expect(setProvider).not.toHaveBeenCalledWith(null);
      expect(setAuthenticated).toHaveBeenCalledWith(true, { skipFetch: true });
      expect(info).not.toHaveBeenCalled();
    });

    it('drops the provider and prompts re-sign-in when refresh fails', async () => {
      loadConnection.mockResolvedValue(future);
      await restoreCloudSession({ proactiveList: false, now: () => NOW });
      attemptTokenRefresh.mockResolvedValue(false);
      setProvider.mockClear();
      setAuthenticated.mockClear();

      relayClientOpts[0]!.onUnauthorized!();

      await vi.waitFor(() => expect(info).toHaveBeenCalled());
      expect(setProvider).toHaveBeenCalledWith(null);
      expect(setAuthenticated).toHaveBeenCalledWith(false);
    });
  });
});
