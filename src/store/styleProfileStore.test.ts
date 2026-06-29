/**
 * Coverage for the style-profile extract → store → apply round trip,
 * with a focus on the icon-field surface (JP-7).
 *
 * The original bug: applying a style profile to a shape with an icon
 * removed the icon. Root cause: `StyleProfileProperties` and the apply
 * path (`getProfileUpdates`) only covered 5 of the 8 icon fields that
 * live on a Rectangle/Ellipse/LibraryShape, so `iconDisplayMode`,
 * `iconBadge`, and `icons[]` never survived a save+apply cycle.
 */

import { describe, it, expect } from 'vitest';
import {
  extractStyleFromShape,
  getProfileUpdates,
  mergeProfileProperties,
  seedProfiles,
  migrateStyleProfiles,
  useStyleProfileStore,
  type StyleProfile,
  type StyleProfileProperties,
} from './styleProfileStore';
import type { BaseShape, RectangleShape, LineShape, IconBadgeConfig, IconConfig } from '../shapes/Shape';

function makeRectangle(overrides: Partial<RectangleShape> = {}): RectangleShape {
  return {
    id: 'rect-1',
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 100,
    height: 60,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    fill: '#ffffff',
    stroke: '#000000',
    strokeWidth: 2,
    cornerRadius: 0,
    ...overrides,
  };
}

function makeLine(overrides: Partial<LineShape> = {}): LineShape {
  return {
    id: 'line-1',
    type: 'line',
    x: 0,
    y: 0,
    x2: 50,
    y2: 50,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    fill: null,
    stroke: '#000000',
    strokeWidth: 2,
    startArrow: false,
    endArrow: true,
    ...overrides,
  };
}

function makeFile(overrides: Record<string, unknown> = {}): BaseShape {
  return {
    id: 'file-1',
    type: 'file',
    x: 0,
    y: 0,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    fill: '#f8fafc',
    stroke: '#cbd5e1',
    strokeWidth: 1,
    ...overrides,
  } as unknown as BaseShape;
}

function makeProfile(name: string, properties: StyleProfileProperties): StyleProfile {
  return {
    id: `profile-${name}`,
    name,
    properties,
    createdAt: 0,
    favorite: false,
  };
}

describe('default-profile hardening (JP-401)', () => {
  it('seedProfiles seeds canonical built-ins, appends user profiles, applies favorites', () => {
    const user = makeProfile('mine', { fill: '#111', stroke: '#222', strokeWidth: 1, opacity: 1 });
    const seeded = seedProfiles([user], ['default-blue']);

    expect(seeded.filter((p) => p.id.startsWith('default-')).length).toBe(5);
    expect(seeded[seeded.length - 1]?.id).toBe(user.id);
    expect(seeded.find((p) => p.id === 'default-blue')?.favorite).toBe(true);
    expect(seeded.find((p) => p.id === 'default-green')?.favorite).toBe(false);
  });

  it('seedProfiles drops stray default- entries from user profiles (no duplicates)', () => {
    const stray: StyleProfile = {
      ...makeProfile('x', { fill: '#0', stroke: '#0', strokeWidth: 1, opacity: 1 }),
      id: 'default-blue',
    };
    const seeded = seedProfiles([stray], []);
    expect(seeded.filter((p) => p.id === 'default-blue').length).toBe(1);
  });

  it('migrateStyleProfiles v1 strips baked-in defaults and lifts favorited built-ins', () => {
    const v1 = {
      profiles: [
        { id: 'default-blue', name: 'Default Blue', properties: { fill: '#x', stroke: '#y', strokeWidth: 2, opacity: 1 }, createdAt: 0, favorite: true },
        { id: 'user-1', name: 'Mine', properties: { fill: '#a', stroke: '#b', strokeWidth: 1, opacity: 1 }, createdAt: 1, favorite: false },
      ],
    };
    const out = migrateStyleProfiles(v1, 1);
    expect(out.profiles.map((p) => p.id)).toEqual(['user-1']);
    expect(out.favoriteDefaultIds).toEqual(['default-blue']);
  });

  it('migrateStyleProfiles is idempotent on v2 data', () => {
    const v2 = {
      profiles: [{ id: 'user-1', name: 'Mine', properties: { fill: null, stroke: null, strokeWidth: 1, opacity: 1 }, createdAt: 1, favorite: false }],
      favoriteDefaultIds: ['default-green'],
    };
    expect(migrateStyleProfiles(v2, 2)).toEqual(v2);
  });

  it('updateProfile is a no-op on a built-in (immutable)', () => {
    const before = useStyleProfileStore.getState().getProfile('default-blue');
    useStyleProfileStore.getState().updateProfile('default-blue', {
      name: 'HACKED',
      properties: { fill: '#000', stroke: '#000', strokeWidth: 9, opacity: 0.1 },
    });
    const after = useStyleProfileStore.getState().getProfile('default-blue');
    expect(after?.name).toBe(before?.name);
    expect(after?.properties).toEqual(before?.properties);
  });

  it('toggleFavorite on a built-in tracks it in the favoriteDefaultIds overlay', () => {
    const start = useStyleProfileStore.getState().favoriteDefaultIds.includes('default-subtle');
    useStyleProfileStore.getState().toggleFavorite('default-subtle');
    const s1 = useStyleProfileStore.getState();
    expect(s1.favoriteDefaultIds.includes('default-subtle')).toBe(!start);
    expect(s1.getProfile('default-subtle')?.favorite).toBe(!start);
    // restore
    useStyleProfileStore.getState().toggleFavorite('default-subtle');
    expect(useStyleProfileStore.getState().favoriteDefaultIds.includes('default-subtle')).toBe(start);
  });
});

describe('mergeProfileProperties — non-destructive master memory (JP-399)', () => {
  it('keeps a rectangle cornerRadius when later updating the profile from a file', () => {
    // Save a rectangle's style into a profile.
    const rectProps = extractStyleFromShape(makeRectangle({ cornerRadius: 8, fill: '#ffffff' }));
    expect(rectProps.cornerRadius).toBe(8);

    // Later "Update with current" from a file shape, which has no cornerRadius.
    const fileProps = extractStyleFromShape(makeFile({ fill: '#f8fafc' }));
    expect(fileProps.cornerRadius).toBeUndefined();

    const merged = mergeProfileProperties(rectProps, fileProps);

    // The file's universal fill wins (the freshly-saved look)…
    expect(merged.fill).toBe('#f8fafc');
    // …but the rectangle's radius is preserved, not clobbered. This was the bug:
    // a full replace deleted it.
    expect(merged.cornerRadius).toBe(8);
  });

  it('unions fields across shapes so one profile can style many shape types', () => {
    const a: StyleProfileProperties = { fill: '#111', stroke: '#222', strokeWidth: 2, opacity: 1, cornerRadius: 4 };
    const b: StyleProfileProperties = { fill: '#333', stroke: '#444', strokeWidth: 3, opacity: 1, fontSize: 18 };
    const merged = mergeProfileProperties(a, b);
    expect(merged).toMatchObject({ fill: '#333', stroke: '#444', strokeWidth: 3, cornerRadius: 4, fontSize: 18 });
  });
});

describe('extractStyleFromShape — icon coverage (JP-7)', () => {
  it('captures all 8 icon fields when includeIconStyle is true', () => {
    const badge: IconBadgeConfig = {
      shape: 'circle',
      backgroundColor: '#fef3c7',
      borderColor: '#f59e0b',
      borderWidth: 1,
    };
    const icons: IconConfig[] = [
      { iconId: 'builtin:star', position: 'top-right', size: 16 },
    ];

    const shape = makeRectangle({
      iconId: 'builtin:javascript',
      iconSize: 24,
      iconPadding: 8,
      iconColor: '#f7df1e',
      iconPosition: 'top-left',
      iconDisplayMode: 'badge',
      iconBadge: badge,
      icons,
    });

    const props = extractStyleFromShape(shape, { includeIconStyle: true });

    expect(props.iconId).toBe('builtin:javascript');
    expect(props.iconSize).toBe(24);
    expect(props.iconPadding).toBe(8);
    expect(props.iconColor).toBe('#f7df1e');
    expect(props.iconPosition).toBe('top-left');
    expect(props.iconDisplayMode).toBe('badge');
    expect(props.iconBadge).toEqual(badge);
    // Ensure iconBadge is a copy, not a reference (so later shape mutations
    // don't bleed into the saved profile).
    expect(props.iconBadge).not.toBe(badge);
    expect(props.icons).toHaveLength(1);
    expect(props.icons?.[0]).toEqual(icons[0]);
    expect(props.icons?.[0]).not.toBe(icons[0]);
  });

  it('omits all icon fields when includeIconStyle is false', () => {
    const shape = makeRectangle({
      iconId: 'builtin:javascript',
      iconSize: 24,
      iconDisplayMode: 'badge',
      iconBadge: { shape: 'circle', backgroundColor: '#fff' },
    });

    const props = extractStyleFromShape(shape, { includeIconStyle: false });

    expect(props.iconId).toBeUndefined();
    expect(props.iconSize).toBeUndefined();
    expect(props.iconDisplayMode).toBeUndefined();
    expect(props.iconBadge).toBeUndefined();
  });
});

describe('getProfileUpdates — icon coverage (JP-7)', () => {
  it('round-trips all 8 icon fields through extract + apply', () => {
    const badge: IconBadgeConfig = {
      shape: 'rounded-rect',
      backgroundColor: '#dbeafe',
      borderColor: '#2563eb',
      borderWidth: 2,
    };
    const icons: IconConfig[] = [
      { iconId: 'builtin:warning', position: 'bottom-right', size: 18 },
    ];

    const source = makeRectangle({
      iconId: 'builtin:typescript',
      iconSize: 32,
      iconPadding: 12,
      iconColor: '#3178c6',
      iconPosition: 'top-right',
      iconDisplayMode: 'inside',
      iconBadge: badge,
      icons,
    });

    const props = extractStyleFromShape(source, { includeIconStyle: true });
    const profile = makeProfile('roundtrip', props);
    const updates = getProfileUpdates(profile, source);

    expect(updates.iconId).toBe('builtin:typescript');
    expect(updates.iconSize).toBe(32);
    expect(updates.iconPadding).toBe(12);
    expect(updates.iconColor).toBe('#3178c6');
    expect(updates.iconPosition).toBe('top-right');
    expect(updates.iconDisplayMode).toBe('inside');
    expect(updates.iconBadge).toEqual(badge);
    expect(updates.icons).toEqual(icons);
  });

  it('leaves icon fields untouched when the profile has none (no-overwrite case)', () => {
    // Profile saved with includeIconStyle: false — no icon props.
    const profileProps = extractStyleFromShape(makeRectangle(), { includeIconStyle: false });
    const profile = makeProfile('no-icons', profileProps);
    const updates = getProfileUpdates(profile, makeRectangle());

    expect(updates.iconId).toBeUndefined();
    expect(updates.iconSize).toBeUndefined();
    expect(updates.iconPadding).toBeUndefined();
    expect(updates.iconColor).toBeUndefined();
    expect(updates.iconPosition).toBeUndefined();
    expect(updates.iconDisplayMode).toBeUndefined();
    expect(updates.iconBadge).toBeUndefined();
    expect(updates.icons).toBeUndefined();
  });

  it('drops icon fields when applying to a non-icon-supporting shape', () => {
    const props = extractStyleFromShape(
      makeRectangle({ iconId: 'builtin:javascript', iconDisplayMode: 'badge' }),
      { includeIconStyle: true },
    );
    const profile = makeProfile('cross-shape', props);

    // A line does not support icons, so the icon facet does not apply.
    const updates = getProfileUpdates(profile, makeLine());

    expect(updates.iconId).toBeUndefined();
    expect(updates.iconDisplayMode).toBeUndefined();
    expect(updates.iconBadge).toBeUndefined();
  });
});
