import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { useIntegrationHubStore, workspaceIntegrationState, providerLabel } from './integrationHubStore';
import { webClient, type IntegrationsHub } from '../api/webClient';

const HUB: IntegrationsHub = {
  providers: [
    { id: 'notion', label: 'Notion', searchable: true },
    { id: 'confluence', label: 'Confluence', searchable: false },
  ],
  workspaces: [
    { id: 'ws-solo', entitled: true },
    { id: 'ws-free', entitled: false },
  ],
  connections: [{ workspaceId: 'ws-solo', provider: 'notion' }],
} as IntegrationsHub;

function reset() {
  useIntegrationHubStore.setState({ status: 'idle', hub: null, loadedAt: 0 });
}

describe('integrationHubStore', () => {
  beforeEach(reset);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads the hub once and caches it', async () => {
    const spy = vi.spyOn(webClient, 'getIntegrationsHub').mockResolvedValue(HUB);

    await useIntegrationHubStore.getState().ensureLoaded();
    await useIntegrationHubStore.getState().ensureLoaded();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(useIntegrationHubStore.getState().status).toBe('ready');
    expect(useIntegrationHubStore.getState().hub).toEqual(HUB);
  });

  it('coalesces concurrent loads instead of stampeding the control plane', async () => {
    // The tab bar prefetches on mount and the "+" click also refreshes, so
    // overlapping calls are the normal case, not an edge case.
    const spy = vi.spyOn(webClient, 'getIntegrationsHub').mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(HUB), 5)),
    );

    const { ensureLoaded } = useIntegrationHubStore.getState();
    await Promise.all([ensureLoaded(), ensureLoaded(), ensureLoaded()]);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('force re-fetches even inside the TTL', async () => {
    const spy = vi.spyOn(webClient, 'getIntegrationsHub').mockResolvedValue(HUB);

    await useIntegrationHubStore.getState().ensureLoaded();
    await useIntegrationHubStore.getState().ensureLoaded({ force: true });

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('re-fetches once the TTL has elapsed', async () => {
    const spy = vi.spyOn(webClient, 'getIntegrationsHub').mockResolvedValue(HUB);

    await useIntegrationHubStore.getState().ensureLoaded();
    // Older than the 5-minute TTL.
    useIntegrationHubStore.setState({ loadedAt: Date.now() - 6 * 60_000 });
    await useIntegrationHubStore.getState().ensureLoaded();

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('degrades to error without throwing when the caller is signed out', async () => {
    vi.spyOn(webClient, 'getIntegrationsHub').mockRejectedValue(new Error('not_signed_in'));

    // Integrations must never block core page creation, so this resolves.
    await expect(useIntegrationHubStore.getState().ensureLoaded()).resolves.toBeUndefined();
    expect(useIntegrationHubStore.getState().status).toBe('error');
    expect(useIntegrationHubStore.getState().hub).toBeNull();
  });
});

describe('workspaceIntegrationState', () => {
  it('projects entitlement and connection state for one workspace', () => {
    const state = workspaceIntegrationState(HUB, 'ws-solo');

    expect(state?.entitled).toBe(true);
    expect(state?.providers.find((p) => p.provider.id === 'notion')?.connected).toBe(true);
    expect(state?.providers.find((p) => p.provider.id === 'confluence')?.connected).toBe(false);
  });

  it('reports a non-entitled workspace as such, with providers still listed', () => {
    const state = workspaceIntegrationState(HUB, 'ws-free');

    expect(state?.entitled).toBe(false);
    expect(state?.providers).toHaveLength(2);
  });

  it('is null when the hub is absent or the workspace is unknown', () => {
    // This null is what makes the "+" fall back to a plain page create, so it
    // has to stay null rather than becoming an empty-but-entitled shape.
    expect(workspaceIntegrationState(null, 'ws-solo')).toBeNull();
    expect(workspaceIntegrationState(HUB, 'ws-nope')).toBeNull();
    expect(workspaceIntegrationState(HUB, null)).toBeNull();
  });
});

describe('providerLabel', () => {
  it('prefers the hub label', () => {
    expect(providerLabel(HUB, 'notion')).toBe('Notion');
  });

  it('capitalizes the id when the provider is unknown (a mirror page outlives its connection)', () => {
    expect(providerLabel(HUB, 'linear')).toBe('Linear');
    expect(providerLabel(null, 'notion')).toBe('Notion');
    expect(providerLabel(null, '')).toBe('');
  });
});
