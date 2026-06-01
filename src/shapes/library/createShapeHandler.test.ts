import { describe, it, expect } from 'vitest';
import { Vec2 } from '../../math/Vec2';
import { Box } from '../../math/Box';
import { createShapeHandler } from './LibraryShapeHandler';
import { type ShapeDefinition, createStandardAnchors } from './ShapeLibraryTypes';
import type { LibraryShape } from '../Shape';

const baseShape: LibraryShape = {
  id: 's',
  type: 'test',
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  rotation: 0,
  opacity: 1,
  locked: false,
  visible: true,
  fill: '#ffffff',
  stroke: '#000000',
  strokeWidth: 2,
};

const baseDef: ShapeDefinition<LibraryShape> = {
  type: 'test',
  metadata: {
    type: 'test', name: 'Test', category: 'flowchart', icon: '',
    properties: [], supportsLabel: true, supportsIcon: false,
    defaultWidth: 10, defaultHeight: 10,
  },
  pathBuilder: () => new Path2D(),
  anchors: createStandardAnchors(),
};

describe('createShapeHandler generalization hooks (JP-160)', () => {
  it('routes box geometry through getSize (overriding width/height fields)', () => {
    const handler = createShapeHandler({ ...baseDef, getSize: () => ({ width: 100, height: 60 }) });
    const bounds = handler.getBounds(baseShape); // shape.width=10, but getSize wins
    expect(bounds.width).toBeCloseTo(100 + baseShape.strokeWidth); // + strokeWidth/2 each side
    expect(bounds.height).toBeCloseTo(60 + baseShape.strokeWidth);
  });

  it('customHitTest fully replaces the default hit test', () => {
    const handler = createShapeHandler({ ...baseDef, customHitTest: () => true });
    expect(handler.hitTest(baseShape, new Vec2(9999, 9999))).toBe(true);
  });

  it('customBounds fully replaces the default bounds', () => {
    const box = new Box(1, 2, 3, 4);
    const handler = createShapeHandler({ ...baseDef, customBounds: () => box });
    expect(handler.getBounds(baseShape)).toBe(box);
  });

  it('handles fully replaces the standard handle set', () => {
    const handler = createShapeHandler({
      ...baseDef,
      handles: () => [{ type: 'rotation', x: 5, y: 6, cursor: 'grab' }],
    });
    const handles = handler.getHandles(baseShape);
    expect(handles).toHaveLength(1);
    expect(handles[0]).toMatchObject({ x: 5, y: 6 });
  });

  it('create returns the definition-provided shape', () => {
    const custom: LibraryShape = { ...baseShape, id: 'made', x: 7, y: 8 };
    const handler = createShapeHandler({ ...baseDef, create: () => custom });
    expect(handler.create(new Vec2(0, 0), 'ignored')).toBe(custom);
  });

  it('defaults to box behavior when no hooks are supplied', () => {
    const handler = createShapeHandler(baseDef);
    const bounds = handler.getBounds(baseShape);
    expect(bounds.width).toBeCloseTo(10 + baseShape.strokeWidth);
    expect(handler.getHandles(baseShape)).toHaveLength(9); // 8 resize + rotation
  });
});
