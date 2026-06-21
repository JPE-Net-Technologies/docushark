import { describe, it, expect } from 'vitest';
import { useSettingsStore, migrateSettings, DEFAULT_CONNECTOR_STYLE } from './settingsStore';

describe('settingsStore last-used connector', () => {
  it('defaults new connectors to the straight/default style', () => {
    // jsdom localStorage is empty, so the store falls back to initial state.
    expect(useSettingsStore.getState().lastConnector).toEqual(DEFAULT_CONNECTOR_STYLE);
  });

  it('merges patches into the last-used connector style', () => {
    useSettingsStore.getState().setLastConnector({
      connectorType: 'erd',
      startCardinality: 'one',
      endCardinality: 'many',
    });
    const style = useSettingsStore.getState().lastConnector;
    expect(style).toEqual({
      routingMode: 'straight',
      connectorType: 'erd',
      startCardinality: 'one',
      endCardinality: 'many',
    });
    // reset for other tests
    useSettingsStore.getState().setLastConnector(DEFAULT_CONNECTOR_STYLE);
  });
});

describe('migrateSettings — v1→v2 (defaultConnectorType → lastConnector)', () => {
  it('rewrites the stale v0 orthogonal routing default to straight', () => {
    const result = migrateSettings({ defaultConnectorType: 'orthogonal' }, 0);
    expect(result.lastConnector).toEqual({ ...DEFAULT_CONNECTOR_STYLE, routingMode: 'straight' });
    expect('defaultConnectorType' in result).toBe(false);
  });

  it('leaves a v0 straight routing alone', () => {
    const result = migrateSettings({ defaultConnectorType: 'straight' }, 0);
    expect(result.lastConnector?.routingMode).toBe('straight');
  });

  it('preserves a deliberate orthogonal routing stored at v1', () => {
    const result = migrateSettings({ defaultConnectorType: 'orthogonal' }, 1);
    expect(result.lastConnector?.routingMode).toBe('orthogonal');
  });

  it('preserves other persisted fields while folding the routing in', () => {
    const result = migrateSettings(
      { defaultConnectorType: 'orthogonal', showMinimap: true, gridOpacity: 30 },
      1
    );
    expect(result.lastConnector?.routingMode).toBe('orthogonal');
    expect(result.showMinimap).toBe(true);
    expect(result.gridOpacity).toBe(30);
  });

  it('seeds a default style from empty/undefined persisted state', () => {
    expect(migrateSettings(undefined, 0).lastConnector).toEqual({
      ...DEFAULT_CONNECTOR_STYLE,
      routingMode: 'straight',
    });
  });

  it('passes through state already at v2', () => {
    const v2 = { lastConnector: { ...DEFAULT_CONNECTOR_STYLE, connectorType: 'uml-class' as const } };
    expect(migrateSettings(v2, 2)).toEqual(v2);
  });
});
