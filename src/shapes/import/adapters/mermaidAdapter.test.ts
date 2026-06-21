import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mermaidAdapter } from './mermaidAdapter';
import type { Shape } from '../../Shape';

const PIPELINE = readFileSync(
  resolve(process.cwd(), 'src/shapes/import/adapters/__fixtures__/example-pipeline.mermaid'),
  'utf8'
);

const byType = (shapes: Shape[], type: string) => shapes.filter((s) => s.type === type);
const labelled = (shapes: Shape[], label: string) =>
  shapes.find((s) => (s as { label?: string }).label === label);

describe('mermaidAdapter', () => {
  it('recognises Mermaid headers only', () => {
    expect(mermaidAdapter.canImport('flowchart TD\n  A --> B')).toBe(true);
    expect(mermaidAdapter.canImport('graph LR; A-->B')).toBe(true);
    expect(mermaidAdapter.canImport('```mermaid\nflowchart TD\nA-->B\n```')).toBe(true);
    expect(mermaidAdapter.canImport('{"type":"excalidraw"}')).toBe(false);
    expect(mermaidAdapter.canImport('<mxGraphModel>')).toBe(false);
  });

  it('maps node bracket syntax to the right shapes', async () => {
    const src = `flowchart TD
      A([Start]) --> B{Decide}
      B --> C[Process]
      C --> D[(Store)]
      D --> E[/Input/]`;
    const { shapes } = await mermaidAdapter.import(src);
    expect((labelled(shapes, 'Start') as Shape).type).toBe('terminator');
    expect((labelled(shapes, 'Decide') as Shape).type).toBe('diamond');
    expect((labelled(shapes, 'Process') as Shape).type).toBe('rectangle');
    expect((labelled(shapes, 'Input') as Shape).type).toBe('data');
  });

  it('converts literal \\n and <br> in labels to newlines', async () => {
    const { shapes } = await mermaidAdapter.import('flowchart TD\n  A["Top\\nBottom"] --> B["One<br/>Two"]');
    expect((labelled(shapes, 'Top\nBottom') as Shape | undefined)?.type).toBe('rectangle');
    expect(labelled(shapes, 'One\nTwo')).toBeDefined();
  });

  it('creates connectors with edge labels, arrows and dashed style', async () => {
    const src = `flowchart TD
      A[A] -->|yes| B[B]
      A -.->|retry| C[C]`;
    const { shapes } = await mermaidAdapter.import(src);
    const conns = byType(shapes, 'connector') as Array<{
      label?: string; endArrow: boolean; lineStyle: string;
      startShapeId?: string; endShapeId?: string; startAnchor?: string; endAnchor?: string;
    }>;
    expect(conns).toHaveLength(2);
    expect(conns.map((c) => c.label).sort()).toEqual(['retry', 'yes']);
    // All bound + hitched to an edge anchor (never centre).
    for (const c of conns) {
      expect(c.startShapeId).toBeTruthy();
      expect(c.endShapeId).toBeTruthy();
      expect(['top', 'right', 'bottom', 'left']).toContain(c.startAnchor);
      expect(c.endArrow).toBe(true);
    }
    expect(conns.find((c) => c.label === 'retry')!.lineStyle).toBe('dashed');
  });

  it('marks connectors orthogonal so the import pipeline routes them (JP-305)', async () => {
    const { shapes } = await mermaidAdapter.import('flowchart TD\n  A --> B\n  B --> C');
    const conns = byType(shapes, 'connector') as Array<{ routingMode?: string }>;
    expect(conns.length).toBeGreaterThan(0);
    for (const c of conns) expect(c.routingMode).toBe('orthogonal');
  });

  it('applies classDef styling to assigned nodes', async () => {
    const src = `flowchart TD
      A[A] --> B[B]
      classDef err fill:#7a1f1f,stroke:#ff6b6b,color:#fff
      class B err`;
    const { shapes } = await mermaidAdapter.import(src);
    const b = labelled(shapes, 'B') as { fill: string | null; stroke: string | null; labelColor?: string };
    expect(b.fill).toBe('#7a1f1f');
    expect(b.stroke).toBe('#ff6b6b');
    expect(b.labelColor).toBe('#fff');
  });

  it('reports non-flowchart diagrams instead of failing', async () => {
    const { shapes, warnings } = await mermaidAdapter.import('sequenceDiagram\n  A->>B: hi');
    expect(shapes).toHaveLength(0);
    expect(warnings?.some((w) => w.kind === 'unsupported-diagram')).toBe(true);
  });

  it('imports the example pipeline end-to-end', async () => {
    const { shapes, warnings } = await mermaidAdapter.import(PIPELINE);
    // Nodes laid out + edges connected; subgraphs flattened + reported.
    expect(byType(shapes, 'connector').length).toBeGreaterThan(20);
    expect(byType(shapes, 'diamond').length).toBeGreaterThanOrEqual(4); // Validate/Type/Confidence/Index
    expect(labelled(shapes, 'User uploads document')!.type).toBe('terminator');
    expect(warnings?.some((w) => w.kind === 'subgraph')).toBe(true);
    // Error-class nodes picked up their fill.
    const reject = labelled(shapes, 'Return error to user') as { fill: string | null };
    expect(reject.fill).toBe('#7a1f1f');
    // No two nodes share an exact position (layout actually spread them).
    const nodeShapes = shapes.filter((s) => s.type !== 'connector');
    const coords = new Set(nodeShapes.map((s) => `${Math.round(s.x)},${Math.round(s.y)}`));
    expect(coords.size).toBe(nodeShapes.length);
  });
});
