/**
 * Excalidraw (`.excalidraw`) document import adapter (JP-165).
 *
 * Excalidraw stores a flat `elements[]` array with absolute coordinates, so no
 * graph layout is needed. Element `x,y` is the TOP-LEFT corner; DocuShark
 * rect/ellipse/library shapes are CENTER-anchored, so box shapes are recentred.
 * Bound text (`containerId`) becomes the container's label; arrows with
 * `startBinding`/`endBinding` become connectors wired to the mapped shape ids.
 * Freehand `freedraw` is intentionally skipped (a non-goal) and reported.
 */

import { nanoid } from 'nanoid';
import type { ImportAdapter, ImportResult, ImportWarning } from '../ImportAdapter';
import type { Shape, FileCategory } from '../../Shape';
import {
  DEFAULT_RECTANGLE,
  DEFAULT_ELLIPSE,
  DEFAULT_LINE,
  DEFAULT_TEXT,
  DEFAULT_CONNECTOR,
  DEFAULT_LIBRARY_SHAPE,
  DEFAULT_FILE_SHAPE,
} from '../../Shape';
import { blobStorage } from '../../../storage/BlobStorage';
import { AUTO_COLOR } from '../../../engine/ContrastResolver';
import { nearestEdgeAnchor, boxFromTopLeft } from '../connectorBinding';

/** Excalidraw's default stroke — theme-inverted by Excalidraw at render time. */
const EXCALIDRAW_DEFAULT_STROKE = '#1e1e1e';

/** Loosely-typed view of the Excalidraw element fields we read. */
interface ExElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle?: number;
  strokeColor?: string;
  backgroundColor?: string;
  strokeWidth?: number;
  opacity?: number; // 0–100
  roundness?: { type: number } | null;
  points?: Array<[number, number]>;
  text?: string;
  fontSize?: number;
  fontFamily?: number;
  textAlign?: string;
  containerId?: string | null;
  startBinding?: { elementId?: string } | null;
  endBinding?: { elementId?: string } | null;
  fileId?: string | null;
  isDeleted?: boolean;
}

interface ExScene {
  type?: string;
  elements?: ExElement[];
  files?: Record<string, { dataURL?: string; mimeType?: string }>;
}

function parseScene(raw: string): ExScene | null {
  try {
    const obj = JSON.parse(raw) as ExScene;
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

const opacityOf = (el: ExElement): number =>
  el.opacity === undefined ? 1 : Math.max(0, Math.min(1, el.opacity / 100));

/** Excalidraw 'transparent' background → no fill. */
const fillOf = (el: ExElement): string | null =>
  !el.backgroundColor || el.backgroundColor === 'transparent' ? null : el.backgroundColor;

/**
 * Map an element's stroke. Excalidraw stores its default stroke as `#1e1e1e`
 * and theme-inverts it at render (white on a dark canvas); we map that default
 * to DocuShark's AUTO sentinel so it stays visible on any theme. Explicit user
 * colours (reds/greens) pass through literally; an explicit transparent stroke
 * becomes no stroke.
 */
function strokeOf(el: ExElement): string | null {
  const c = el.strokeColor;
  if (!c || c === 'transparent') return null;
  return c.toLowerCase() === EXCALIDRAW_DEFAULT_STROKE ? AUTO_COLOR : c;
}

/** Common base for centre-anchored box shapes (rect/ellipse/diamond/image). */
function boxBase(el: ExElement) {
  return {
    id: nanoid(),
    x: el.x + el.width / 2,
    y: el.y + el.height / 2,
    rotation: el.angle ?? 0,
    opacity: opacityOf(el),
    locked: false,
    visible: true,
  };
}

const FONT_FAMILY: Record<number, string> = { 1: 'sans-serif', 2: 'sans-serif', 3: 'monospace' };

/** Decode a `data:<mime>;base64,<data>` URL to a Blob (jsdom-safe, no fetch). */
function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const header = dataUrl.slice(0, comma);
  const b64 = dataUrl.slice(comma + 1);
  const mime = /data:([^;]+)/.exec(header)?.[1] ?? 'application/octet-stream';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function importExcalidraw(raw: string): Promise<ImportResult> {
  const scene = parseScene(raw);
  const shapes: Shape[] = [];
  const warnings: ImportWarning[] = [];
  if (!scene || !Array.isArray(scene.elements)) {
    return { shapes, warnings: [{ kind: 'parse', detail: 'not a valid Excalidraw scene' }] };
  }

  const elements = scene.elements.filter((el) => !el.isDeleted);
  const elById = new Map(elements.map((el) => [el.id, el])); // excalidraw id → element
  const idMap = new Map<string, string>(); // excalidraw id → DocuShark shape id
  const boundText = new Map<string, ExElement>(); // containerId → text element
  const labelById = new Map<string, string>(); // DocuShark shape id → label text
  let skippedFreedraw = 0;
  const unsupported = new Map<string, number>();

  // Pass A: shapes (everything except arrows + container-bound text).
  for (const el of elements) {
    if (el.type === 'text' && el.containerId) {
      boundText.set(el.containerId, el);
      continue;
    }
    if (el.type === 'arrow') continue; // pass B

    const stroke = strokeOf(el);
    const strokeWidth = el.strokeWidth ?? DEFAULT_RECTANGLE.strokeWidth;

    switch (el.type) {
      case 'rectangle': {
        const base = boxBase(el);
        idMap.set(el.id, base.id);
        shapes.push({
          ...DEFAULT_RECTANGLE,
          ...base,
          type: 'rectangle',
          width: el.width,
          height: el.height,
          fill: fillOf(el),
          stroke,
          strokeWidth,
          cornerRadius: el.roundness ? 12 : 0,
        });
        break;
      }
      case 'ellipse': {
        const base = boxBase(el);
        idMap.set(el.id, base.id);
        shapes.push({
          ...DEFAULT_ELLIPSE,
          ...base,
          type: 'ellipse',
          radiusX: el.width / 2,
          radiusY: el.height / 2,
          fill: fillOf(el),
          stroke,
          strokeWidth,
        });
        break;
      }
      case 'diamond': {
        const base = boxBase(el);
        idMap.set(el.id, base.id);
        shapes.push({
          ...DEFAULT_LIBRARY_SHAPE,
          ...base,
          type: 'diamond',
          width: el.width,
          height: el.height,
          fill: fillOf(el),
          stroke,
          strokeWidth,
        });
        break;
      }
      case 'line': {
        const pts = el.points ?? [[0, 0], [el.width, el.height]];
        const a = pts[0] ?? [0, 0];
        const b = pts[pts.length - 1] ?? [el.width, el.height];
        const id = nanoid();
        idMap.set(el.id, id);
        shapes.push({
          ...DEFAULT_LINE,
          id,
          type: 'line',
          x: el.x + a[0],
          y: el.y + a[1],
          x2: el.x + b[0],
          y2: el.y + b[1],
          rotation: el.angle ?? 0,
          opacity: opacityOf(el),
          locked: false,
          visible: true,
          stroke,
          strokeWidth,
          startArrow: false,
          endArrow: false,
        });
        break;
      }
      case 'text': {
        // DocuShark TextShape x,y is the CENTRE (offset to top-left at render);
        // Excalidraw text x,y is top-left, so recentre like the box shapes.
        const base = boxBase(el);
        idMap.set(el.id, base.id);
        shapes.push({
          ...DEFAULT_TEXT,
          ...base,
          type: 'text',
          width: el.width,
          height: el.height,
          text: el.text ?? '',
          fontSize: el.fontSize ?? DEFAULT_TEXT.fontSize,
          fontFamily: FONT_FAMILY[el.fontFamily ?? 2] ?? 'sans-serif',
          textAlign: (el.textAlign as 'left' | 'center' | 'right') ?? 'left',
          fill: stroke, // text colour
        });
        break;
      }
      case 'image': {
        const fileEntry = el.fileId ? scene.files?.[el.fileId] : undefined;
        if (!fileEntry?.dataURL) {
          unsupported.set('image', (unsupported.get('image') ?? 0) + 1);
          break;
        }
        try {
          const blob = dataUrlToBlob(fileEntry.dataURL);
          const blobRef = await blobStorage.saveBlob(blob, `${el.id}.img`);
          const base = boxBase(el);
          idMap.set(el.id, base.id);
          const fileCategory: FileCategory = 'image';
          shapes.push({
            ...base,
            type: 'file',
            width: el.width,
            height: el.height,
            fill: DEFAULT_FILE_SHAPE.fill,
            stroke: DEFAULT_FILE_SHAPE.stroke,
            strokeWidth: DEFAULT_FILE_SHAPE.strokeWidth,
            blobRef,
            fileName: `${el.id}.img`,
            mimeType: fileEntry.mimeType ?? blob.type ?? 'image/png',
            fileSize: blob.size,
            fileCategory,
          });
        } catch {
          unsupported.set('image', (unsupported.get('image') ?? 0) + 1);
        }
        break;
      }
      case 'freedraw':
        skippedFreedraw++;
        break;
      default:
        unsupported.set(el.type, (unsupported.get(el.type) ?? 0) + 1);
    }
  }

  // Pass B: arrows → connectors, wired to mapped shape ids when bound.
  for (const el of elements) {
    if (el.type !== 'arrow') continue;
    const pts = el.points ?? [[0, 0], [el.width, el.height]];
    const a = pts[0] ?? [0, 0];
    const b = pts[pts.length - 1] ?? [el.width, el.height];
    const startPoint = { x: el.x + a[0], y: el.y + a[1] };
    const endPoint = { x: el.x + b[0], y: el.y + b[1] };

    const startEl = el.startBinding?.elementId ? elById.get(el.startBinding.elementId) : undefined;
    const endEl = el.endBinding?.elementId ? elById.get(el.endBinding.elementId) : undefined;
    const startId = startEl ? idMap.get(startEl.id) : undefined;
    const endId = endEl ? idMap.get(endEl.id) : undefined;

    // Resolve each bound endpoint to the boundary anchor facing the OTHER end,
    // so the arrow hitches at the shape's edge instead of its centre (JP-196).
    const startAnchor =
      startId && startEl
        ? nearestEdgeAnchor(boxFromTopLeft(startEl.x, startEl.y, startEl.width, startEl.height, startEl.angle ?? 0), endPoint)
        : undefined;
    const endAnchor =
      endId && endEl
        ? nearestEdgeAnchor(boxFromTopLeft(endEl.x, endEl.y, endEl.width, endEl.height, endEl.angle ?? 0), startPoint)
        : undefined;

    shapes.push({
      ...DEFAULT_CONNECTOR,
      id: nanoid(),
      type: 'connector',
      x: startPoint.x,
      y: startPoint.y,
      x2: endPoint.x,
      y2: endPoint.y,
      rotation: 0,
      opacity: opacityOf(el),
      locked: false,
      visible: true,
      stroke: strokeOf(el),
      strokeWidth: el.strokeWidth ?? DEFAULT_CONNECTOR.strokeWidth,
      startArrow: false,
      endArrow: true,
      ...(startId ? { startShapeId: startId } : {}),
      ...(startAnchor ? { startAnchor } : {}),
      ...(endId ? { endShapeId: endId } : {}),
      ...(endAnchor ? { endAnchor } : {}),
    });
  }

  // Pass C: apply container-bound text as the container shape's label.
  for (const [containerId, textEl] of boundText) {
    const shapeId = idMap.get(containerId);
    if (!shapeId) continue;
    labelById.set(shapeId, textEl.text ?? '');
  }
  if (labelById.size > 0) {
    for (const shape of shapes) {
      const label = labelById.get(shape.id);
      if (label !== undefined) (shape as { label?: string }).label = label;
    }
  }

  // Aggregate warnings.
  if (skippedFreedraw > 0) {
    warnings.push({ kind: 'freedraw', detail: `${skippedFreedraw} freehand drawing(s) skipped`, count: skippedFreedraw });
  }
  for (const [kind, count] of unsupported) {
    warnings.push({ kind, detail: `${count} unsupported "${kind}" element(s)`, count });
  }

  return { shapes, warnings };
}

export const excalidrawAdapter: ImportAdapter = {
  id: 'excalidraw',
  label: 'Excalidraw',
  canImport: (raw) => parseScene(raw)?.type === 'excalidraw',
  import: importExcalidraw,
};
