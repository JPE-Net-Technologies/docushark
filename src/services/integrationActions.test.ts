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

  it('skips a provider that is available but NOT connected', () => {
    setHub({ ...HUB, connections: [] } as IntegrationsHub);
    expect(currentIntegrationActions()).toEqual([]);
  });

  it('skips a connected provider that is not searchable', () => {
    // Searchable is what makes "pick a page" meaningful; a connector without it
    // has nothing for this action to open.
    setHub({
      ...HUB,
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
