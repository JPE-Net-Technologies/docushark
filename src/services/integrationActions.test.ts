import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { currentIntegrationActions, OPEN_MIRROR_PICKER, openMirrorPicker } from './integrationActions';
import { useIntegrationHubStore } from '../store/integrationHubStore';
import type { IntegrationsHub } from '../api/webClient';

const HUB = {
  providers: [
    { id: 'notion', label: 'Notion', searchable: true },
    { id: 'confluence', label: 'Confluence', searchable: false },
  ],
  workspaces: [{ id: 'ws-1', entitled: true }, { id: 'ws-2', entitled: false }],
  connections: [{ workspaceId: 'ws-1', provider: 'notion' }],
} as IntegrationsHub;

vi.mock('../store/activeWorkspace', () => ({ activeWorkspaceId: () => 'ws-1' }));

function setHub(hub: IntegrationsHub | null) {
  useIntegrationHubStore.setState({ hub, status: hub ? 'ready' : 'idle', loadedAt: Date.now() });
}

describe('currentIntegrationActions', () => {
  beforeEach(() => setHub(HUB));
  afterEach(() => setHub(null));

  it('offers one action per connected, searchable provider', () => {
    const actions = currentIntegrationActions();
    expect(actions.map((a) => a.id)).toEqual(['integration.notion.newPage']);
    expect(actions[0]?.label).toBe('New page from Notion…');
  });

  it('puts the action on BOTH the palette and the Tools grid', () => {
    expect(currentIntegrationActions()[0]?.surfaces).toEqual(['palette', 'tools']);
  });

  it('carries the provider brand mark, not a generic glyph', () => {
    // The `+` menu and the resource picker already identify sources this way;
    // an action that says "Notion" should look like the one beside it.
    expect(currentIntegrationActions()[0]?.iconNode).toBeTruthy();
  });

  it('offers nothing when the hub has not loaded', () => {
    // Integrations must never block the surfaces they share, so an unloaded
    // hub is silence, not an error.
    setHub(null);
    expect(currentIntegrationActions()).toEqual([]);
  });

  it('offers nothing for a workspace that is not entitled', () => {
    setHub({ ...HUB, workspaces: [{ id: 'ws-1', entitled: false }] } as IntegrationsHub);
    expect(currentIntegrationActions()).toEqual([]);
  });

  it('offers a CONNECT action when nothing is connected yet', () => {
    // The `+` menu carried a "Connect <provider>…" row and was removed when
    // Tools took over the integration surface. Without this the editor offers
    // no route to the account page at all, and an entitled user never learns
    // the feature exists.
    setHub({ ...HUB, connections: [] } as IntegrationsHub);
    const actions = currentIntegrationActions();
    expect(actions.map((a) => a.id)).toEqual(['integration.connect']);
    expect(actions[0]?.label).toBe('Connect an integration…');
  });

  it('offers ONE connect action, not one per unconnected provider', () => {
    // The account page is where you choose which; a list here would just be a
    // worse version of that page.
    setHub({
      ...HUB,
      providers: [
        { id: 'notion', label: 'Notion', searchable: true },
        { id: 'other', label: 'Other', searchable: true },
      ],
      connections: [],
    } as IntegrationsHub);
    expect(currentIntegrationActions()).toHaveLength(1);
  });

  it('a connected provider suppresses the connect action', () => {
    // Once you are in, the prompt to get in is noise.
    expect(currentIntegrationActions().map((a) => a.id)).toEqual(['integration.notion.newPage']);
  });

  it('offers nothing at all when no provider is searchable', () => {
    // Searchable is what makes "pick a page" meaningful, so there is nothing to
    // connect FOR — not even the prompt.
    setHub({
      ...HUB,
      providers: [{ id: 'confluence', label: 'Confluence', searchable: false }],
      connections: [{ workspaceId: 'ws-1', provider: 'confluence' }],
    } as IntegrationsHub);
    expect(currentIntegrationActions()).toEqual([]);
  });
});

describe('openMirrorPicker', () => {
  it('asks for the picker by event, naming the provider', () => {
    // The picker is owned by RichTextTabBar's local state, and a command must
    // run from the palette where that component is not in scope.
    const seen: string[] = [];
    const onOpen = (e: Event) => seen.push((e as CustomEvent<{ provider: string }>).detail.provider);
    window.addEventListener(OPEN_MIRROR_PICKER, onOpen);
    openMirrorPicker('notion');
    window.removeEventListener(OPEN_MIRROR_PICKER, onOpen);

    expect(seen).toEqual(['notion']);
  });

  it('the action executes into that same event', () => {
    setHub(HUB);
    const seen: string[] = [];
    const onOpen = (e: Event) => seen.push((e as CustomEvent<{ provider: string }>).detail.provider);
    window.addEventListener(OPEN_MIRROR_PICKER, onOpen);
    currentIntegrationActions()[0]?.execute();
    window.removeEventListener(OPEN_MIRROR_PICKER, onOpen);
    setHub(null);

    expect(seen).toEqual(['notion']);
  });
});
