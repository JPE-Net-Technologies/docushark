/**
 * Boot auto-sign-in (Lean): restoreCloudSession reuses the saved token on
 * restart — asserts it into the connection store and (for a local/no-doc boot)
 * stands up a REST-only provider to load the live cloud list. Expired → no
 * connect.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { loadConnection, setToken, setUser, setHost, setProvider, setAuthenticated, info } = vi.hoisted(
  () => ({
    loadConnection: vi.fn(),
    setToken: vi.fn(),
    setUser: vi.fn(),
    setHost: vi.fn(),
    setProvider: vi.fn(),
    setAuthenticated: vi.fn(),
    info: vi.fn(),
  }),
);

vi.mock('./relayConnection', () => ({ loadConnection }));
vi.mock('../store/connectionStore', () => ({
  useConnectionStore: { getState: () => ({ user: null, setToken, setUser, setHost }) },
}));
vi.mock('../store/relayDocumentStore', () => ({
  useRelayDocumentStore: { getState: () => ({ setProvider, setAuthenticated }) },
}));
vi.mock('../store/notificationStore', () => ({
  useNotificationStore: { getState: () => ({ info }) },
}));

import { restoreCloudSession } from './restoreCloudSession';

const NOW = 1_000_000;
const future = { relayUrl: 'http://relay:9876', jwt: 'tok', jwtExpiresAt: NOW + 60_000, cloudBaseUrl: null };

describe('restoreCloudSession', () => {
  beforeEach(() => {
    [loadConnection, setToken, setUser, setHost, setProvider, setAuthenticated, info].forEach((m) =>
      m.mockReset(),
    );
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
});
