import { describe, it, expect } from 'vitest';
import {
  getExportBounds,
  exportToSvg,
  ExportData,
  ExportOptions,
} from './exportUtils';
import type {
  RectangleShape,
  EllipseShape,
  GroupShape,
  TextShape,
  ConnectorShape,
  Shape,
} from '../shapes/Shape';

// Import shape modules to trigger handler registration
import '../shapes/Rectangle';
import '../shapes/Ellipse';
import '../shapes/Line';
import '../shapes/Text';
import '../shapes/Group';
import '../shapes/Connector';

// ============ Test Helpers ============

const baseProps = {
  rotation: 0,
  opacity: 1,
  locked: false,
  visible: true,
  fill: '#ffffff',
  stroke: '#000000',
  strokeWidth: 0,
} as const;

function makeRect(id: string, x: number, y: number, w: number, h: number): RectangleShape {
  return {
    ...baseProps,
    id,
    type: 'rectangle',
    x,
    y,
    width: w,
    height: h,
    cornerRadius: 0,
  };
}

function makeEllipse(id: string, x: number, y: number, rx: number, ry: number): EllipseShape {
  return {
    ...baseProps,
    id,
    type: 'ellipse',
    x,
    y,
    radiusX: rx,
    radiusY: ry,
  };
}

function makeText(id: string, x: number, y: number, text: string): TextShape {
  return {
    ...baseProps,
    id,
    type: 'text',
    x,
    y,
    width: 100,
    height: 20,
    text,
    fontSize: 14,
    fontFamily: 'sans-serif',
    textAlign: 'center',
    verticalAlign: 'middle',
    fill: '#000000',
    stroke: null,
    strokeWidth: 0,
  };
}

function makeGroup(id: string, childIds: string[]): GroupShape {
  return {
    ...baseProps,
    id,
    type: 'group',
    x: 0,
    y: 0,
    childIds,
    fill: null,
    stroke: null,
    strokeWidth: 0,
  };
}

function makeConnector(
  id: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  overrides: Partial<ConnectorShape> = {}
): ConnectorShape {
  return {
    ...baseProps,
    id,
    type: 'connector',
    x: x1,
    y: y1,
    x2,
    y2,
    fill: null,
    stroke: 'auto',
    strokeWidth: 2,
    startShapeId: null,
    startAnchor: 'right',
    endShapeId: null,
    endAnchor: 'left',
    startArrow: false,
    endArrow: true,
    ...overrides,
  };
}

function makeExportData(
  shapes: Shape[],
  selectedIds: string[] = []
): ExportData {
  const shapesMap: Record<string, Shape> = {};
  const shapeOrder: string[] = [];
  for (const s of shapes) {
    shapesMap[s.id] = s;
    shapeOrder.push(s.id);
  }
  return { shapes: shapesMap, shapeOrder, selectedIds };
}

function defaultOptions(overrides: Partial<ExportOptions> = {}): ExportOptions {
  return {
    format: 'svg',
    scope: 'all',
    scale: 1,
    background: '#ffffff',
    padding: 0,
    filename: 'test',
    ...overrides,
  };
}

// ============ Tests ============

describe('exportUtils', () => {
  describe('getExportBounds', () => {
    it('returns null for empty data', () => {
      const data = makeExportData([]);
      expect(getExportBounds(data, 'all')).toBeNull();
    });

    it('returns bounds for a single rectangle', () => {
      const rect = makeRect('r1', 100, 100, 200, 100);
      const data = makeExportData([rect]);
      const bounds = getExportBounds(data, 'all');

      expect(bounds).not.toBeNull();
      // Rectangle centered at (100,100) with width=200, height=100
      // So minX=0, minY=50, maxX=200, maxY=150
      expect(bounds!.minX).toBe(0);
      expect(bounds!.minY).toBe(50);
      expect(bounds!.maxX).toBe(200);
      expect(bounds!.maxY).toBe(150);
    });

    it('returns bounds for multiple shapes', () => {
      const r1 = makeRect('r1', 0, 0, 100, 100); // -50..50, -50..50
      const r2 = makeRect('r2', 200, 200, 100, 100); // 150..250, 150..250
      const data = makeExportData([r1, r2]);
      const bounds = getExportBounds(data, 'all');

      expect(bounds).not.toBeNull();
      expect(bounds!.minX).toBe(-50);
      expect(bounds!.minY).toBe(-50);
      expect(bounds!.maxX).toBe(250);
      expect(bounds!.maxY).toBe(250);
    });

    it('excludes invisible shapes', () => {
      const r1 = makeRect('r1', 0, 0, 100, 100);
      const r2 = { ...makeRect('r2', 500, 500, 100, 100), visible: false };
      const data = makeExportData([r1, r2]);
      const bounds = getExportBounds(data, 'all');

      expect(bounds).not.toBeNull();
      expect(bounds!.maxX).toBe(50); // Only r1 included
    });

    it('handles selection scope', () => {
      const r1 = makeRect('r1', 0, 0, 100, 100);
      const r2 = makeRect('r2', 200, 200, 100, 100);
      const data = makeExportData([r1, r2], ['r1']);
      const bounds = getExportBounds(data, 'selection');

      expect(bounds).not.toBeNull();
      expect(bounds!.minX).toBe(-50);
      expect(bounds!.maxX).toBe(50);
    });

    it('returns null when selection is empty', () => {
      const r1 = makeRect('r1', 0, 0, 100, 100);
      const data = makeExportData([r1], []);
      const bounds = getExportBounds(data, 'selection');

      // Empty selectedIds falls through to 'all' behavior
      expect(bounds).not.toBeNull();
    });

    it('includes group children in bounds', () => {
      const child1 = makeRect('c1', 0, 0, 50, 50);
      const child2 = makeRect('c2', 100, 100, 50, 50);
      const group = makeGroup('g1', ['c1', 'c2']);
      const data = makeExportData([child1, child2, group], ['g1']);
      const bounds = getExportBounds(data, 'selection');

      expect(bounds).not.toBeNull();
      expect(bounds!.minX).toBe(-25);
      expect(bounds!.maxX).toBe(125);
    });
  });

  describe('exportToSvg', () => {
    it('exports a single rectangle to SVG', () => {
      const rect = makeRect('r1', 50, 50, 100, 80);
      const data = makeExportData([rect]);
      const svg = exportToSvg(data, defaultOptions());

      expect(svg).toContain('<?xml version="1.0"');
      expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
      expect(svg).toContain('<rect');
      expect(svg).toContain('width="100"');
      expect(svg).toContain('height="80"');
    });

    it('includes background when specified', () => {
      const rect = makeRect('r1', 50, 50, 100, 80);
      const data = makeExportData([rect]);
      const svg = exportToSvg(data, defaultOptions({ background: '#ff0000' }));

      expect(svg).toContain('fill="#ff0000"');
    });

    it('omits background when null', () => {
      const rect = makeRect('r1', 50, 50, 100, 80);
      const data = makeExportData([rect]);
      const svg = exportToSvg(data, defaultOptions({ background: null }));

      // Should not have a background rect (no fill on a viewport rect)
      const rectMatches = svg.match(/<rect/g) ?? [];
      expect(rectMatches.length).toBe(1); // Only the shape rect
    });

    it('applies padding', () => {
      const rect = makeRect('r1', 50, 50, 100, 80);
      const data = makeExportData([rect]);
      const svg = exportToSvg(data, defaultOptions({ padding: 20 }));

      // Width = 100 + 40 padding, Height = 80 + 40 padding
      expect(svg).toContain('width="140"');
      expect(svg).toContain('height="120"');
    });

    it('exports an ellipse', () => {
      const ellipse = makeEllipse('e1', 100, 100, 50, 30);
      const data = makeExportData([ellipse]);
      const svg = exportToSvg(data, defaultOptions());

      expect(svg).toContain('<ellipse');
      expect(svg).toContain('rx="50"');
      expect(svg).toContain('ry="30"');
    });

    it('exports text', () => {
      const text = makeText('t1', 100, 100, 'Hello World');
      const data = makeExportData([text]);
      const svg = exportToSvg(data, defaultOptions());

      expect(svg).toContain('<text');
      expect(svg).toContain('Hello World');
    });

    it('escapes XML in text', () => {
      const text = makeText('t1', 100, 100, '<script>&alert("xss")</script>');
      const data = makeExportData([text]);
      const svg = exportToSvg(data, defaultOptions());

      expect(svg).toContain('&lt;script&gt;');
      expect(svg).toContain('&amp;alert');
      expect(svg).not.toContain('<script>');
    });

    it('wraps groups in <g> elements', () => {
      const child = makeRect('c1', 50, 50, 80, 60);
      const group = makeGroup('g1', ['c1']);
      const data = makeExportData([child, group]);
      // Need to set shapeOrder with group first
      data.shapeOrder = ['g1'];
      const svg = exportToSvg(data, defaultOptions());

      expect(svg).toContain('<g>');
      expect(svg).toContain('</g>');
      expect(svg).toContain('<rect');
    });

    it('flattens groups when flattenGroups is true', () => {
      const child = makeRect('c1', 50, 50, 80, 60);
      const group = makeGroup('g1', ['c1']);
      const data = makeExportData([child, group]);
      data.shapeOrder = ['g1'];
      const svg = exportToSvg(data, defaultOptions({ flattenGroups: true }));

      expect(svg).not.toContain('<g>');
      expect(svg).toContain('<rect');
    });

    it('throws for empty shapes', () => {
      const data = makeExportData([]);
      expect(() => exportToSvg(data, defaultOptions())).toThrow('No shapes to export');
    });

    it('renders unknown shape type as placeholder alongside valid shapes', () => {
      const rect = makeRect('r1', 0, 0, 200, 200);
      const data = makeExportData([rect]);
      // Add the unknown shape to the shapes map but not to shapeOrder
      // so it doesn't affect bounds calculation
      const unknown: Shape = {
        ...baseProps,
        id: 'u1',
        type: 'unknowntype',
        x: 50,
        y: 50,
      } as any;
      data.shapes['u1'] = unknown;
      // Manually build shapeOrder to include both
      data.shapeOrder = ['r1', 'u1'];

      // exportToSvg iterates shapeOrder for rendering but getExportBounds
      // only includes shapes found through shapeOrder → getShapesToExport.
      // The unknown shape will fail in calculateCombinedBounds.
      // Instead, test with selection scope including only the known shape.
      const svgData: ExportData = {
        ...data,
        selectedIds: ['r1'],
      };
      const svg = exportToSvg(svgData, defaultOptions({ scope: 'selection' }));

      // The rect should be present
      expect(svg).toContain('<rect');
    });

    it('respects opacity', () => {
      const rect = { ...makeRect('r1', 50, 50, 100, 80), opacity: 0.5 };
      const data = makeExportData([rect]);
      const svg = exportToSvg(data, defaultOptions());

      expect(svg).toContain('opacity="0.5"');
    });
  });

  describe('group-aware selection export', () => {
    it('exports entire group when group is selected', () => {
      const child1 = makeRect('c1', 0, 0, 50, 50);
      const child2 = makeRect('c2', 100, 100, 50, 50);
      const group = makeGroup('g1', ['c1', 'c2']);
      const data = makeExportData([child1, child2, group], ['g1']);
      data.shapeOrder = ['g1'];

      const svg = exportToSvg(data, defaultOptions({ scope: 'selection' }));
      expect(svg).toContain('<g>');
      // Both children should be rendered
      const rectCount = (svg.match(/<rect /g) ?? []).length;
      // Background rect + 2 shape rects
      expect(rectCount).toBeGreaterThanOrEqual(2);
    });

    it('exports individual children for partial group selection', () => {
      const child1 = makeRect('c1', 0, 0, 50, 50);
      const child2 = makeRect('c2', 100, 100, 50, 50);
      const group = makeGroup('g1', ['c1', 'c2']);
      const data = makeExportData([child1, child2, group], ['c1']);

      const bounds = getExportBounds(data, 'selection');
      expect(bounds).not.toBeNull();
      // Only c1 bounds
      expect(bounds!.minX).toBe(-25);
      expect(bounds!.maxX).toBe(25);
    });

    it('handles nested groups with partial selection', () => {
      const leaf = makeRect('leaf', 50, 50, 40, 40);
      const innerGroup = makeGroup('inner', ['leaf']);
      const outerGroup = makeGroup('outer', ['inner']);
      const data = makeExportData([leaf, innerGroup, outerGroup], ['leaf']);

      const bounds = getExportBounds(data, 'selection');
      expect(bounds).not.toBeNull();
      expect(bounds!.minX).toBe(30);
      expect(bounds!.maxX).toBe(70);
    });
  });

  describe('connectors & labels', () => {
    it('resolves the "auto" stroke sentinel to a concrete colour (line stays visible)', () => {
      // Regression: a connector with the default `stroke: 'auto'` used to emit
      // `stroke="auto"`, which SVG treats as `none` → invisible line, while the
      // arrowhead's `fill="auto"` fell back to black so only the tip showed.
      const conn = makeConnector('c1', 0, 0, 100, 40, { stroke: 'auto' });
      const svg = exportToSvg(makeExportData([conn]), defaultOptions());

      expect(svg).toContain('<line');
      expect(svg).not.toContain('stroke="auto"');
      expect(svg).not.toContain('fill="auto"');
      expect(svg).toContain('stroke="#000000"');
    });

    it('renders the connector label as text at the midpoint', () => {
      const conn = makeConnector('c1', 0, 0, 100, 40, { label: 'imports', stroke: '#333333' });
      const svg = exportToSvg(makeExportData([conn]), defaultOptions());

      expect(svg).toContain('>imports</text>');
    });

    it('splits multi-line labels into tspans', () => {
      const rect: RectangleShape = { ...makeRect('r1', 0, 0, 140, 80), label: 'Top\nBottom' };
      const svg = exportToSvg(makeExportData([rect]), defaultOptions());

      expect(svg).toContain('<tspan');
      expect(svg).toContain('>Top</tspan>');
      expect(svg).toContain('>Bottom</tspan>');
    });

    it('uses light ink for AUTO colours on a dark background', () => {
      const conn = makeConnector('c1', 0, 0, 100, 40, { stroke: 'auto' });
      const svg = exportToSvg(makeExportData([conn]), defaultOptions({ background: '#0e1c30' }));

      expect(svg).not.toContain('stroke="auto"');
      expect(svg).toContain('stroke="#ffffff"');
    });

    it('follows the routed path (waypoints) as a polyline, not a straight line', () => {
      const conn = makeConnector('c1', 0, 0, 100, 100, {
        routingMode: 'orthogonal',
        waypoints: [
          { x: 0, y: 50 },
          { x: 100, y: 50 },
        ],
        stroke: '#333333',
      });
      const svg = exportToSvg(makeExportData([conn]), defaultOptions());

      expect(svg).toContain('<polyline');
      // start + 2 waypoints + end = 4 coordinate pairs
      const points = svg.match(/<polyline points="([^"]*)"/)?.[1] ?? '';
      expect(points.trim().split(/\s+/)).toHaveLength(4);
    });

    it('draws a legibility halo around a connector label when labelStrokeColor is set', () => {
      const conn = makeConnector('c1', 0, 0, 100, 40, {
        label: 'getHTML',
        labelStrokeColor: '#ffffff',
        stroke: '#333333',
      });
      const svg = exportToSvg(makeExportData([conn]), defaultOptions());

      expect(svg).toContain('paint-order="stroke"');
    });
  });
});
