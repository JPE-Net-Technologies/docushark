import { describe, it, expect } from 'vitest';
import { excalidrawAdapter } from './excalidrawAdapter';
import type { Shape } from '../../Shape';

const scene = {
  type: 'excalidraw',
  version: 2,
  elements: [
    { id: 'r1', type: 'rectangle', x: 10, y: 20, width: 100, height: 40, strokeColor: '#1e1e1e', backgroundColor: '#a5d8ff', strokeWidth: 2, roundness: { type: 3 } },
    { id: 'e1', type: 'ellipse', x: 200, y: 0, width: 80, height: 60, strokeColor: '#e03131' },
    { id: 't1', type: 'text', x: 12, y: 22, width: 50, height: 20, text: 'Box A', containerId: 'r1', fontSize: 16 },
    { id: 'a1', type: 'arrow', x: 110, y: 40, width: 90, height: 0, points: [[0, 0], [90, 0]], startBinding: { elementId: 'r1' }, endBinding: { elementId: 'e1' } },
    { id: 'd1', type: 'diamond', x: 300, y: 300, width: 60, height: 60 },
    { id: 'fd1', type: 'freedraw', x: 0, y: 0, width: 10, height: 10, points: [[0, 0], [5, 5]] },
  ],
};

const find = (shapes: Shape[], type: string) => shapes.find((s) => s.type === type);

describe('excalidrawAdapter', () => {
  it('canImport recognizes excalidraw JSON only', () => {
    expect(excalidrawAdapter.canImport(JSON.stringify(scene))).toBe(true);
    expect(excalidrawAdapter.canImport('{"type":"drawio"}')).toBe(false);
    expect(excalidrawAdapter.canImport('not json')).toBe(false);
  });

  it('maps elements to shapes, recentring box coordinates', async () => {
    const { shapes } = await excalidrawAdapter.import(JSON.stringify(scene));

    const rect = find(shapes, 'rectangle')!;
    // top-left (10,20) + half-size (50,20) → centre (60,40)
    expect(rect.x).toBe(60);
    expect(rect.y).toBe(40);
    expect((rect as { cornerRadius: number }).cornerRadius).toBeGreaterThan(0); // roundness → rounded

    const ell = find(shapes, 'ellipse') as { radiusX: number; radiusY: number; stroke: string | null };
    expect(ell.radiusX).toBe(40);
    expect(ell.radiusY).toBe(30);
    expect(ell.stroke).toBe('#e03131'); // explicit colour passes through

    // Excalidraw's default stroke maps to the theme-adaptive AUTO sentinel;
    // explicit fill colour passes through literally.
    expect((rect as { stroke: string | null }).stroke).toBe('auto');
    expect((rect as { fill: string | null }).fill).toBe('#a5d8ff');

    expect(find(shapes, 'diamond')).toBeTruthy(); // library shape
  });

  it('applies container-bound text as the container label (not a text shape)', async () => {
    const { shapes } = await excalidrawAdapter.import(JSON.stringify(scene));
    const rect = find(shapes, 'rectangle') as { label?: string };
    expect(rect.label).toBe('Box A');
    expect(find(shapes, 'text')).toBeUndefined(); // bound text did not become a standalone text shape
  });

  it('wires bound arrows to connector endpoints via id remap', async () => {
    const { shapes } = await excalidrawAdapter.import(JSON.stringify(scene));
    const rect = find(shapes, 'rectangle')!;
    const ell = find(shapes, 'ellipse')!;
    const conn = find(shapes, 'connector') as { startShapeId?: string; endShapeId?: string };
    expect(conn.startShapeId).toBe(rect.id);
    expect(conn.endShapeId).toBe(ell.id);
  });

  it('hitches bound arrows to edge anchors, not the shape centre (JP-196)', async () => {
    const { shapes } = await excalidrawAdapter.import(JSON.stringify(scene));
    const conn = find(shapes, 'connector') as { startAnchor?: string; endAnchor?: string };
    // r1 centre (60,40), arrow runs right toward e1 → leaves r1 on the right;
    // e1 centre (240,30), arrow arrives from the left → enters e1 on the left.
    expect(conn.startAnchor).toBe('right');
    expect(conn.endAnchor).toBe('left');
    expect(conn.startAnchor).not.toBe('center');
    expect(conn.endAnchor).not.toBe('center');
  });

  it('skips freedraw and reports it', async () => {
    const { shapes, warnings } = await excalidrawAdapter.import(JSON.stringify(scene));
    expect(find(shapes, 'freedraw')).toBeUndefined();
    expect(warnings?.some((w) => w.kind === 'freedraw')).toBe(true);
  });
});
