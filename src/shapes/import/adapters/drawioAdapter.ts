/**
 * drawio / diagrams.net (`.drawio`, mxGraph XML) import adapter (JP-86).
 *
 * Parses the uncompressed `mxGraphModel`: `<mxCell vertex="1">` → primitives,
 * `<mxCell edge="1" source=… target=…>` → connectors. A cell's `style` is a
 * `;`-delimited string whose leading bare token (if any) is the shape *kind*
 * (`rhombus`, `ellipse`, …; absent ⇒ rectangle); the rest are `key=value`.
 * Geometry `x,y` is the TOP-LEFT corner — DocuShark box shapes are
 * centre-anchored, so they're recentred (as in the Excalidraw adapter).
 *
 * Bound edges carry no explicit endpoint geometry, so each end hitches to the
 * boundary anchor facing the *other* bound node's centre, via the shared
 * `connectorBinding` helper (JP-196) — no more centre-to-centre arrows.
 *
 * Phase 1 scope: the core flowchart/box primitives + bound edges of a single
 * page. Deliberately reported (never silently dropped), pending follow-up
 * slices: stencil → icon resolution (`shape=mxgraph.*` currently becomes a
 * labelled box), multi-page → grouping (only the first page is imported), and
 * compressed (deflate) diagram payloads.
 */

import { nanoid } from 'nanoid';
import type { ImportAdapter, ImportResult, ImportWarning } from '../ImportAdapter';
import type { Shape } from '../../Shape';
import {
  DEFAULT_RECTANGLE,
  DEFAULT_ELLIPSE,
  DEFAULT_TEXT,
  DEFAULT_CONNECTOR,
  DEFAULT_LIBRARY_SHAPE,
} from '../../Shape';
import { nearestEdgeAnchor, boxFromTopLeft } from '../connectorBinding';

/** A drawio cell flattened to the fields we read (handles `<object>` wrappers). */
interface DioCell {
  id: string;
  value: string;
  style: string;
  vertex: boolean;
  edge: boolean;
  source: string | null;
  target: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ParsedStyle {
  /** Leading bare token (no `=`), e.g. `rhombus` / `ellipse` — the shape kind. */
  kind: string | null;
  props: Record<string, string>;
}

/** Parse an mxGraph `style` string into its leading kind + `key=value` props. */
function parseStyle(style: string): ParsedStyle {
  let kind: string | null = null;
  const props: Record<string, string> = {};
  for (const token of style.split(';')) {
    if (!token) continue;
    const eq = token.indexOf('=');
    if (eq === -1) {
      if (kind === null) kind = token; // first bare flag = the shape kind
    } else {
      props[token.slice(0, eq)] = token.slice(eq + 1);
    }
  }
  return { kind, props };
}

/** drawio `none`/empty colour → no fill/stroke; otherwise pass the value through. */
function colorOrNull(c: string | undefined): string | null {
  return !c || c === 'none' ? null : c;
}

/**
 * Decode an mxGraph label to plain text: the value is HTML (`Decis<span…>ion
 * 2</span>` after XML entity-decoding), so render it and read `textContent`.
 */
function stripHtmlLabel(value: string): string {
  if (!value) return '';
  if (typeof DOMParser === 'undefined') return value.replace(/<[^>]*>/g, '').trim();
  const doc = new DOMParser().parseFromString(value, 'text/html');
  return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
}

const num = (v: string | null, fallback = 0): number => {
  const n = v === null ? NaN : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Flatten `<mxCell>` and `<object>`/`<UserObject>`-wrapped cells under `root`. */
function collectCells(root: Element): DioCell[] {
  const cells: DioCell[] = [];
  for (const child of Array.from(root.children)) {
    const tag = child.tagName.toLowerCase();
    let id: string | null;
    let value: string;
    let mxc: Element | null;
    if (tag === 'mxcell') {
      id = child.getAttribute('id');
      value = child.getAttribute('value') ?? '';
      mxc = child;
    } else if (tag === 'object' || tag === 'userobject') {
      // Wrapper carries the id + label; the inner mxCell carries style/geometry.
      id = child.getAttribute('id');
      value = child.getAttribute('label') ?? '';
      mxc = child.querySelector('mxCell');
    } else {
      continue;
    }
    if (!id || !mxc) continue;

    const geom = mxc.querySelector('mxGeometry');
    cells.push({
      id,
      value,
      style: mxc.getAttribute('style') ?? '',
      vertex: mxc.getAttribute('vertex') === '1',
      edge: mxc.getAttribute('edge') === '1',
      source: mxc.getAttribute('source'),
      target: mxc.getAttribute('target'),
      x: num(geom?.getAttribute('x') ?? null),
      y: num(geom?.getAttribute('y') ?? null),
      width: num(geom?.getAttribute('width') ?? null),
      height: num(geom?.getAttribute('height') ?? null),
    });
  }
  return cells;
}

/** Common centre-anchored base shared by box primitives. */
function boxBase(cell: DioCell) {
  return {
    id: nanoid(),
    x: cell.x + cell.width / 2,
    y: cell.y + cell.height / 2,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
  };
}

async function importDrawio(raw: string): Promise<ImportResult> {
  const shapes: Shape[] = [];
  const warnings: ImportWarning[] = [];

  if (typeof DOMParser === 'undefined') {
    return { shapes, warnings: [{ kind: 'parse', detail: 'XML parsing unavailable in this environment' }] };
  }
  const doc = new DOMParser().parseFromString(raw, 'application/xml');
  if (doc.querySelector('parsererror')) {
    return { shapes, warnings: [{ kind: 'parse', detail: 'not a valid drawio/XML document' }] };
  }

  const model = doc.querySelector('mxGraphModel');
  const root = model?.querySelector('root');
  if (!root) {
    // No inline model usually means a compressed (deflate+base64) <diagram> body.
    const compressed = doc.querySelector('diagram');
    const detail = compressed
      ? 'compressed drawio payload not yet supported — re-export with "Uncompressed" in drawio'
      : 'no <mxGraphModel> found';
    return { shapes, warnings: [{ kind: 'unsupported-compressed', detail }] };
  }

  const pageCount = doc.querySelectorAll('diagram').length;
  if (pageCount > 1) {
    warnings.push({
      kind: 'multi-page',
      detail: `only the first of ${pageCount} pages imported (multi-page grouping is a follow-up)`,
      count: pageCount - 1,
    });
  }

  const cells = collectCells(root);
  const idMap = new Map<string, string>(); // drawio cell id → DocuShark shape id
  const cellById = new Map(cells.map((c) => [c.id, c]));
  const unsupported = new Map<string, number>();

  // Pass A: vertices → primitives.
  for (const cell of cells) {
    if (!cell.vertex) continue;
    const { kind, props } = parseStyle(cell.style);
    const fill = colorOrNull(props['fillColor']);
    const stroke = props['strokeColor'] ? colorOrNull(props['strokeColor']) : DEFAULT_RECTANGLE.stroke;
    const labelColor = props['fontColor'];
    const label = stripHtmlLabel(cell.value);
    const base = boxBase(cell);

    // A stencil (`shape=mxgraph.*`) or any kind we don't model yet still imports
    // as a labelled box so nothing is lost — icon resolution is a follow-up.
    const isStencil = kind?.startsWith('mxgraph.') || !!props['shape'];

    if (kind === 'ellipse') {
      idMap.set(cell.id, base.id);
      shapes.push({
        ...DEFAULT_ELLIPSE, ...base, type: 'ellipse',
        radiusX: cell.width / 2, radiusY: cell.height / 2,
        fill, stroke, ...(labelColor ? { labelColor } : {}), label,
      } as Shape);
    } else if (kind === 'rhombus') {
      idMap.set(cell.id, base.id);
      shapes.push({
        ...DEFAULT_LIBRARY_SHAPE, ...base, type: 'diamond',
        width: cell.width, height: cell.height,
        fill, stroke, ...(labelColor ? { labelColor } : {}), label,
      } as Shape);
    } else if (kind === 'text') {
      idMap.set(cell.id, base.id);
      shapes.push({
        ...DEFAULT_TEXT, ...base, type: 'text',
        width: cell.width, height: cell.height,
        text: label, ...(labelColor ? { fill: labelColor } : {}),
      } as Shape);
    } else {
      // Default + stencil fallback: rectangle (rounded honours `rounded=1`).
      if (isStencil) unsupported.set('stencil', (unsupported.get('stencil') ?? 0) + 1);
      else if (kind) unsupported.set(kind, (unsupported.get(kind) ?? 0) + 1);
      idMap.set(cell.id, base.id);
      shapes.push({
        ...DEFAULT_RECTANGLE, ...base, type: 'rectangle',
        width: cell.width, height: cell.height,
        cornerRadius: props['rounded'] === '1' ? 12 : 0,
        fill, stroke, ...(labelColor ? { labelColor } : {}), label,
      } as Shape);
    }
  }

  // Pass B: edges → connectors, hitched to edge anchors via the shared helper.
  for (const cell of cells) {
    if (!cell.edge) continue;
    const { props } = parseStyle(cell.style);
    const startEl = cell.source ? cellById.get(cell.source) : undefined;
    const endEl = cell.target ? cellById.get(cell.target) : undefined;
    const startId = startEl ? idMap.get(startEl.id) : undefined;
    const endId = endEl ? idMap.get(endEl.id) : undefined;

    const startCenter = startEl ? { x: startEl.x + startEl.width / 2, y: startEl.y + startEl.height / 2 } : undefined;
    const endCenter = endEl ? { x: endEl.x + endEl.width / 2, y: endEl.y + endEl.height / 2 } : undefined;

    // No explicit edge points in drawio: hitch toward the other node's centre.
    const startAnchor =
      startId && startEl && endCenter
        ? nearestEdgeAnchor(boxFromTopLeft(startEl.x, startEl.y, startEl.width, startEl.height), endCenter)
        : undefined;
    const endAnchor =
      endId && endEl && startCenter
        ? nearestEdgeAnchor(boxFromTopLeft(endEl.x, endEl.y, endEl.width, endEl.height), startCenter)
        : undefined;

    if (!startId && !endId && !startCenter && !endCenter) {
      // Fully dangling edge (no bindings, no geometry) — nothing to anchor to.
      unsupported.set('dangling-edge', (unsupported.get('dangling-edge') ?? 0) + 1);
      continue;
    }

    // drawio's default edge has an end arrow and no start arrow.
    const hasStartArrow = !!props['startArrow'] && props['startArrow'] !== 'none';
    const hasEndArrow = props['endArrow'] !== 'none';

    shapes.push({
      ...DEFAULT_CONNECTOR,
      id: nanoid(),
      type: 'connector',
      x: startCenter?.x ?? 0,
      y: startCenter?.y ?? 0,
      x2: endCenter?.x ?? 0,
      y2: endCenter?.y ?? 0,
      rotation: 0,
      opacity: 1,
      locked: false,
      visible: true,
      stroke: colorOrNull(props['strokeColor']) ?? DEFAULT_CONNECTOR.stroke,
      strokeWidth: num(props['strokeWidth'] ?? null, DEFAULT_CONNECTOR.strokeWidth),
      startArrow: hasStartArrow,
      endArrow: hasEndArrow,
      ...(stripHtmlLabel(cell.value) ? { label: stripHtmlLabel(cell.value) } : {}),
      ...(startId ? { startShapeId: startId } : {}),
      ...(startAnchor ? { startAnchor } : {}),
      ...(endId ? { endShapeId: endId } : {}),
      ...(endAnchor ? { endAnchor } : {}),
    } as Shape);
  }

  for (const [kind, count] of unsupported) {
    const detail =
      kind === 'stencil'
        ? `${count} stencil shape(s) imported as labelled boxes (icon mapping is a follow-up)`
        : kind === 'dangling-edge'
          ? `${count} edge(s) with no endpoints skipped`
          : `${count} unsupported "${kind}" shape(s) imported as boxes`;
    warnings.push({ kind, detail, count });
  }

  return { shapes, warnings };
}

export const drawioAdapter: ImportAdapter = {
  id: 'drawio',
  label: 'drawio',
  canImport: (raw) => /<mxGraphModel|<mxfile|host="app\.diagrams\.net"/.test(raw),
  import: importDrawio,
};
