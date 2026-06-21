import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveAutoColor,
  ContrastCache,
  AUTO_COLOR,
  isAutoColor,
  normalizeAutoColorsForExport,
} from './ContrastResolver';
import type {
  RectangleShape,
  GroupShape,
  Shape,
  EllipseShape,
} from '../shapes/Shape';

// Importing these modules triggers shape handler registration.
import '../shapes/Rectangle';
import '../shapes/Ellipse';
import '../shapes/Group';

const baseRect = (overrides: Partial<RectangleShape> = {}): RectangleShape => ({
  id: 'r',
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  rotation: 0,
  opacity: 1,
  locked: false,
  visible: true,
  fill: '#ffffff',
  stroke: null,
  strokeWidth: 0,
  cornerRadius: 0,
  ...overrides,
});

const baseGroup = (overrides: Partial<GroupShape> = {}): GroupShape => ({
  id: 'g',
  type: 'group',
  x: 0,
  y: 0,
  rotation: 0,
  opacity: 1,
  locked: false,
  visible: true,
  fill: null,
  stroke: null,
  strokeWidth: 0,
  childIds: [],
  ...overrides,
});

describe('isAutoColor', () => {
  it('matches the AUTO_COLOR sentinel', () => {
    expect(isAutoColor(AUTO_COLOR)).toBe(true);
    expect(isAutoColor('auto')).toBe(true);
  });
  it('rejects everything else', () => {
    expect(isAutoColor(null)).toBe(false);
    expect(isAutoColor(undefined)).toBe(false);
    expect(isAutoColor('')).toBe(false);
    expect(isAutoColor('#000000')).toBe(false);
    expect(isAutoColor('AUTO')).toBe(false);
  });
});

describe('resolveAutoColor', () => {
  let shapes: Record<string, Shape>;
  let order: string[];

  beforeEach(() => {
    shapes = {};
    order = [];
  });

  it('falls back to page background when no shape covers the point', () => {
    expect(resolveAutoColor({ x: 50, y: 50 }, shapes, order, '#ffffff')).toBe('#000000');
    expect(resolveAutoColor({ x: 50, y: 50 }, shapes, order, '#202020')).toBe('#ffffff');
  });

  it('picks contrast against topmost opaque shape under point', () => {
    // Rectangle handler treats x/y as center; centre (0,0) → bounds (-50..50, -50..50).
    shapes['dark'] = baseRect({ id: 'dark', fill: '#000000' });
    order = ['dark'];
    expect(resolveAutoColor({ x: 0, y: 0 }, shapes, order, '#ffffff')).toBe('#ffffff');

    shapes['light'] = baseRect({ id: 'light', fill: '#ffffff' });
    order = ['dark', 'light']; // light on top
    expect(resolveAutoColor({ x: 0, y: 0 }, shapes, order, '#202020')).toBe('#000000');
  });

  it('walks z-order top-down (last id is topmost)', () => {
    shapes['a'] = baseRect({ id: 'a', fill: '#ffffff' });
    shapes['b'] = baseRect({ id: 'b', fill: '#000000' });
    order = ['a', 'b'];
    expect(resolveAutoColor({ x: 0, y: 0 }, shapes, order, '#ffffff')).toBe('#ffffff');
  });

  it('skips shapes with AUTO fill (they cannot be a background)', () => {
    shapes['auto'] = baseRect({ id: 'auto', fill: AUTO_COLOR });
    shapes['concrete'] = baseRect({ id: 'concrete', fill: '#000000' });
    order = ['concrete', 'auto'];
    expect(resolveAutoColor({ x: 0, y: 0 }, shapes, order, '#ffffff')).toBe('#ffffff');
  });

  it('skips shapes with null fill', () => {
    shapes['transparent'] = baseRect({ id: 'transparent', fill: null });
    shapes['black'] = baseRect({ id: 'black', fill: '#000000' });
    order = ['black', 'transparent'];
    expect(resolveAutoColor({ x: 0, y: 0 }, shapes, order, '#ffffff')).toBe('#ffffff');
  });

  it('skips shapes below the opaque threshold', () => {
    shapes['ghost'] = baseRect({ id: 'ghost', fill: '#000000', opacity: 0.2 });
    shapes['solid'] = baseRect({ id: 'solid', fill: '#ffffff' });
    order = ['solid', 'ghost'];
    expect(resolveAutoColor({ x: 0, y: 0 }, shapes, order, '#202020')).toBe('#000000');
  });

  it('skips invisible shapes', () => {
    shapes['hidden'] = baseRect({ id: 'hidden', fill: '#000000', visible: false });
    order = ['hidden'];
    expect(resolveAutoColor({ x: 0, y: 0 }, shapes, order, '#ffffff')).toBe('#000000');
  });

  it('ignores a point in a non-rectangular shape\'s bounding-box corner (JP-304)', () => {
    // A radius-50 circle with a light fill. (40,40) is inside its bounding box
    // but outside the circle (~56.6 from centre), i.e. actually over the page.
    shapes['circle'] = {
      id: 'circle',
      type: 'ellipse',
      x: 0,
      y: 0,
      radiusX: 50,
      radiusY: 50,
      rotation: 0,
      opacity: 1,
      locked: false,
      visible: true,
      fill: '#ffffff',
      stroke: '#ffffff',
      strokeWidth: 0,
    } as EllipseShape;
    order = ['circle'];
    // Corner point falls through to the dark page → white (was black via AABB).
    expect(resolveAutoColor({ x: 40, y: 40 }, shapes, order, '#101020')).toBe('#ffffff');
    // A point genuinely over the circle still contrasts its light fill → black.
    expect(resolveAutoColor({ x: 0, y: 0 }, shapes, order, '#101020')).toBe('#000000');
  });

  it('skips the excluded shape itself', () => {
    shapes['self'] = baseRect({ id: 'self', fill: '#000000' });
    order = ['self'];
    expect(resolveAutoColor({ x: 0, y: 0 }, shapes, order, '#ffffff', 'self')).toBe('#000000');
  });

  it('uses group backgroundColor only when showBackground is true', () => {
    // Group bounds come from children, so we anchor each group via a transparent child rect.
    shapes['child1'] = baseRect({ id: 'child1', fill: null });
    shapes['g1'] = baseGroup({
      id: 'g1',
      childIds: ['child1'],
      backgroundColor: '#000000',
      showBackground: false,
    });
    order = ['child1', 'g1'];
    // Group provides no background and child has no fill: falls back to page.
    expect(resolveAutoColor({ x: 0, y: 0 }, shapes, order, '#ffffff')).toBe('#000000');

    shapes['child2'] = baseRect({ id: 'child2', fill: null });
    shapes['g2'] = baseGroup({
      id: 'g2',
      childIds: ['child2'],
      backgroundColor: '#000000',
      showBackground: true,
    });
    // Reset order: only g2 matters here.
    expect(
      resolveAutoColor(
        { x: 0, y: 0 },
        { child2: shapes['child2']!, g2: shapes['g2']! },
        ['child2', 'g2'],
        '#ffffff'
      )
    ).toBe('#ffffff');
  });

  it('only matches shapes whose bounds contain the point', () => {
    shapes['rect'] = baseRect({ id: 'rect', fill: '#000000' });
    order = ['rect'];
    // Far outside the 100x100 rectangle centred at origin.
    expect(resolveAutoColor({ x: 9999, y: 9999 }, shapes, order, '#ffffff')).toBe('#000000');
  });

  it('handles ellipse shapes via the registered handler', () => {
    const ellipse: EllipseShape = {
      id: 'e',
      type: 'ellipse',
      x: 0,
      y: 0,
      radiusX: 60,
      radiusY: 60,
      rotation: 0,
      opacity: 1,
      locked: false,
      visible: true,
      fill: '#000000',
      stroke: null,
      strokeWidth: 0,
    };
    shapes['e'] = ellipse;
    order = ['e'];
    expect(resolveAutoColor({ x: 0, y: 0 }, shapes, order, '#ffffff')).toBe('#ffffff');
  });
});

describe('normalizeAutoColorsForExport', () => {
  it('replaces AUTO fill/stroke with black', () => {
    const shapes: Record<string, Shape> = {
      a: baseRect({ id: 'a', fill: AUTO_COLOR, stroke: AUTO_COLOR }),
      b: baseRect({ id: 'b', fill: '#ff0000', stroke: null }),
    };
    const out = normalizeAutoColorsForExport(shapes);
    expect(out['a']!.fill).toBe('#000000');
    expect(out['a']!.stroke).toBe('#000000');
    // Non-auto shapes returned by reference (no clone).
    expect(out['b']).toBe(shapes['b']);
  });

  it('replaces AUTO group bg/border/label with black', () => {
    const shapes: Record<string, Shape> = {
      g: baseGroup({
        id: 'g',
        backgroundColor: AUTO_COLOR,
        borderColor: AUTO_COLOR,
        labelColor: AUTO_COLOR,
      }),
    };
    const out = normalizeAutoColorsForExport(shapes);
    const g = out['g'] as GroupShape;
    expect(g.backgroundColor).toBe('#000000');
    expect(g.borderColor).toBe('#000000');
    expect(g.labelColor).toBe('#000000');
  });

  it('replaces AUTO labelColor on non-group shapes', () => {
    const shapes: Record<string, Shape> = {
      r: baseRect({ id: 'r', fill: null, labelColor: AUTO_COLOR, label: 'hi' }),
    };
    const out = normalizeAutoColorsForExport(shapes);
    expect((out['r'] as RectangleShape).labelColor).toBe('#000000');
  });

  it('does not mutate the input shapes', () => {
    const original = baseRect({ id: 'a', fill: AUTO_COLOR });
    const shapes = { a: original };
    normalizeAutoColorsForExport(shapes);
    expect(original.fill).toBe(AUTO_COLOR);
  });
});

describe('ContrastCache', () => {
  it('returns cached resolution for repeated quantized points', () => {
    const cache = new ContrastCache();
    const shapes: Record<string, Shape> = {
      a: baseRect({ id: 'a', fill: '#000000' }),
    };
    const order = ['a'];
    const first = cache.resolve({ x: 0.1, y: 0.2 }, shapes, order, '#ffffff');
    const second = cache.resolve({ x: 0.4, y: -0.1 }, shapes, order, '#ffffff');
    // Both round to (0,0) so should be the same cached entry.
    expect(first).toBe('#ffffff');
    expect(second).toBe('#ffffff');
  });

  it('clears between frames', () => {
    const cache = new ContrastCache();
    const shapes: Record<string, Shape> = { a: baseRect({ id: 'a', fill: '#000000' }) };
    cache.resolve({ x: 0, y: 0 }, shapes, ['a'], '#ffffff');
    cache.clear();
    // Empty shapes — no cached fill, falls back to page.
    expect(cache.resolve({ x: 0, y: 0 }, {}, [], '#ffffff')).toBe('#000000');
  });
});
