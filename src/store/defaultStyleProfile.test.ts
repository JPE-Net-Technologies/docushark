/**
 * JP-301 — the Default Style Profile setting finally does something.
 *
 * The setting has existed (and been persisted, and been included in backups)
 * since long before this, promising "New shapes will be created with this style
 * applied" while nothing read it back. These cases pin the reader, and in
 * particular the two degradations that must never throw: no default set, and a
 * default pointing at a profile that has since been deleted.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { applyDefaultStyleProfile } from './defaultStyleProfile';
import { useSettingsStore } from './settingsStore';
import { useStyleProfileStore, seedProfiles, type StyleProfile } from './styleProfileStore';
import type { Shape } from '../shapes/Shape';

function rect(over: Partial<Shape> = {}): Shape {
  return {
    id: 's1',
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 100,
    height: 60,
    rotation: 0,
    fill: '#ffffff',
    stroke: '#000000',
    strokeWidth: 1,
    opacity: 1,
    visible: true,
    locked: false,
    ...over,
  } as Shape;
}

const NEON: StyleProfile = {
  id: 'p-neon',
  name: 'Dark Neon',
  properties: { fill: '#111111', stroke: '#39ff14', strokeWidth: 3, opacity: 0.9, cornerRadius: 8 },
  createdAt: 1,
  favorite: false,
  scope: 'local',
};

beforeEach(() => {
  useStyleProfileStore.setState({ profiles: seedProfiles([NEON], []), favoriteDefaultIds: [] });
  useSettingsStore.setState({ defaultStyleProfileId: null });
});

describe('applyDefaultStyleProfile', () => {
  it('leaves the shape untouched when no default is configured', () => {
    const shape = rect();
    expect(applyDefaultStyleProfile(shape)).toEqual(shape);
  });

  it('applies the configured profile to a new shape', () => {
    useSettingsStore.setState({ defaultStyleProfileId: 'p-neon' });
    const styled = applyDefaultStyleProfile(rect());
    expect(styled.fill).toBe('#111111');
    expect(styled.stroke).toBe('#39ff14');
    expect(styled.strokeWidth).toBe(3);
  });

  it('degrades to tool defaults when the configured profile was deleted', () => {
    // A dangling id is entirely reachable: delete a profile that is set as the
    // default and the setting keeps pointing at it. It must not throw, and it
    // must not silently produce a half-styled shape.
    useSettingsStore.setState({ defaultStyleProfileId: 'p-does-not-exist' });
    const shape = rect();
    expect(applyDefaultStyleProfile(shape)).toEqual(shape);
  });

  it('preserves the shape identity and geometry it was given', () => {
    useSettingsStore.setState({ defaultStyleProfileId: 'p-neon' });
    const styled = applyDefaultStyleProfile(rect({ id: 'keep-me', x: 42, y: 7 }));
    expect(styled.id).toBe('keep-me');
    expect(styled.x).toBe(42);
    expect(styled.y).toBe(7);
    expect(styled.type).toBe('rectangle');
  });

  it('hands a shape only the fields its own facets own', () => {
    // The gated apply is what stops a rectangle-shaped default smearing
    // irrelevant chrome onto other families.
    useSettingsStore.setState({ defaultStyleProfileId: 'p-neon' });
    const styled = applyDefaultStyleProfile(rect({ id: 'c1', type: 'connector' }));
    expect(styled.stroke).toBe('#39ff14');
    expect(styled).not.toHaveProperty('cornerRadius');
  });

  it('works with a built-in default profile', () => {
    useSettingsStore.setState({ defaultStyleProfileId: 'default-green' });
    const styled = applyDefaultStyleProfile(rect());
    expect(styled.fill).toBe('#48bb78');
  });
});
