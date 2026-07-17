/**
 * Integration hub cache (JP-415) — the editor's view of what integrations
 * exist: available providers, per-workspace entitlement (a boolean from the
 * control plane — plan resolution happens entirely server-side), and which
 * providers are connected.
 *
 * Loaded lazily the first time an affordance needs it (the prose tab bar's
 * add menu) and cached with a short TTL — connect/upgrade actions happen on
 * the account site, so staleness self-heals on the next menu open. A signed-
 * out or failed load resolves to `error` and the UI degrades to plain "New
 * page" — integrations never block core page creation.
 */

import { create } from 'zustand';

import { webClient, type IntegrationsHub, type IntegrationProvider } from '../api/webClient';

const TTL_MS = 5 * 60_000;

interface IntegrationHubState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  hub: IntegrationsHub | null;
  loadedAt: number;
  /** Load (or TTL-refresh) the hub. Concurrent calls coalesce on `loading`. */
  ensureLoaded: (opts?: { force?: boolean }) => Promise<void>;
}

export const useIntegrationHubStore = create<IntegrationHubState>((set, get) => ({
  status: 'idle',
  hub: null,
  loadedAt: 0,

  ensureLoaded: async ({ force = false } = {}) => {
    const { status, loadedAt } = get();
    if (status === 'loading') return;
    if (!force && status === 'ready' && Date.now() - loadedAt < TTL_MS) return;
    set({ status: 'loading' });
    try {
      const hub = await webClient.getIntegrationsHub();
      set({ status: 'ready', hub, loadedAt: Date.now() });
    } catch {
      // Signed out, offline, or an older control plane without the endpoint —
      // all degrade the same way (no integration affordances).
      set({ status: 'error', hub: null, loadedAt: Date.now() });
    }
  },
}));

export interface WorkspaceProviderState {
  provider: IntegrationProvider;
  connected: boolean;
}

export interface WorkspaceIntegrationState {
  entitled: boolean;
  providers: WorkspaceProviderState[];
}

/** Display label for a provider id — hub label when known, else the id
 *  capitalized (a mirror page can outlive its provider's connection). */
export function providerLabel(hub: IntegrationsHub | null, providerId: string): string {
  const known = hub?.providers.find((p) => p.id === providerId)?.label;
  return known ?? (providerId.length > 0 ? providerId[0]!.toUpperCase() + providerId.slice(1) : providerId);
}

/**
 * Project the hub onto one workspace: is it entitled, and each provider's
 * connection state. Null when the hub doesn't know the workspace (not loaded,
 * or the caller isn't a member).
 */
export function workspaceIntegrationState(
  hub: IntegrationsHub | null,
  workspaceId: string | null | undefined,
): WorkspaceIntegrationState | null {
  if (!hub || !workspaceId) return null;
  const ws = hub.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return null;
  return {
    entitled: ws.entitled,
    providers: hub.providers.map((provider) => ({
      provider,
      connected: hub.connections.some((c) => c.workspaceId === workspaceId && c.provider === provider.id),
    })),
  };
}
