/**
 * styleProfileSync (JP-301) — the registry push/pull seam.
 *
 * Mocks the relay-facing deps and uses the REAL styleProfileStore, mirroring
 * `collectionSync.test.ts`. The cases here pin the behaviours that are easy to
 * regress and expensive to notice: local profiles never leaving the device, a
 * refresh not eating an in-flight create, and a quota refusal reaching the user
 * instead of being swallowed as a best-effort miss.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

vi.mock('./relayDocumentStore', () => ({
  getDocProvider: vi.fn(),
  isCloudSignedIn: vi.fn(() => true),
}));
vi.mock('./notificationStore', () => ({
  useNotificationStore: { getState: vi.fn() },
}));

import {
  pushStyleProfiles,
  pullStyleProfiles,
  ensureStyleProfilesHydrated,
  resetStyleProfileSync,
  toRelayDef,
  fromRelayDef,
} from './styleProfileSync';
import { useStyleProfileStore, seedProfiles, type StyleProfile } from './styleProfileStore';
import { getDocProvider, isCloudSignedIn } from './relayDocumentStore';
import { useNotificationStore } from './notificationStore';
import { RelayError, VersionConflictError, type RelayStyleProfileDef } from '../api/relayClient';

const getDocProviderMock = getDocProvider as unknown as Mock;
const authedMock = isCloudSignedIn as unknown as Mock;
const notifyGetState = useNotificationStore.getState as unknown as Mock;
const errorSpy = vi.fn();

function profile(id: string, scope: 'local' | 'workspace', name = id): StyleProfile {
  return {
    id,
    name,
    properties: { fill: '#111', stroke: '#222', strokeWidth: 2, opacity: 1 },
    createdAt: 1,
    favorite: false,
    scope,
  };
}

function makeProvider(defs: RelayStyleProfileDef[], version: number | null = 1) {
  return {
    getStyleProfiles: vi.fn(
      async (): Promise<{ profiles: RelayStyleProfileDef[]; version?: number }> => ({
        profiles: defs.map((d) => ({ ...d })),
        ...(version !== null ? { version } : {}),
      }),
    ),
    setStyleProfiles: vi.fn(
      async (_defs: RelayStyleProfileDef[], _expectedVersion?: number): Promise<void> => {},
    ),
  };
}

function setProfiles(profiles: StyleProfile[]): void {
  useStyleProfileStore.setState({ profiles: seedProfiles(profiles, []), favoriteDefaultIds: [] });
}

/** User (non-built-in) profiles currently in the store. */
function userProfiles(): StyleProfile[] {
  return useStyleProfileStore.getState().profiles.filter((p) => !p.id.startsWith('default-'));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStyleProfileSync();
  authedMock.mockReturnValue(true);
  notifyGetState.mockReturnValue({ error: errorSpy, warning: vi.fn(), success: vi.fn() });
  setProfiles([]);
});

describe('wire mapping', () => {
  it('round-trips a profile through the wire shape', () => {
    const original: StyleProfile = {
      ...profile('a', 'workspace', 'Dark Neon'),
      favorite: true,
      collectionIds: ['acme'],
    };
    expect(fromRelayDef(toRelayDef(original))).toEqual(original);
  });

  it('stamps workspace scope onto anything arriving from the relay', () => {
    // Everything in the registry is workspace-scoped by definition; scope is a
    // client concept and is never sent.
    const def: RelayStyleProfileDef = {
      id: 'a',
      name: 'A',
      properties: { fill: null, stroke: null, strokeWidth: 1, opacity: 1 },
      createdAt: 2,
    };
    expect(fromRelayDef(def).scope).toBe('workspace');
    expect(toRelayDef(profile('a', 'workspace'))).not.toHaveProperty('scope');
  });

  it('omits empty optional fields rather than sending noise', () => {
    const def = toRelayDef(profile('a', 'workspace'));
    expect(def).not.toHaveProperty('favorite');
    expect(def).not.toHaveProperty('collectionIds');
  });
});

describe('push', () => {
  it('sends only workspace-scoped profiles — local ones never leave the device', async () => {
    const provider = makeProvider([]);
    getDocProviderMock.mockReturnValue(provider);
    setProfiles([profile('local-1', 'local'), profile('ws-1', 'workspace')]);

    await pushStyleProfiles();

    expect(provider.setStyleProfiles).toHaveBeenCalledTimes(1);
    const [sent] = provider.setStyleProfiles.mock.calls[0] as [RelayStyleProfileDef[]];
    expect(sent.map((d) => d.id)).toEqual(['ws-1']);
  });

  it('never sends built-in defaults', async () => {
    const provider = makeProvider([]);
    getDocProviderMock.mockReturnValue(provider);
    setProfiles([profile('ws-1', 'workspace')]);

    await pushStyleProfiles();

    const [sent] = provider.setStyleProfiles.mock.calls[0] as [RelayStyleProfileDef[]];
    expect(sent.some((d) => d.id.startsWith('default-'))).toBe(false);
  });

  it('carries the fetched version as expectedVersion', async () => {
    const provider = makeProvider([], 7);
    getDocProviderMock.mockReturnValue(provider);
    setProfiles([profile('ws-1', 'workspace')]);

    await pushStyleProfiles();

    expect(provider.setStyleProfiles.mock.calls[0]?.[1]).toBe(7);
  });

  it('rebases exactly once on a version conflict', async () => {
    const provider = makeProvider([], 1);
    provider.setStyleProfiles
      .mockRejectedValueOnce(new VersionConflictError('/api/v1/style-profiles', 2))
      .mockResolvedValueOnce(undefined);
    getDocProviderMock.mockReturnValue(provider);
    setProfiles([profile('ws-1', 'workspace')]);

    await pushStyleProfiles();

    expect(provider.getStyleProfiles).toHaveBeenCalledTimes(2);
    expect(provider.setStyleProfiles).toHaveBeenCalledTimes(2);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('tells the user when a push is refused for quota, rather than failing silently', async () => {
    // A 507 means the styles genuinely did not save. Swallowing it would leave
    // someone believing hours of tuning is backed up when it is not.
    const provider = makeProvider([], 1);
    provider.setStyleProfiles.mockRejectedValue(
      new RelayError(507, '/api/v1/style-profiles', 'workspace storage quota exceeded'),
    );
    getDocProviderMock.mockReturnValue(provider);
    setProfiles([profile('ws-1', 'workspace')]);

    await pushStyleProfiles();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toMatch(/out of storage/i);
  });

  it('stays quiet on a transient failure', async () => {
    const provider = makeProvider([], 1);
    provider.setStyleProfiles.mockRejectedValue(new Error('network down'));
    getDocProviderMock.mockReturnValue(provider);
    setProfiles([profile('ws-1', 'workspace')]);

    await pushStyleProfiles();

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('is a no-op when signed out', async () => {
    const provider = makeProvider([]);
    getDocProviderMock.mockReturnValue(provider);
    authedMock.mockReturnValue(false);
    setProfiles([profile('ws-1', 'workspace')]);

    await pushStyleProfiles();

    expect(provider.setStyleProfiles).not.toHaveBeenCalled();
  });
});

describe('pull', () => {
  it('replaces the workspace slice and leaves local profiles alone', async () => {
    getDocProviderMock.mockReturnValue(
      makeProvider([
        {
          id: 'remote-1',
          name: 'Remote',
          properties: { fill: '#abc', stroke: null, strokeWidth: 1, opacity: 1 },
          createdAt: 3,
        },
      ]),
    );
    setProfiles([profile('local-1', 'local'), profile('stale-ws', 'workspace')]);

    await pullStyleProfiles();

    const ids = userProfiles().map((p) => p.id).sort();
    expect(ids).toEqual(['local-1', 'remote-1']);
    expect(userProfiles().find((p) => p.id === 'remote-1')?.scope).toBe('workspace');
  });

  it("does not erase a create whose push hasn't landed yet", async () => {
    // The JP-424 lesson, ported: a refresh that raced an in-flight create used
    // to read "absent from the relay" as "deleted" and drop a brand-new item.
    const provider = makeProvider([], 1);
    provider.setStyleProfiles.mockRejectedValue(new Error('network down'));
    getDocProviderMock.mockReturnValue(provider);
    setProfiles([profile('ws-new', 'workspace')]);

    await pushStyleProfiles(); // fails → id stays unconfirmed
    await pullStyleProfiles(); // relay returns an empty set

    expect(userProfiles().map((p) => p.id)).toContain('ws-new');
  });

  it('is a no-op when signed out', async () => {
    const provider = makeProvider([]);
    getDocProviderMock.mockReturnValue(provider);
    authedMock.mockReturnValue(false);
    setProfiles([profile('local-1', 'local')]);

    await pullStyleProfiles();

    expect(provider.getStyleProfiles).not.toHaveBeenCalled();
    expect(userProfiles().map((p) => p.id)).toEqual(['local-1']);
  });
});

describe('hydration', () => {
  it('pulls once per workspace connection, not on every list fetch', async () => {
    const provider = makeProvider([]);
    getDocProviderMock.mockReturnValue(provider);

    await ensureStyleProfilesHydrated();
    await ensureStyleProfilesHydrated();
    await ensureStyleProfilesHydrated();

    expect(provider.getStyleProfiles).toHaveBeenCalledTimes(1);
  });

  it('hydrates again after leaving the workspace', async () => {
    const provider = makeProvider([]);
    getDocProviderMock.mockReturnValue(provider);

    await ensureStyleProfilesHydrated();
    resetStyleProfileSync();
    await ensureStyleProfilesHydrated();

    expect(provider.getStyleProfiles).toHaveBeenCalledTimes(2);
  });
});
