/**
 * Diagram import pipeline (JP-164) — turns an `ImportAdapter`'s parsed result
 * into shapes on the canvas as ONE undoable step, frames them, and reports
 * anything that couldn't be converted ("safe parsing").
 *
 * The engine's `documentStore` subscription (`Engine.ts`) rebuilds the spatial
 * index + repaints on shape changes, so the pipeline only mutates the store
 * (plus an explicit `requestRender`) and frames via the camera.
 */

import { Box } from '../math/Box';
import type { Shape } from '../shapes/Shape';
import { shapeRegistry } from '../shapes/ShapeRegistry';
import { findImportAdapter, type ImportResult, type ImportWarning } from '../shapes/import/ImportAdapter';
import { useDocumentStore } from '../store/documentStore';
import { useSessionStore } from '../store/sessionStore';
import { useShapeLibraryStore } from '../store/shapeLibraryStore';
import { useNotificationStore } from '../store/notificationStore';
import { pushHistory } from '../store/historyStore';
import type { Vec2 } from '../math/Vec2';
import { importFiles, type ImportContext } from './FileImportService';

/** File extensions that route to diagram import rather than file-embed. */
export const DIAGRAM_EXTENSIONS = [
  '.excalidraw',
  '.drawio',
  '.mmd',
  '.mermaid',
  '.puml',
  '.plantuml',
];

export interface ImportReport {
  adapterId: string;
  shapeCount: number;
  warnings: ImportWarning[];
}

/** Union of the world-space bounds of all shapes (for framing). */
function combinedBounds(shapes: Shape[]): Box | null {
  let box: Box | null = null;
  for (const shape of shapes) {
    if (!shapeRegistry.hasHandler(shape.type)) continue;
    const b = shapeRegistry.getHandler(shape.type).getBounds(shape);
    box = box ? box.union(b) : b;
  }
  return box;
}

function reportImport(shapeCount: number, warnings: ImportWarning[]): void {
  const notifications = useNotificationStore.getState();
  if (shapeCount === 0 && warnings.length === 0) {
    notifications.warning('Nothing to import from that file');
    return;
  }
  const noun = (n: number) => `${n} object${n === 1 ? '' : 's'}`;
  if (warnings.length === 0) {
    notifications.success(`Imported ${noun(shapeCount)}`);
    return;
  }
  const skipped = warnings.reduce((n, w) => n + (w.count ?? 1), 0);
  const detail = warnings.map((w) => w.detail).join('; ');
  notifications.warning(`Imported ${noun(shapeCount)}; ${skipped} couldn't be converted: ${detail}`);
}

/**
 * Insert a parsed result onto the canvas as one undoable step: register any new
 * shape kinds, batch-add the shapes, select + frame them, and notify the user.
 */
export function applyImportResult(
  adapterId: string,
  result: ImportResult,
  ctx: ImportContext,
): ImportReport {
  const { shapes, libraryDefs, warnings = [] } = result;

  pushHistory(`Import ${adapterId}`);

  if (libraryDefs && libraryDefs.length > 0) {
    useShapeLibraryStore.getState().registerShapes(libraryDefs);
  }

  useDocumentStore.getState().addShapes(shapes);

  const ids = shapes.map((s) => s.id);
  if (ids.length > 0) {
    useSessionStore.getState().select(ids);
    useSessionStore.getState().setActiveTool('select');
  }

  const bounds = combinedBounds(shapes);
  if (bounds) ctx.engine.camera.zoomToFit(bounds, 80);
  ctx.engine.requestRender();

  reportImport(ids.length, warnings);
  return { adapterId, shapeCount: ids.length, warnings };
}

/**
 * Parse + import source text via the first matching registered adapter.
 * Returns the report, or `null` if no adapter recognizes the text (so the
 * caller can fall back to embedding the file).
 */
export async function importDiagramText(raw: string, ctx: ImportContext): Promise<ImportReport | null> {
  const adapter = findImportAdapter(raw);
  if (!adapter) return null;
  try {
    const result = await adapter.import(raw);
    return applyImportResult(adapter.id, result, ctx);
  } catch (err) {
    useNotificationStore
      .getState()
      .error(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    return { adapterId: adapter.id, shapeCount: 0, warnings: [] };
  }
}

/**
 * Import any diagram files (by extension + adapter sniff) and return the files
 * that were NOT diagrams, for the caller to embed as usual. Keeps the existing
 * file-embed path intact — we branch, not replace.
 */
export async function importDiagramFiles(files: File[], ctx: ImportContext): Promise<File[]> {
  const passthrough: File[] = [];
  for (const file of files) {
    const lower = file.name.toLowerCase();
    if (!DIAGRAM_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
      passthrough.push(file);
      continue;
    }
    const text = await file.text();
    const report = await importDiagramText(text, ctx);
    // Extension looked like a diagram but no adapter claimed it → embed instead.
    if (report === null) passthrough.push(file);
  }
  return passthrough;
}

/**
 * Single entry point for dropped/picked files: import any diagrams, then embed
 * the rest via the existing file-embed path. Keeps embedding behavior intact.
 */
export async function routeImportFiles(
  files: File[],
  worldPosition: Vec2,
  ctx: ImportContext,
): Promise<void> {
  const remaining = await importDiagramFiles(files, ctx);
  if (remaining.length > 0) await importFiles(remaining, worldPosition, ctx);
}
