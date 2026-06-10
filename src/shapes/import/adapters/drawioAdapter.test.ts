import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { drawioAdapter } from './drawioAdapter';
import type { Shape } from '../../Shape';

// jsdom makes import.meta.url an http: URL, so resolve from the project cwd
// (vitest runs at the repo root) rather than a file: URL.
const SMALL_FLOWCHART = readFileSync(
  resolve(process.cwd(), 'src/shapes/import/adapters/__fixtures__/small-flowchart.drawio'),
  'utf8'
);

const byType = (shapes: Shape[], type: string) => shapes.filter((s) => s.type === type);

describe('drawioAdapter', () => {
  it('canImport recognizes drawio/mxGraph XML only', () => {
    expect(drawioAdapter.canImport(SMALL_FLOWCHART)).toBe(true);
    expect(drawioAdapter.canImport('<mxGraphModel><root></root></mxGraphModel>')).toBe(true);
    expect(drawioAdapter.canImport('{"type":"excalidraw"}')).toBe(false);
    expect(drawioAdapter.canImport('not xml')).toBe(false);
  });

  it('maps the small flowchart to primitives + connectors', async () => {
    const { shapes } = await drawioAdapter.import(SMALL_FLOWCHART);
    // 9 vertices: 6 rectangles (Process 1-6) + 2 diamonds (Decision 1-2) +
    // 1 ellipse (Initial State); 8 bound edges.
    expect(byType(shapes, 'rectangle')).toHaveLength(6);
    expect(byType(shapes, 'diamond')).toHaveLength(2);
    expect(byType(shapes, 'ellipse')).toHaveLength(1);
    expect(byType(shapes, 'connector')).toHaveLength(8);
  });

  it('recentres top-left geometry and carries fill/label', async () => {
    const { shapes } = await drawioAdapter.import(SMALL_FLOWCHART);
    // Process 1: x=380 y=340 w=120 h=60 → centre (440, 370), fill #b1ddf0.
    const p1 = shapes.find((s) => (s as { label?: string }).label === 'Process 1')!;
    expect(p1.x).toBe(440);
    expect(p1.y).toBe(370);
    expect((p1 as { fill: string | null }).fill).toBe('#b1ddf0');
  });

  it('strips HTML from labels', async () => {
    const { shapes } = await drawioAdapter.import(SMALL_FLOWCHART);
    // "Decis<span ...>ion 2</span>" → "Decision 2".
    const labels = shapes.map((s) => (s as { label?: string }).label);
    expect(labels).toContain('Decision 2');
  });

  it('hitches bound edges to edge anchors, not the shape centre (JP-196 reuse)', async () => {
    const { shapes } = await drawioAdapter.import(SMALL_FLOWCHART);
    const connectors = byType(shapes, 'connector') as Array<{
      startShapeId?: string;
      endShapeId?: string;
      startAnchor?: string;
      endAnchor?: string;
    }>;
    // Every connector in the sample is bound at both ends.
    for (const c of connectors) {
      expect(c.startShapeId).toBeTruthy();
      expect(c.endShapeId).toBeTruthy();
      expect(['top', 'right', 'bottom', 'left']).toContain(c.startAnchor);
      expect(['top', 'right', 'bottom', 'left']).toContain(c.endAnchor);
      expect(c.startAnchor).not.toBe('center');
      expect(c.endAnchor).not.toBe('center');
    }
  });

  it('honours drawio arrow style (start arrow + no end arrow)', async () => {
    const { shapes } = await drawioAdapter.import(SMALL_FLOWCHART);
    // Edge -17 has startArrow=classic;endArrow=none → exactly one such connector.
    const connectors = byType(shapes, 'connector') as Array<{ startArrow: boolean; endArrow: boolean }>;
    const startArrowed = connectors.filter((c) => c.startArrow && !c.endArrow);
    expect(startArrowed).toHaveLength(1);
  });

  it('reports compressed payloads instead of failing', async () => {
    const compressed =
      '<mxfile host="app.diagrams.net"><diagram name="Page-1">7Vpdc5s4FP01ftw=</diagram></mxfile>';
    const { shapes, warnings } = await drawioAdapter.import(compressed);
    expect(shapes).toHaveLength(0);
    expect(warnings?.some((w) => w.kind === 'unsupported-compressed')).toBe(true);
  });
});
