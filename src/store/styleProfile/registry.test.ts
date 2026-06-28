/**
 * Coverage for the per-shape style-profile adapter layer (JP-33).
 *
 * Validates that:
 *  - the registry dispatches the right facets per shape type;
 *  - capability resolution falls back to the static table when the shape
 *    registry is empty (the case in this test environment, and the case for
 *    core shapes at runtime since they register no metadata);
 *  - capability resolution honors shape metadata when present;
 *  - the ERD facet folds its values into a *merged* customProperties object;
 *  - metadata-truth coverage gains label styling for groups.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { resolveStyleAdapter, shapeSupportsLabel, shapeSupportsIcon } from './index';
import {
  extractStyleFromShape,
  getProfileUpdates,
  type StyleProfile,
  type StyleProfileProperties,
} from '../styleProfileStore';
import type { BaseShape } from '../../shapes/Shape';
import type { ShapeHandler } from '../../shapes/ShapeRegistry';
import { shapeRegistry } from '../../shapes/ShapeRegistry';
import type { ShapeMetadata } from '../../shapes/ShapeMetadata';

/** Loosely-typed shape factory — the adapter reads fields dynamically. */
function makeShape(type: string, extra: Record<string, unknown> = {}): BaseShape {
  return {
    id: `${type}-1`,
    type,
    x: 0,
    y: 0,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    fill: '#ffffff',
    stroke: '#000000',
    strokeWidth: 2,
    ...extra,
  } as unknown as BaseShape;
}

function makeProfile(properties: StyleProfileProperties): StyleProfile {
  return { id: 'p', name: 'p', properties, createdAt: 0, favorite: false };
}

const BASE_PROPS: StyleProfileProperties = {
  fill: '#abcdef',
  stroke: '#123456',
  strokeWidth: 3,
  opacity: 0.5,
};

const facetIds = (type: string): string[] => resolveStyleAdapter(type).map((f) => f.id);

describe('resolveStyleAdapter — dispatch', () => {
  it('gives a rectangle universal + cornerRadius + label + icon', () => {
    const ids = facetIds('rectangle');
    expect(ids).toEqual(expect.arrayContaining(['universal', 'cornerRadius', 'label', 'icon']));
  });

  it('gives a line universal + arrows, but not icon/label/cornerRadius', () => {
    const ids = facetIds('line');
    expect(ids).toEqual(expect.arrayContaining(['universal', 'arrows']));
    expect(ids).not.toContain('icon');
    expect(ids).not.toContain('label');
    expect(ids).not.toContain('cornerRadius');
  });

  it('gives a text shape the text facet but no icon', () => {
    const ids = facetIds('text');
    expect(ids).toContain('text');
    expect(ids).not.toContain('icon');
  });

  it('gives a group the group + label + cornerRadius facets but no icon', () => {
    const ids = facetIds('group');
    expect(ids).toEqual(expect.arrayContaining(['universal', 'group', 'label', 'cornerRadius']));
    expect(ids).not.toContain('icon');
  });

  it('gives a connector arrows + lineStyle + label', () => {
    const ids = facetIds('connector');
    expect(ids).toEqual(expect.arrayContaining(['arrows', 'lineStyle', 'label']));
  });

  it('gives an unknown type only the universal facet', () => {
    expect(facetIds('totally-unknown-shape')).toEqual(['universal']);
  });
});

describe('empty-registry static fallback', () => {
  it('resolves core-shape capabilities without registered metadata', () => {
    // No shapes are registered in the test environment — these come from the
    // static fallback table, which is load-bearing for the JP-7 icon tests.
    expect(shapeSupportsLabel('rectangle')).toBe(true);
    expect(shapeSupportsIcon('rectangle')).toBe(true);
    expect(shapeSupportsLabel('line')).toBe(false);
    expect(shapeSupportsIcon('line')).toBe(false);
    expect(shapeSupportsLabel('group')).toBe(true);
    expect(shapeSupportsIcon('group')).toBe(false);
  });
});

describe('getProfileUpdates — translation', () => {
  it('applies universal fields to every shape, including markerless ones', () => {
    const updates = getProfileUpdates(makeProfile(BASE_PROPS), makeShape('line'));
    expect(updates.fill).toBe('#abcdef');
    expect(updates.stroke).toBe('#123456');
    expect(updates.strokeWidth).toBe(3);
    expect(updates.opacity).toBe(0.5);
  });

  it('grants label styling to groups (metadata-truth coverage gain)', () => {
    const profile = makeProfile({ ...BASE_PROPS, labelFontSize: 18, labelColor: '#654321' });
    const updates = getProfileUpdates(profile, makeShape('group'));
    expect(updates.labelFontSize).toBe(18);
    expect(updates.labelColor).toBe('#654321');
  });

  it('does not write label fields onto shapes that do not support them', () => {
    const profile = makeProfile({ ...BASE_PROPS, labelFontSize: 18, labelColor: '#654321' });
    const updates = getProfileUpdates(profile, makeShape('line'));
    expect(updates.labelFontSize).toBeUndefined();
    expect(updates.labelColor).toBeUndefined();
  });

  it('merges ERD row styling into existing customProperties without clobbering', () => {
    const profile = makeProfile({
      ...BASE_PROPS,
      rowSeparatorColor: '#ff0000',
      attributePaddingHorizontal: 12,
    });
    const shape = makeShape('erd-entity', { customProperties: { foo: 1, rowSeparatorColor: '#000' } });

    const updates = getProfileUpdates(profile, shape);

    expect(updates.customProperties).toEqual({
      foo: 1,
      rowSeparatorColor: '#ff0000',
      attributePaddingHorizontal: 12,
    });
    // Raw ERD keys must never leak onto the top-level update.
    expect((updates as Record<string, unknown>)['rowSeparatorColor']).toBeUndefined();
  });

  it('leaves customProperties untouched when the profile has no ERD styling', () => {
    const updates = getProfileUpdates(makeProfile(BASE_PROPS), makeShape('erd-entity', { customProperties: { foo: 1 } }));
    expect(updates.customProperties).toBeUndefined();
  });
});

describe('extractStyleFromShape — adapter dispatch', () => {
  it('always captures the four universal fields', () => {
    const props = extractStyleFromShape(makeShape('totally-unknown-shape', { fill: '#aaa', stroke: '#bbb', strokeWidth: 4, opacity: 0.3 }));
    expect(props).toMatchObject({ fill: '#aaa', stroke: '#bbb', strokeWidth: 4, opacity: 0.3 });
  });

  it('captures ERD row styling from customProperties on entity shapes', () => {
    const shape = makeShape('erd-entity', { customProperties: { rowAlternateColor: '#eee', attributePaddingVertical: 6 } });
    const props = extractStyleFromShape(shape);
    expect(props.rowAlternateColor).toBe('#eee');
    expect(props.attributePaddingVertical).toBe(6);
  });
});

describe('swimlane facet (JP-399)', () => {
  it('dispatches the swimlane facet for activity-swimlane only', () => {
    expect(facetIds('activity-swimlane')).toContain('swimlane');
    expect(facetIds('rectangle')).not.toContain('swimlane');
  });

  it('extracts header/separator chrome from customProperties', () => {
    const shape = makeShape('activity-swimlane', {
      customProperties: { headerBackground: '#222', separatorColor: '#0ff', separatorWidth: 2, orientation: 'horizontal' },
    });
    const props = extractStyleFromShape(shape);
    expect(props.headerBackground).toBe('#222');
    expect(props.separatorColor).toBe('#0ff');
    expect(props.separatorWidth).toBe(2);
  });

  it('merges chrome into existing customProperties without clobbering non-style data', () => {
    const profile = makeProfile({ ...BASE_PROPS, headerBackground: '#222', separatorWidth: 3 });
    const shape = makeShape('activity-swimlane', {
      customProperties: { orientation: 'vertical', separatorColor: '#000' },
    });

    const updates = getProfileUpdates(profile, shape);

    expect(updates.customProperties).toEqual({
      orientation: 'vertical',
      separatorColor: '#000',
      headerBackground: '#222',
      separatorWidth: 3,
    });
    expect((updates as Record<string, unknown>)['headerBackground']).toBeUndefined();
  });

  it('does not leak swimlane keys onto a non-swimlane shape', () => {
    const profile = makeProfile({ ...BASE_PROPS, headerBackground: '#222', separatorColor: '#0ff' });
    const updates = getProfileUpdates(profile, makeShape('rectangle'));
    expect((updates as Record<string, unknown>)['headerBackground']).toBeUndefined();
    expect(updates.customProperties).toBeUndefined();
  });
});

describe('metadata-driven capability resolution', () => {
  afterEach(() => {
    // The registry is a shared singleton; the test env starts empty, so a full
    // clear is the safe teardown (unregister alone leaves metadata behind).
    shapeRegistry.clear();
  });

  function registerDummy(supportsLabel: boolean, supportsIcon: boolean): void {
    const metadata: ShapeMetadata = {
      type: 'dummy-style-shape',
      name: 'Dummy',
      category: 'custom',
      icon: '?',
      properties: [],
      supportsLabel,
      supportsIcon,
      defaultWidth: 100,
      defaultHeight: 100,
    };
    const stubHandler = {
      render: () => {},
      hitTest: () => false,
      getBounds: () => ({ x: 0, y: 0, width: 0, height: 0 }),
      getHandles: () => [],
      create: (_pos: unknown, id: string) => makeShape('dummy-style-shape', { id }),
    } as unknown as ShapeHandler;
    shapeRegistry.register('dummy-style-shape', stubHandler, metadata);
  }

  it('honors supportsLabel:true / supportsIcon:false from metadata', () => {
    registerDummy(true, false);
    expect(shapeSupportsLabel('dummy-style-shape')).toBe(true);
    expect(shapeSupportsIcon('dummy-style-shape')).toBe(false);
    const ids = facetIds('dummy-style-shape');
    expect(ids).toContain('label');
    expect(ids).not.toContain('icon');
  });

  it('honors supportsIcon:true from metadata', () => {
    registerDummy(false, true);
    expect(shapeSupportsLabel('dummy-style-shape')).toBe(false);
    expect(shapeSupportsIcon('dummy-style-shape')).toBe(true);
    const ids = facetIds('dummy-style-shape');
    expect(ids).toContain('icon');
    expect(ids).not.toContain('label');
  });
});
