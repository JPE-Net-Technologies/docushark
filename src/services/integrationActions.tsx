/**
 * Integration actions, contributed into the command registry (JP-506 slice 3).
 *
 * ## Why a contributed source rather than commands in the registry
 *
 * What integrations can do is not knowable at build time. It depends on which
 * providers the control plane offers, whether *this* workspace is entitled, and
 * which of them are actually connected — three answers that live in
 * `integrationHubStore` and change while the app is running. The registry is
 * engine-level and must not import feature stores, so it exposes a seam instead
 * and this module fills it.
 *
 * `buildCommands()` runs fresh on every read, so the source below is re-run each
 * time the palette opens or the Tools grid renders. An action appears the moment
 * a provider connects and disappears when entitlement lapses, with nothing to
 * invalidate.
 *
 * ## What an action is, today
 *
 * Exactly one per searchable provider: "New page from Notion…". That is the
 * whole inbound surface right now. The shape is deliberately built to hold more
 * — the `ops/` outbound surface is already reserved on the control-plane side —
 * so adding a second action per provider means adding an entry to
 * `actionsForProvider`, not touching the toolbar, the palette, or the grid.
 *
 * ## Where the picker opens
 *
 * The command dispatches an event rather than calling the picker directly: the
 * picker is owned by `RichTextTabBar`'s local state, and a command must be
 * runnable from the palette, where there is no such component in scope. Same
 * bridge the PDF and version-history commands use.
 */

import {
  registerCommandSource,
  type Command,
} from '../engine/CommandRegistry';
import { activeWorkspaceId } from '../store/activeWorkspace';
import {
  useIntegrationHubStore,
  workspaceIntegrationState,
  type WorkspaceProviderState,
} from '../store/integrationHubStore';
import { Plug } from 'lucide-react';

import { ProviderIcon } from '../ui/integrations/ProviderIcon';
import { loadConnection, DEFAULT_CLOUD_BASE_URL } from '../api/relayConnection';
import { opener } from '../platform/opener';

/** Event the editor listens for to open a provider's resource picker. */
export const OPEN_MIRROR_PICKER = 'docushark:open-mirror-picker';

export interface OpenMirrorPickerDetail {
  provider: string;
}

/** Ask the editor to open `provider`'s resource picker. */
export function openMirrorPicker(provider: string): void {
  window.dispatchEvent(
    new CustomEvent<OpenMirrorPickerDetail>(OPEN_MIRROR_PICKER, { detail: { provider } }),
  );
}

/**
 * The actions one connected provider offers. One today; the array is the seam
 * for the rest, so a new capability is a new entry here and nothing else.
 */
function actionsForProvider({ provider }: WorkspaceProviderState): Command[] {
  if (!provider.searchable) return [];
  return [
    {
      id: `integration.${provider.id}.newPage`,
      label: `New page from ${provider.label}…`,
      category: 'File',
      // The provider's own mark, not a generic plug: the `+` menu and the
      // resource picker already identify sources this way, and an action that
      // says "Notion" should look like the one beside it.
      iconNode: <ProviderIcon provider={provider.id} size={18} />,
      surfaces: ['palette', 'tools'],
      execute: () => openMirrorPicker(provider.id),
    },
  ];
}

/**
 * Every integration action available to the active workspace right now.
 *
 * Returns nothing rather than throwing when the hub has not loaded, the caller
 * is signed out, or the workspace is not entitled — integrations must never
 * block the core surfaces they share, which is the same rule the `+` menu on
 * the prose tab bar follows.
 */
export function currentIntegrationActions(): Command[] {
  const hub = useIntegrationHubStore.getState().hub;
  const ws = workspaceIntegrationState(hub, activeWorkspaceId());
  if (!ws?.entitled) return [];

  const searchable = ws.providers.filter((p) => p.provider.searchable);
  const connected = searchable.filter((p) => p.connected);
  if (connected.length > 0) return connected.flatMap(actionsForProvider);

  // Nothing connected yet, but this workspace is entitled to connect something.
  //
  // The `+` menu used to carry a "Connect <provider>…" row and was removed when
  // Tools took over the integration surface (JP-506); without this the editor
  // would offer no route to the account page at all, and an entitled user would
  // simply never learn the feature exists. One action, not one per provider —
  // the account page is where you choose.
  if (searchable.length === 0) return [];
  return [
    {
      id: 'integration.connect',
      label: 'Connect an integration…',
      category: 'File',
      icon: Plug,
      surfaces: ['palette', 'tools'],
      execute: () => void openAccountIntegrations(),
    },
  ];
}

/** Open the account site's integrations page in the user's browser. */
export async function openAccountIntegrations(): Promise<void> {
  const conn = await loadConnection();
  const base = (conn?.cloudBaseUrl ?? DEFAULT_CLOUD_BASE_URL).replace(/\/+$/, '');
  await opener.openExternalUrl(`${base}/account/integrations`);
}

/**
 * Register the source. Called once from app startup; safe to call again (the
 * registry keys sources by id, so a dev-server reload replaces rather than
 * duplicates).
 */
export function registerIntegrationActions(): void {
  registerCommandSource('integrations', currentIntegrationActions);
}
