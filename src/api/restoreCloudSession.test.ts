/**
 * Boot auto-sign-in (Lean): restoreCloudSession reuses the saved token on
 * restart — asserts it into the connection store and (for a local/no-doc boot)
 * stands up a REST-only provider to load the live cloud list. Expired → no
 * connect.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { loadConnection, setToken, setProvider, setAuthenticated, info } = vi.hoisted(() => ({
  loadConnection: vi.fn(),
  setToken: vi.fn(),
  setProvider: vi.fn(),
  setAuthenticated: vi.fn(),
  info: vi.fn(),
}));

vi.mock('./relayConnection', () => ({ loadConnection }));
vi.mock('../store/connectionStore', () => ({
  useConnectionStore: { getState: () => ({ setToken }) },
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
    [loadConnection, setToken, setProvider, setAuthenticated, info].forEach((m) => m.mockReset());
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

  it('restored + proactiveList: asserts token AND loads the live list', async () => {
    loadConnection.mockResolvedValueOnce(future);

    const r = await restoreCloudSession({ proactiveList: true, now: () => NOW });

    expect(r).toEqual({ status: 'restored' });
    expect(setToken).toHaveBeenCalledWith('tok', NOW + 60_000);
    expect(setProvider).toHaveBeenCalledTimes(1); // a REST provider was stood up
    expect(setAuthenticated).toHaveBeenCalledWith(true); // → fetchDocumentList
  });

  it('restored without proactiveList: asserts token only (relay-doc boot — Slice 1 lists)', async () => {
    loadConnection.mockResolvedValueOnce(future);

    const r = await restoreCloudSession({ proactiveList: false, now: () => NOW });

    expect(r).toEqual({ status: 'restored' });
    expect(setToken).toHaveBeenCalledWith('tok', NOW + 60_000);
    expect(setProvider).not.toHaveBeenCalled();
    expect(setAuthenticated).not.toHaveBeenCalled();
  });

  it('treats a null expiry as valid (matches isTokenValid)', async () => {
    loadConnection.mockResolvedValueOnce({ ...future, jwtExpiresAt: null });

    const r = await restoreCloudSession({ proactiveList: false, now: () => NOW });

    expect(r).toEqual({ status: 'restored' });
    expect(setToken).toHaveBeenCalledWith('tok', null);
  });
});
