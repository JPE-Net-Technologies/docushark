import { describe, it, expect } from 'vitest';
import { Box } from '../../math/Box';
import { shapeRegistry } from '../../shapes/ShapeRegistry';
import { createLibraryShapeHandler } from '../../shapes/library/LibraryShapeHandler';
import { activityActionShape } from '../../shapes/library/activityDiagramShapes';
import type { Shape } from '../../shapes/Shape';
import type { StyleProfile } from '../../store/styleProfileStore';
import {
  colorSlots,
  colorUpdate,
  placeSelectionBar,
  quickProfiles,
  slotColor,
  slotIsMixed,
} from './selectionBarModel';

function shape(type: string, extra: object = {}): Shape {
  return {
    id: 's',
    type,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    fill: '#111111',
    stroke: '#222222',
    strokeWidth: 1,
    ...extra,
  } as unknown as Shape;
}

describe('the colours a selection offers', () => {
  it('gives a rectangle fill, stroke and text', () => {
    expect(colorSlots([shape('rectangle')])).toEqual(['fill', 'stroke', 'text']);
  });

  it('gives an ellipse the same', () => {
    expect(colorSlots([shape('ellipse')])).toEqual(['fill', 'stroke', 'text']);
  });

  it('gives a library shape text only if it has a label', () => {
    const handler = createLibraryShapeHandler(activityActionShape);
    shapeRegistry.register('test-labelled', handler, activityActionShape.metadata);
    shapeRegistry.register('test-unlabelled', handler, { ...activityActionShape.metadata, supportsLabel: false });
    expect(colorSlots([shape('test-labelled')])).toEqual(['fill', 'stroke', 'text']);
    expect(colorSlots([shape('test-unlabelled')])).toEqual(['fill', 'stroke']);
  });

  it('gives text its one colour', () => {
    expect(colorSlots([shape('text')])).toEqual(['text']);
  });

  it('gives a line only its stroke', () => {
    expect(colorSlots([shape('line')])).toEqual(['stroke']);
  });

  it('gives a connector its stroke and label', () => {
    expect(colorSlots([shape('connector')])).toEqual(['stroke', 'text']);
  });

  it('gives a file only its label', () => {
    expect(colorSlots([shape('file')])).toEqual(['text']);
  });

  it('gives a group its background, border and label', () => {
    expect(colorSlots([shape('group')])).toEqual(['fill', 'stroke', 'text']);
  });

  it('offers only what every selected shape has', () => {
    expect(colorSlots([shape('rectangle'), shape('connector')])).toEqual(['stroke', 'text']);
    expect(colorSlots([shape('rectangle'), shape('line'), shape('text')])).toEqual([]);
  });

  it('offers nothing with nothing selected', () => {
    expect(colorSlots([])).toEqual([]);
  });
});

describe('the colour a slot shows', () => {
  it('reads a shape\'s fill and stroke', () => {
    expect(slotColor(shape('rectangle'), 'fill')).toBe('#111111');
    expect(slotColor(shape('rectangle'), 'stroke')).toBe('#222222');
  });

  it('shows no fill as empty', () => {
    expect(slotColor(shape('rectangle', { fill: null }), 'fill')).toBe('');
  });

  it('reads a text shape\'s letters from its fill', () => {
    expect(slotColor(shape('text'), 'text')).toBe('#111111');
  });

  it('shows a label its own colour, or the stroke it is drawn in, or black', () => {
    expect(slotColor(shape('rectangle', { labelColor: '#333333' }), 'text')).toBe('#333333');
    expect(slotColor(shape('rectangle'), 'text')).toBe('#222222');
    expect(slotColor(shape('rectangle', { stroke: null }), 'text')).toBe('#000000');
  });

  it('counts a group\'s background only while it draws one', () => {
    expect(slotColor(shape('group', { backgroundColor: '#444444' }), 'fill')).toBe('');
    expect(slotColor(shape('group', { backgroundColor: '#444444', showBackground: true }), 'fill')).toBe('#444444');
    expect(slotColor(shape('group', { showBackground: true }), 'fill')).toBe('#ffffff');
  });

  it('counts a group\'s border only while it draws one', () => {
    expect(slotColor(shape('group', { borderColor: '#555555' }), 'stroke')).toBe('');
    expect(slotColor(shape('group', { borderColor: '#555555', borderWidth: 2 }), 'stroke')).toBe('#555555');
    expect(slotColor(shape('group', { borderWidth: 2 }), 'stroke')).toBe('#000000');
  });

  it('is empty for a slot the shape does not have', () => {
    expect(slotColor(shape('line'), 'fill')).toBe('');
  });

  it('knows when the shapes differ', () => {
    const red = shape('rectangle', { fill: '#ff0000' });
    const blue = shape('rectangle', { fill: '#0000ff' });
    expect(slotIsMixed([red, blue], 'fill')).toBe(true);
    expect(slotIsMixed([red, red], 'fill')).toBe(false);
    expect(slotIsMixed([red, blue], 'stroke')).toBe(false);
  });
});

describe('setting a slot\'s colour', () => {
  it('writes the shape\'s own field', () => {
    expect(colorUpdate(shape('rectangle'), 'fill', '#000001')).toEqual({ fill: '#000001' });
    expect(colorUpdate(shape('rectangle'), 'stroke', '#000001')).toEqual({ stroke: '#000001' });
    expect(colorUpdate(shape('rectangle'), 'text', '#000001')).toEqual({ labelColor: '#000001' });
  });

  it('writes a text shape\'s letters to its fill', () => {
    expect(colorUpdate(shape('text'), 'text', '#000001')).toEqual({ fill: '#000001' });
  });

  it('makes a group draw the background you gave a colour', () => {
    expect(colorUpdate(shape('group'), 'fill', '#000001')).toEqual({ backgroundColor: '#000001', showBackground: true });
  });

  it('stops a group drawing a background you took the colour from', () => {
    expect(colorUpdate(shape('group', { showBackground: true }), 'fill', '')).toEqual({
      backgroundColor: '',
      showBackground: false,
    });
  });

  it('makes a group draw the border you gave a colour, keeping its width', () => {
    expect(colorUpdate(shape('group'), 'stroke', '#000001')).toEqual({ borderColor: '#000001', borderWidth: 1 });
    expect(colorUpdate(shape('group', { borderWidth: 3 }), 'stroke', '#000001')).toEqual({
      borderColor: '#000001',
      borderWidth: 3,
    });
  });

  it('writes nothing for a slot the shape does not have', () => {
    expect(colorUpdate(shape('line'), 'fill', '#000001')).toEqual({});
  });
});

describe('the profiles offered directly', () => {
  const profile = (id: string) => ({ id, name: id }) as StyleProfile;
  const offered = ['a', 'b', 'c', 'd'].map(profile);
  const ids = (list: StyleProfile[]) => list.map((item) => item.id);

  it('falls back on the usual order with nothing recent', () => {
    expect(ids(quickProfiles(offered, []))).toEqual(['a', 'b', 'c']);
  });

  it('leads with the last used', () => {
    expect(ids(quickProfiles(offered, ['d', 'b']))).toEqual(['d', 'b', 'a']);
  });

  it('offers each one once', () => {
    expect(ids(quickProfiles(offered, ['a', 'a', 'b']))).toEqual(['a', 'b', 'c']);
  });

  it('skips a recent one no longer on offer', () => {
    expect(ids(quickProfiles(offered, ['gone', 'c']))).toEqual(['c', 'a', 'b']);
  });

  it('copes with having few to offer', () => {
    expect(ids(quickProfiles([profile('a')], []))).toEqual(['a']);
    expect(quickProfiles([], ['a'])).toEqual([]);
  });
});

describe('where the bar goes', () => {
  const canvas = { width: 800, height: 600 };
  const bar = { width: 200, height: 40 };
  const camera = { x: 0, y: 0, zoom: 1 };
  const box = (minX: number, minY: number, maxX: number, maxY: number) => new Box(minX, minY, maxX, maxY);

  it('stands centred above the selection, clear of the rotation handle', () => {
    // The canvas centre is world (0, 0), so the box's top edge is at y = 250.
    expect(placeSelectionBar(box(-50, -50, 50, 50), camera, canvas, bar)).toEqual({ left: 300, top: 176 });
  });

  it('follows the camera', () => {
    const moved = { x: 100, y: 50, zoom: 1 };
    expect(placeSelectionBar(box(-50, -50, 50, 50), moved, canvas, bar)).toEqual({ left: 200, top: 126 });
  });

  it('follows the zoom', () => {
    const zoomed = { x: 0, y: 0, zoom: 2 };
    // Twice the size around the same centre: the top edge rises to y = 200.
    expect(placeSelectionBar(box(-50, -50, 50, 50), zoomed, canvas, bar)).toEqual({ left: 300, top: 126 });
    // Off the centre, the zoom moves it across as well: its middle is 100 world units
    // right of the canvas's, so 200 pixels.
    expect(placeSelectionBar(box(50, -50, 150, 50), zoomed, canvas, bar)?.left).toBe(500);
  });

  it('goes below near the top of the canvas', () => {
    // Top edge at y = 20, so there's no room above; the bottom edge is at y = 120.
    expect(placeSelectionBar(box(-50, -280, 50, -180), camera, canvas, bar)).toEqual({ left: 300, top: 132 });
  });

  it('stays above when it only just fits', () => {
    // Top edge at y = 82 leaves exactly the margin above the bar.
    expect(placeSelectionBar(box(-50, -218, 50, -118), camera, canvas, bar)?.top).toBe(8);
  });

  it('goes to the top when a selection leaves room for neither', () => {
    expect(placeSelectionBar(box(-50, -295, 50, 295), camera, canvas, bar)).toEqual({ left: 300, top: 8 });
  });

  it('stays on the canvas at the sides', () => {
    expect(placeSelectionBar(box(-400, -50, -380, 50), camera, canvas, bar)?.left).toBe(8);
    expect(placeSelectionBar(box(380, -50, 400, 50), camera, canvas, bar)?.left).toBe(592);
  });

  it('keeps out from under an open panel on either side', () => {
    const shape_ = box(380, -50, 400, 50);
    expect(placeSelectionBar(shape_, camera, canvas, bar, { left: 0, right: 240 })?.left).toBe(352);
    const onLeft = box(-400, -50, -380, 50);
    expect(placeSelectionBar(onLeft, camera, canvas, bar, { left: 240, right: 0 })?.left).toBe(248);
  });

  it('has nowhere to stand for a selection off the canvas', () => {
    expect(placeSelectionBar(box(500, -50, 600, 50), camera, canvas, bar)).toBeNull();
    expect(placeSelectionBar(box(-600, -50, -500, 50), camera, canvas, bar)).toBeNull();
    expect(placeSelectionBar(box(-50, 400, 50, 500), camera, canvas, bar)).toBeNull();
    expect(placeSelectionBar(box(-50, -500, 50, -400), camera, canvas, bar)).toBeNull();
  });
});
