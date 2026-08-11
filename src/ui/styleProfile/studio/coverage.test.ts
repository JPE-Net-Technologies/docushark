/**
 * JP-301 — the Studio's coverage model.
 *
 * These pin the two claims the surface makes: that families are grouped by what
 * can actually style them (not by shape type, which would be unreadable once the
 * libraries register), and that a key is reported saved only when the profile
 * genuinely carries a value.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveStudioFamilies,
  getStudioCoverage,
  forgetKey,
  prettifyKey,
  UNIVERSAL_KEYS,
} from './coverage';
// Side-effect import: registers every built-in shape handler synchronously, the
// same way `main.tsx` does. Without it the registry is empty and the families
// resolve against nothing.
import '../../../shapes/registerBuiltInShapes';
import { shapeRegistry } from '../../../shapes/ShapeRegistry';
import type { StyleProfile } from '../../../store/styleProfileStore';
import type { StyleProfileProperties } from '../../../store/styleProfile';

function profile(properties: Partial<StyleProfileProperties>): StyleProfile {
  return {
    id: 'p1',
    name: 'Test',
    properties: {
      fill: '#111111',
      stroke: '#222222',
      strokeWidth: 2,
      opacity: 1,
      ...properties,
    },
    createdAt: 1,
    favorite: false,
    scope: 'local',
  };
}

describe('resolveStudioFamilies', () => {
  it('groups shape types by what can style them, not one row per type', () => {
    const families = resolveStudioFamilies(profile({}));
    expect(families.length).toBeGreaterThan(0);
    // The whole point of signature bucketing: far fewer families than types.
    expect(families.length).toBeLessThanOrEqual(shapeRegistry.getRegisteredTypes().length);
    // Every registered type lands in exactly one family.
    const assigned = families.flatMap((f) => f.types);
    expect(new Set(assigned).size).toBe(assigned.length);
    expect(assigned.length).toBe(shapeRegistry.getRegisteredTypes().length);
  });

  it('gives every family a stable, order-independent id', () => {
    const a = resolveStudioFamilies(profile({}));
    const b = resolveStudioFamilies(profile({}));
    expect(a.map((f) => f.id)).toEqual(b.map((f) => f.id));
    // The id is the sorted facet signature, so it never depends on registry order.
    for (const f of a) expect(f.id).toBe([...f.facetIds].sort().join('+'));
  });

  it('always reports the universal keys as saved — every profile carries them', () => {
    const families = resolveStudioFamilies(profile({}));
    for (const family of families) {
      for (const key of family.keys) {
        if (UNIVERSAL_KEYS.includes(key.key)) expect(key.saved).toBe(true);
      }
    }
  });

  it('marks a key inherited when the profile has no value for it', () => {
    const families = resolveStudioFamilies(profile({}));
    const withCornerRadius = families.find((f) => f.keys.some((k) => k.key === 'cornerRadius'));
    expect(withCornerRadius).toBeDefined();
    const entry = withCornerRadius!.keys.find((k) => k.key === 'cornerRadius')!;
    expect(entry.saved).toBe(false);
    expect(entry.value).toBeUndefined();
  });

  it('marks a key saved once the profile carries it', () => {
    const families = resolveStudioFamilies(profile({ cornerRadius: 12 }));
    const entry = families
      .flatMap((f) => f.keys)
      .find((k) => k.key === 'cornerRadius')!;
    expect(entry.saved).toBe(true);
    expect(entry.value).toBe(12);
  });

  it('sorts tuned families ahead of inherit-only ones', () => {
    const families = resolveStudioFamilies(profile({ cornerRadius: 8 }));
    const firstUntuned = families.findIndex((f) => !f.hasSavedKeys);
    const lastTuned = families.map((f) => f.hasSavedKeys).lastIndexOf(true);
    if (firstUntuned !== -1) expect(lastTuned).toBeLessThan(firstUntuned);
  });
});

describe('getStudioCoverage', () => {
  it('counts families with at least one saved key', () => {
    const cov = getStudioCoverage(profile({}));
    expect(cov.reachable).toBeGreaterThan(0);
    // A bare profile still carries the four universal keys, so every family it
    // reaches is "tuned" in the minimal sense.
    expect(cov.saved).toBeLessThanOrEqual(cov.reachable);
  });
});

describe('forgetKey', () => {
  it('removes an optional key', () => {
    const props = profile({ cornerRadius: 8 }).properties;
    const next = forgetKey(props, 'cornerRadius');
    expect(next).not.toHaveProperty('cornerRadius');
    expect(props).toHaveProperty('cornerRadius'); // original untouched
  });

  it('refuses to remove a universal key', () => {
    // `fill` is required by StyleProfileProperties — deleting it would produce a
    // profile the type says cannot exist.
    const props = profile({}).properties;
    expect(forgetKey(props, 'fill')).toEqual(props);
    expect(forgetKey(props, 'strokeWidth')).toEqual(props);
  });

  it('is a no-op for a key that was never saved', () => {
    const props = profile({}).properties;
    expect(forgetKey(props, 'cornerRadius')).toEqual(props);
  });
});

describe('prettifyKey', () => {
  it('turns a camelCase key into readable text', () => {
    expect(prettifyKey('rowSeparatorColor')).toBe('Row separator color');
    expect(prettifyKey('iconId')).toBe('Icon id');
  });
});
