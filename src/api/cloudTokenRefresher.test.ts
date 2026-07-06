// JP-420 cloud sliding-token refresher: success persists + returns ms expiry,
// a missing endpoint (404/405) is memoized for the process, transient failures
// are not, and no request fires without a usable (unexpired) token + cloud URL.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createCloudTokenRefresher,
  __resetCloudRefresherForTests,
} from './cloudTokenRefresher';
import { WebClientError, webClient } from './webClient';
import { loadConnection, saveConnection } from './relayConnection';
import { useConnectionStore } from '../store/connectionStore';

vi.mock('./webClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./webClient')>();
  return {
    ...actual,
    webClient: { ...actual.webClient, refreshAppToken: vi.fn() },
  };
});

vi.mock('./relayConnection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./relayConnection')>();
  return {
    ...actual,
    loadConnection: vi.fn(),
    saveConnection: vi.fn().mockResolvedValue(undefined),
  };
});

const mockRefresh = vi.mocked(webClient.refreshAppToken);
const mockLoad = vi.mocked(loadConnection);
const mockSave = vi.mocked(saveConnection);

const CONN = {
  relayUrl: 'https://relay.test',
  cloudBaseUrl: 'https://cloud.test',
  jwt: 'persisted-token',
  jwtExpiresAt: Date.now() + 60 * 60_000,
  workspaceName: null,
  workspaceSlug: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetCloudRefresherForTests();
  useConnectionStore.setState({ token: null, tokenExpiresAt: null });
  mockLoad.mockResolvedValue({ ...CONN });
});

describe('createCloudTokenRefresher', () => {
  it('renews, persists, and returns the fresh token with a ms expiry', async () => {
    const expSec = Math.floor(Date.now() / 1000) + 3600;
    mockRefresh.mockResolvedValue({
      token: 'fresh-token',
      expiresAt: expSec,
      relayUrl: 'https://relay.test',
      workspaceName: 'Alpha',
      workspaceSlug: 'alpha',
    });
    useConnectionStore.setState({ token: 'live-token', tokenExpiresAt: Date.now() + 60_000 });

    const result = await createCloudTokenRefresher()();

    expect(result).toEqual({ token: 'fresh-token', expiresAt: expSec * 1000 });
    // Authenticated with the LIVE token, not the persisted one.
    expect(mockRefresh).toHaveBeenCalledWith({ token: 'live-token' });
    expect(mockSave).toHaveBeenCalledWith('https://relay.test', 'fresh-token', {
      jwtExpiresAt: expSec * 1000,
      workspaceName: 'Alpha',
      workspaceSlug: 'alpha',
    });
  });

  it('falls back to the persisted token when no live token is set', async () => {
    mockRefresh.mockResolvedValue({
      token: 't2',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      relayUrl: 'https://relay.test',
      workspaceName: null,
      workspaceSlug: null,
    });

    const result = await createCloudTokenRefresher()();
    expect(result?.token).toBe('t2');
    expect(mockRefresh).toHaveBeenCalledWith({ token: 'persisted-token' });
  });

  it('memoizes a missing endpoint (404) and never re-probes', async () => {
    mockRefresh.mockRejectedValue(new WebClientError(404, 'http_404'));
    const refresher = createCloudTokenRefresher();

    expect(await refresher()).toBeNull();
    expect(await refresher()).toBeNull();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('does NOT memoize transient failures (401/500/network)', async () => {
    mockRefresh.mockRejectedValue(new WebClientError(500, 'http_500'));
    const refresher = createCloudTokenRefresher();

    expect(await refresher()).toBeNull();
    expect(await refresher()).toBeNull();
    expect(mockRefresh).toHaveBeenCalledTimes(2);
  });

  it('bails without a cloud base URL', async () => {
    mockLoad.mockResolvedValue({ ...CONN, cloudBaseUrl: null });
    expect(await createCloudTokenRefresher()()).toBeNull();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('bails without any token', async () => {
    mockLoad.mockResolvedValue({ ...CONN, jwt: null });
    expect(await createCloudTokenRefresher()()).toBeNull();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('bails on an already-expired token (server would 401 anyway)', async () => {
    mockLoad.mockResolvedValue({ ...CONN, jwtExpiresAt: Date.now() - 1000 });
    expect(await createCloudTokenRefresher()()).toBeNull();
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
