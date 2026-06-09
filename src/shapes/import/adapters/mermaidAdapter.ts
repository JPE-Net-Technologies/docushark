/**
 * Mermaid import adapter (JP-85) — flowchart Phase 1.
 *
 * Mermaid is a coordinate-less text DSL, so this hand-rolls a focused parser
 * for the `flowchart`/`graph` grammar (no heavyweight `mermaid` dependency —
 * project ethos favours light, hand-rolled parsing), maps nodes/edges to
 * existing DocuShark shapes, assigns geometry via the shared `layoutGraph`
 * helper, and hitches edge connectors to the boundary anchor facing the other
 * node via the shared `connectorBinding` helper (JP-196).
 *
 * Phase 1 scope: flowcharts (the dominant Mermaid use). `classDef`/`class`
 * styling is applied; `subgraph`s are flattened (grouping not preserved) and
 * reported; sequence/class/state/ER diagrams are recognised but reported as
 * not-yet-supported rather than failing. Never silent loss.
 */

import { nanoid } from 'nanoid';
import type { ImportAdapter, ImportResult, ImportWarning } from '../ImportAdapter';
import type { Shape } from '../../Shape';
import {
  DEFAULT_RECTANGLE,
  DEFAULT_ELLIPSE,
  DEFAULT_CONNECTOR,
  DEFAULT_LIBRARY_SHAPE,
} from '../../Shape';
import { layoutGraph, type GraphDirection } from '../layoutGraph';
import { nearestEdgeAnchor, type AnchorBox } from '../connectorBinding';

/** Node shape kinds we map from Mermaid bracket syntax. */
type MerShape =
  | 'rectangle'
  | 'rounded'
  | 'ellipse'
  | 'terminator'
  | 'diamond'
  | 'data'
  | 'predefined-process';

interface MerNode {
  id: string;
  label: string;
  shape: MerShape;
  className?: string;
  defined: boolean; // got an explicit shape/label vs. auto-created from an edge
}

interface MerEdge {
  from: string;
  to: string;
  label?: string;
  dashed: boolean;
  thick: boolean;
  arrow: boolean;
}

/** Mermaid bracket pairs → shape kind, longest opener first so `([` beats `(`. */
const NODE_BRACKETS: Array<{ open: string; close: string; shape: MerShape }> = [
  { open: '([', close: '])', shape: 'terminator' },
  { open: '[[', close: ']]', shape: 'predefined-process' },
  { open: '[(', close: ')]', shape: 'rectangle' }, // cylinder/db — no cylinder shape yet
  { open: '((', close: '))', shape: 'ellipse' },
  { open: '{{', close: '}}', shape: 'rectangle' }, // hexagon — no hexagon shape yet
  { open: '[/', close: '/]', shape: 'data' },
  { open: '[\\', close: '\\]', shape: 'data' },
  { open: '{', close: '}', shape: 'diamond' },
  { open: '[', close: ']', shape: 'rectangle' },
  { open: '(', close: ')', shape: 'rounded' },
];

/** Clean a Mermaid label: strip wrapping quotes, turn <br> into newlines, drop tags. */
function cleanLabel(raw: string): string {
  return raw
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .trim();
}

interface NodeMatch {
  id: string;
  shape?: MerShape;
  label?: string;
  end: number;
}

/** Match `id` + optional shape bracket at `line[i]`. */
function matchNode(line: string, i: number): NodeMatch | null {
  const idMatch = /^[A-Za-z0-9_]+/.exec(line.slice(i));
  if (!idMatch) return null;
  const id = idMatch[0];
  let j = i + id.length;

  for (const b of NODE_BRACKETS) {
    if (line.startsWith(b.open, j)) {
      const closeIdx = line.indexOf(b.close, j + b.open.length);
      if (closeIdx !== -1) {
        const inner = line.slice(j + b.open.length, closeIdx);
        return { id, shape: b.shape, label: cleanLabel(inner), end: closeIdx + b.close.length };
      }
    }
  }
  return { id, end: j }; // bare reference
}

interface EdgeMatch {
  label?: string;
  dashed: boolean;
  thick: boolean;
  arrow: boolean;
  end: number;
}

/** Match an edge operator (+ optional `|label|`) at `line[i]`. */
function matchEdge(line: string, i: number): EdgeMatch | null {
  const rest = line.slice(i);
  const op = /^\s*(<?[-.=]{2,}>?)/.exec(rest);
  if (!op) return null;
  const token = op[1]!;
  let end = i + op[0].length;

  let label: string | undefined;
  const lbl = /^\s*\|([^|]*)\|/.exec(line.slice(end));
  if (lbl) {
    label = cleanLabel(lbl[1]!);
    end += lbl[0].length;
  }

  return {
    ...(label !== undefined ? { label } : {}),
    dashed: token.includes('.'),
    thick: token.includes('='),
    arrow: token.endsWith('>') || token.startsWith('<'),
    end,
  };
}

interface ClassStyle {
  fill?: string;
  stroke?: string;
  labelColor?: string;
}

/** Parse a `classDef` style list (`fill:#x,stroke:#y,color:#z`). */
function parseClassStyle(styleStr: string): ClassStyle {
  const style: ClassStyle = {};
  for (const part of styleStr.split(',')) {
    const [k, v] = part.split(':').map((s) => s.trim());
    if (!k || !v) continue;
    if (k === 'fill') style.fill = v;
    else if (k === 'stroke') style.stroke = v;
    else if (k === 'color') style.labelColor = v;
  }
  return style;
}

const FENCE = /^```(?:mermaid)?\s*|\s*```$/g;

function importMermaid(raw: string): ImportResult {
  const warnings: ImportWarning[] = [];
  const text = raw.replace(FENCE, '').trim();
  const rawLines = text.split('\n');

  // Strip comments + blanks; keep the rest in order.
  const lines = rawLines
    .map((l) => l.replace(/%%\{.*?\}%%/g, '').trim())
    .filter((l) => l.length > 0 && !l.startsWith('%%'));

  const header = lines[0] ?? '';
  const fc = /^(?:flowchart|graph)\s+(TB|TD|BT|LR|RL)?/i.exec(header);
  if (!fc) {
    const other = /^(sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|pie|journey|mindmap|gitGraph)/i.exec(header);
    const detail = other
      ? `Mermaid ${other[1]} is not supported yet (flowchart only for now)`
      : 'not a recognised Mermaid flowchart';
    return { shapes: [], warnings: [{ kind: other ? 'unsupported-diagram' : 'parse', detail }] };
  }

  const dirToken = (fc[1] ?? 'TB').toUpperCase();
  const direction: GraphDirection = dirToken === 'TD' ? 'TB' : (dirToken as GraphDirection);

  const nodes = new Map<string, MerNode>();
  const edges: MerEdge[] = [];
  const classStyles = new Map<string, ClassStyle>();
  let subgraphDepth = 0;
  let subgraphCount = 0;

  const ensureNode = (id: string, shape?: MerShape, label?: string): MerNode => {
    let node = nodes.get(id);
    if (!node) {
      node = { id, label: label ?? id, shape: shape ?? 'rectangle', defined: !!shape };
      nodes.set(id, node);
    } else if (shape) {
      node.shape = shape;
      if (label !== undefined) node.label = label;
      node.defined = true;
    }
    return node;
  };

  for (const line of lines.slice(1)) {
    if (/^subgraph\b/i.test(line)) {
      subgraphDepth++;
      subgraphCount++;
      continue;
    }
    if (/^end$/i.test(line)) {
      if (subgraphDepth > 0) subgraphDepth--;
      continue;
    }
    if (/^direction\b/i.test(line)) continue; // per-subgraph direction (flattened)

    const classDef = /^classDef\s+(\w+)\s+(.+)$/i.exec(line);
    if (classDef) {
      classStyles.set(classDef[1]!, parseClassStyle(classDef[2]!));
      continue;
    }
    const classAssign = /^class\s+([\w,\s]+?)\s+(\w+)$/i.exec(line);
    if (classAssign) {
      const className = classAssign[2]!;
      for (const id of classAssign[1]!.split(',').map((s) => s.trim()).filter(Boolean)) {
        ensureNode(id).className = className;
      }
      continue;
    }
    if (/^(style|linkStyle)\b/i.test(line)) continue; // direct styling — Phase 1 skip

    // Otherwise a node/edge chain: parse node (edge node)*.
    let i = 0;
    let prevId: string | null = null;
    let pending: EdgeMatch | null = null;
    while (i < line.length) {
      while (i < line.length && line[i] === ' ') i++;
      if (i >= line.length) break;

      const nodeM = matchNode(line, i);
      if (nodeM) {
        const node = ensureNode(nodeM.id, nodeM.shape, nodeM.label);
        if (pending && prevId) {
          edges.push({
            from: prevId,
            to: node.id,
            ...(pending.label !== undefined ? { label: pending.label } : {}),
            dashed: pending.dashed,
            thick: pending.thick,
            arrow: pending.arrow,
          });
          pending = null;
        }
        prevId = node.id;
        i = nodeM.end;
        continue;
      }

      const edgeM = prevId ? matchEdge(line, i) : null;
      if (edgeM) {
        pending = edgeM;
        i = edgeM.end;
        continue;
      }
      break; // unparseable remainder
    }
  }

  if (subgraphCount > 0) {
    warnings.push({
      kind: 'subgraph',
      detail: `${subgraphCount} subgraph(s) flattened (grouping not preserved yet)`,
      count: subgraphCount,
    });
  }
  if (nodes.size === 0) {
    return { shapes: [], warnings: [...warnings, { kind: 'parse', detail: 'no flowchart nodes found' }] };
  }

  // Size each node from its label, then lay the graph out.
  const sizeOf = (node: MerNode): { width: number; height: number } => {
    const labelLines = node.label.split('\n');
    const longest = Math.max(1, ...labelLines.map((l) => l.length));
    let width = Math.min(260, Math.max(96, longest * 8 + 32));
    let height = Math.max(48, labelLines.length * 22 + 24);
    if (node.shape === 'diamond') { width += 28; height += 16; }
    if (node.shape === 'ellipse' || node.shape === 'terminator') width += 12;
    return { width, height };
  };

  const sizes = new Map<string, { width: number; height: number }>();
  for (const node of nodes.values()) sizes.set(node.id, sizeOf(node));

  const positions = layoutGraph(
    Array.from(nodes.values()).map((n) => ({ id: n.id, ...sizes.get(n.id)! })),
    edges.map((e) => ({ from: e.from, to: e.to })),
    { direction }
  );

  const shapes: Shape[] = [];
  const idMap = new Map<string, string>(); // mermaid id → DocuShark shape id

  for (const node of nodes.values()) {
    const size = sizes.get(node.id)!;
    const pos = positions.get(node.id) ?? { x: 0, y: 0 };
    const style = node.className ? classStyles.get(node.className) : undefined;
    const id = nanoid();
    idMap.set(node.id, id);

    const base = { id, x: pos.x, y: pos.y, rotation: 0, opacity: 1, locked: false, visible: true };
    const styleProps = {
      ...(style?.fill ? { fill: style.fill } : {}),
      ...(style?.stroke ? { stroke: style.stroke } : {}),
      ...(style?.labelColor ? { labelColor: style.labelColor } : {}),
    };

    if (node.shape === 'ellipse') {
      shapes.push({
        ...DEFAULT_ELLIPSE, ...base, type: 'ellipse',
        radiusX: size.width / 2, radiusY: size.height / 2, label: node.label, ...styleProps,
      } as Shape);
    } else if (node.shape === 'rectangle' || node.shape === 'rounded') {
      shapes.push({
        ...DEFAULT_RECTANGLE, ...base, type: 'rectangle',
        width: size.width, height: size.height,
        cornerRadius: node.shape === 'rounded' ? 12 : 0, label: node.label, ...styleProps,
      } as Shape);
    } else {
      // Flowchart library shapes: terminator / diamond / data / predefined-process.
      shapes.push({
        ...DEFAULT_LIBRARY_SHAPE, ...base, type: node.shape,
        width: size.width, height: size.height, label: node.label, ...styleProps,
      } as Shape);
    }
  }

  // Edges → connectors, hitched to the boundary anchor facing the other node.
  for (const edge of edges) {
    const startId = idMap.get(edge.from);
    const endId = idMap.get(edge.to);
    const startPos = positions.get(edge.from);
    const endPos = positions.get(edge.to);
    if (!startId || !endId || !startPos || !endPos) continue;

    const startBox: AnchorBox = { cx: startPos.x, cy: startPos.y, ...sizes.get(edge.from)! };
    const endBox: AnchorBox = { cx: endPos.x, cy: endPos.y, ...sizes.get(edge.to)! };

    shapes.push({
      ...DEFAULT_CONNECTOR,
      id: nanoid(),
      type: 'connector',
      x: startPos.x, y: startPos.y, x2: endPos.x, y2: endPos.y,
      rotation: 0, opacity: 1, locked: false, visible: true,
      strokeWidth: edge.thick ? 3 : DEFAULT_CONNECTOR.strokeWidth,
      lineStyle: edge.dashed ? 'dashed' : 'solid',
      startArrow: false,
      endArrow: edge.arrow,
      startShapeId: startId,
      startAnchor: nearestEdgeAnchor(startBox, endPos),
      endShapeId: endId,
      endAnchor: nearestEdgeAnchor(endBox, startPos),
      ...(edge.label ? { label: edge.label } : {}),
    } as Shape);
  }

  return { shapes, warnings };
}

const MERMAID_HEADER =
  /^\s*(?:```(?:mermaid)?\s*)?(?:%%\{.*?\}%%\s*)?(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|gantt|pie|journey|mindmap|gitGraph)\b/i;

export const mermaidAdapter: ImportAdapter = {
  id: 'mermaid',
  label: 'Mermaid',
  canImport: (raw) => MERMAID_HEADER.test(raw),
  import: async (raw) => importMermaid(raw),
};
