/**
 * Pasting on the canvas. "Paste here" (the canvas menu, DSK-213) centres the
 * copied shapes on the point the menu opened at; a plain paste lands a little
 * offset. Either way lines and connectors move whole: before, a paste moved
 * only a line's start, so a far paste would have stretched it back.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Engine, hasCanvasClipboard, requestPasteAt } from './Engine';
import { useDocumentStore } from '../store/documentStore';
import { useSessionStore } from '../store/sessionStore';
import type { LineShape, RectangleShape, Shape } from '../shapes/Shape';
import { shapeRegistry } from '../shapes/ShapeRegistry';

/** A 2D context that takes any call and draws nothing: jsdom has none. */
function stubContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const target = () => undefined;
  const stub: unknown = new Proxy(target, {
    get: (_target, prop) => {
      if (prop === 'canvas') return canvas;
      if (prop === 'measureText') return () => ({ width: 0, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0 });
      if (prop === 'valueOf') return () => 0;
      if (prop === 'toString') return () => '';
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return stub;
    },
    set: () => true,
    apply: () => stub,
  });
  return stub as CanvasRenderingContext2D;
}

const box: RectangleShape = {
  id: 'box', type: 'rectangle', x: 0, y: 0, width: 100, height: 60, rotation: 0, opacity: 1,
  locked: false, visible: true, fill: '#ffffff', stroke: '#000000', strokeWidth: 1, cornerRadius: 0,
};
const line: LineShape = {
  id: 'line', type: 'line', x: 100, y: 0, x2: 300, y2: 0, rotation: 0, opacity: 1,
  locked: false, visible: true, fill: null, stroke: '#000000', strokeWidth: 2,
} as LineShape;

let engine: Engine;

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  useDocumentStore.setState({ shapes: { box, line }, shapeOrder: ['box', 'line'] });
  const canvas = document.createElement('canvas');
  vi.spyOn(canvas, 'getContext').mockReturnValue(stubContext(canvas) as unknown as RenderingContext);
  engine = new Engine(canvas);
  useSessionStore.getState().select(['box', 'line']);
  window.dispatchEvent(new CustomEvent('docushark:copy-shapes'));
});

afterEach(() => {
  engine.destroy();
  useDocumentStore.setState({ shapes: {}, shapeOrder: [] });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The shapes the paste added (it selects them). */
function pasted(): Shape[] {
  const { shapes } = useDocumentStore.getState();
  return useSessionStore.getState().getSelectedIds().map((id) => shapes[id]!);
}

describe('pasting on the canvas (DSK-213)', () => {
  it('Paste here centres the copied shapes on the point, keeping their layout', () => {
    expect(hasCanvasClipboard()).toBe(true);
    requestPasteAt({ x: 1000, y: 500 });
    const shapes = pasted();
    const [newBox, newLine] = shapes as [RectangleShape, LineShape];
    expect(newBox.id).not.toBe('box');

    // Their bounds, as drawn, are centred on the point.
    const bounds = shapes
      .map((shape) => shapeRegistry.getHandler(shape.type).getBounds(shape))
      .reduce((all, next) => all.union(next));
    expect((bounds.minX + bounds.maxX) / 2).toBeCloseTo(1000);
    expect((bounds.minY + bounds.maxY) / 2).toBeCloseTo(500);

    // Same layout as the copies, and the line moved whole.
    expect(newLine.x - newBox.x).toBe(100);
    expect([newLine.x2 - newLine.x, newLine.y2 - newLine.y]).toEqual([200, 0]);
  });

  it('a plain paste lands a little offset, lines whole', () => {
    window.dispatchEvent(new CustomEvent('docushark:paste-shapes'));
    const [newBox, newLine] = pasted() as [RectangleShape, LineShape];
    expect([newBox.x, newBox.y]).toEqual([20, 20]);
    expect([newLine.x, newLine.y, newLine.x2, newLine.y2]).toEqual([120, 20, 320, 20]);
  });
});
