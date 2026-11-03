import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveAutoColor,
  resolveAutoColorRuns,
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

describe('resolveAutoColorRuns (DSK-215)', () => {
  const DARK = '#1e1e1e';
  const LIGHT_INK = '#ffffff';
  const DARK_INK = '#000000';
  const light = (overrides: Partial<RectangleShape> = {}) => baseRect({ fill: '#4a90d9', ...overrides });
  const circle = (overrides: Partial<EllipseShape> = {}): EllipseShape => ({
    id: 'e',
    type: 'ellipse',
    x: 0,
    y: 0,
    radiusX: 100,
    radiusY: 50,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    fill: '#ffffff',
    stroke: null,
    strokeWidth: 0,
    ...overrides,
  });
  /** A run's extent in world x along a horizontal segment from x = -500 to 500. */
  const xs = (t0: number, t1: number) => [Math.round(-500 + 1000 * t0), Math.round(-500 + 1000 * t1)];

  it('is one page run when nothing lies beneath', () => {
    expect(resolveAutoColorRuns({ x: -500, y: 0 }, { x: 500, y: 0 }, {}, [], DARK)).toEqual([
      { t0: 0, t1: 1, color: LIGHT_INK },
    ]);
  });

  it('stays light over the canvas when the midpoint falls on a light shape', () => {
    // The founder's line: its midpoint was the centre of a blue rectangle, so
    // the whole line was judged against the blue and drawn black.
    const runs = resolveAutoColorRuns({ x: -500, y: 0 }, { x: 500, y: 0 }, { r: light() }, ['r'], DARK);
    expect(runs.map((run) => run.color)).toEqual([LIGHT_INK, DARK_INK, LIGHT_INK]);
    expect(xs(runs[1]!.t0, runs[1]!.t1)).toEqual([-50, 50]);
  });

  it('follows an ellipse\'s outline, not its bounding box', () => {
    // At y = 35 the ellipse (100 by 50) spans x = ±71.4, off the 8-unit samples
    // and off the midpoints between them.
    const runs = resolveAutoColorRuns({ x: -500, y: 35 }, { x: 500, y: 35 }, { e: circle() }, ['e'], DARK);
    expect(runs.map((run) => run.color)).toEqual([LIGHT_INK, DARK_INK, LIGHT_INK]);
    expect(xs(runs[1]!.t0, runs[1]!.t1)).toEqual([-71, 71]);

    // Across the box's empty corner, missing the ellipse: the page throughout.
    const corner = resolveAutoColorRuns({ x: 70, y: -60 }, { x: 110, y: -40 }, { e: circle() }, ['e'], DARK);
    expect(corner).toEqual([{ t0: 0, t1: 1, color: LIGHT_INK }]);
  });

  it('finds a crossing that misses the box\'s entry, exit and middle', () => {
    // The line clips a circle's side off-centre within its bounding box: the
    // only stretch over the circle lies between those three points.
    const shapes = { e: circle({ radiusX: 100, radiusY: 100 }) };
    const runs = resolveAutoColorRuns({ x: 84, y: -111 }, { x: 109, y: 80 }, shapes, ['e'], DARK);
    expect(runs.map((run) => run.color)).toEqual([LIGHT_INK, DARK_INK, LIGHT_INK]);
    expect((runs[1]!.t1 - runs[1]!.t0) * Math.hypot(25, 191)).toBeCloseTo(42.6, 0);
  });

  it('takes the topmost shape where shapes overlap', () => {
    const shapes = {
      under: light({ id: 'under', x: 0, width: 400, fill: '#ffffff' }),
      over: light({ id: 'over', x: 0, width: 100, fill: '#000000' }),
    };
    const runs = resolveAutoColorRuns({ x: -500, y: 0 }, { x: 500, y: 0 }, shapes, ['under', 'over'], DARK);
    expect(runs.map((run) => run.color)).toEqual([LIGHT_INK, DARK_INK, LIGHT_INK, DARK_INK, LIGHT_INK]);
    expect(xs(runs[2]!.t0, runs[2]!.t1)).toEqual([-50, 50]);
  });

  it('ignores translucent shapes and the shape being resolved', () => {
    const faint = { r: light({ opacity: 0.3 }) };
    expect(resolveAutoColorRuns({ x: -500, y: 0 }, { x: 500, y: 0 }, faint, ['r'], DARK)).toHaveLength(1);
    const self = { r: light() };
    expect(resolveAutoColorRuns({ x: -500, y: 0 }, { x: 500, y: 0 }, self, ['r'], DARK, 'r')).toHaveLength(1);
  });

  it('folds runs shorter than minRun into their neighbour', () => {
    // The line starts 3 units inside a light shape's edge, as a connector
    // clipped to the shape it is hitched to can (JP-137).
    const shapes = { r: light({ x: -547 }) }; // spans x = -597 to -497
    const runs = resolveAutoColorRuns({ x: -500, y: 0 }, { x: 500, y: 0 }, shapes, ['r'], DARK, undefined, 12);
    expect(runs).toEqual([{ t0: 0, t1: 1, color: LIGHT_INK }]);
    // Without the fold, the sliver keeps its own colour.
    expect(resolveAutoColorRuns({ x: -500, y: 0 }, { x: 500, y: 0 }, shapes, ['r'], DARK)).toHaveLength(2);
  });

  it('is memoised per segment until the cache clears', () => {
    const cache = new ContrastCache();
    const shapes = { r: light() };
    const first = cache.resolveRuns({ x: -500, y: 0 }, { x: 500, y: 0 }, shapes, ['r'], DARK, 'c', 12);
    expect(cache.resolveRuns({ x: -500, y: 0 }, { x: 500, y: 0 }, shapes, ['r'], DARK, 'c', 12)).toBe(first);
    cache.clear();
    expect(cache.resolveRuns({ x: -500, y: 0 }, { x: 500, y: 0 }, {}, [], DARK, 'c', 12)).toEqual([
      { t0: 0, t1: 1, color: LIGHT_INK },
    ]);
  });

  it('keeps separate entries for different minimum runs', () => {
    const cache = new ContrastCache();
    const shapes = { r: light({ x: -547 }) }; // a 3-unit sliver at the start
    expect(cache.resolveRuns({ x: -500, y: 0 }, { x: 500, y: 0 }, shapes, ['r'], DARK, 'c', 12)).toHaveLength(1);
    expect(cache.resolveRuns({ x: -500, y: 0 }, { x: 500, y: 0 }, shapes, ['r'], DARK, 'c', 0)).toHaveLength(2);
  });
});
