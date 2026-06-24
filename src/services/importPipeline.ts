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
import { mutateDocument } from '../store/writeProvenance';
import { useSessionStore } from '../store/sessionStore';
import { useShapeLibraryStore } from '../store/shapeLibraryStore';
import { useNotificationStore } from '../store/notificationStore';
import { pushHistory } from '../store/historyStore';
import type { Vec2 } from '../math/Vec2';
import { importFiles, type ImportContext } from './FileImportService';

/**
 * File extensions that route to diagram import rather than file-embed. Only the
 * formats with a registered adapter (see registerImportAdapters.ts) belong here;
 * an extension without an adapter would hit a dead import path, so unsupported
 * formats (e.g. PlantUML .puml) fall through to the normal file-embed instead.
 */
export const DIAGRAM_EXTENSIONS = [
  '.excalidraw',
  '.drawio',
  '.mmd',
  '.mermaid',
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
 * Above this shape count an import is inserted in chunks across animation
 * frames (with a progress toast) so the main thread stays responsive and the
 * diagram materializes progressively instead of freezing the UI on one giant
 * synchronous write. At or below it, the single-shot path keeps small imports
 * instant. (JP-305 Slice C.)
 */
export const IMPORT_CHUNK_SIZE = 300;

/** Gap left between an import and existing content when nudging clear of it. */
const PLACEMENT_GAP = 80;

/**
 * Shift `shapes` in place so the import lands centered on the current viewport
 * — where the user is looking — instead of at the world origin the adapters
 * emit to. When that would overlap existing canvas content, drop the import
 * into clear space just below that content so it doesn't bury anything
 * (best-effort; an empty canvas / empty view is left exactly centered).
 */
function placeImport(shapes: Shape[], ctx: ImportContext): void {
  const importBounds = combinedBounds(shapes);
  if (!importBounds) return;

  const target = ctx.engine.camera.getViewportCenter();
  let dx = target.x - importBounds.centerX;
  let dy = target.y - importBounds.centerY;

  const existing = combinedBounds(Object.values(useDocumentStore.getState().shapes));
  if (existing) {
    const placed = new Box(
      importBounds.minX + dx,
      importBounds.minY + dy,
      importBounds.maxX + dx,
      importBounds.maxY + dy,
    );
    if (placed.intersects(existing)) {
      // Push straight down past the existing content's bottom edge.
      dy += existing.maxY + PLACEMENT_GAP - placed.minY;
    }
  }

  if (dx === 0 && dy === 0) return;
  for (const shape of shapes) translateShape(shape, dx, dy);
}

/** Shift a shape and any endpoint/waypoint geometry by (dx, dy), in place. */
function translateShape(shape: Shape, dx: number, dy: number): void {
  shape.x += dx;
  shape.y += dy;
  const geo = shape as Shape & {
    x2?: number;
    y2?: number;
    waypoints?: Array<{ x: number; y: number }>;
  };
  if (typeof geo.x2 === 'number') geo.x2 += dx;
  if (typeof geo.y2 === 'number') geo.y2 += dy;
  if (geo.waypoints) geo.waypoints = geo.waypoints.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

/** Yield to the browser so it can paint a chunk before the next one lands. */
function yieldToFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/**
 * Insert `shapes` as one undoable step. Small imports go in a single write;
 * large ones are chunked across frames with a live progress toast. Either way
 * connectors are routed once, after every node is present, so the router sees
 * the full obstacle set.
 *
 * Each chunk is its own synchronous `mutateDocument('programmatic', …)` call:
 * provenance is an ambient flag that does NOT survive the `await` between
 * chunks (see the writeProvenance CONTRACT), so the write must be tagged inside
 * each synchronous step, not around the whole async loop.
 */
async function insertShapes(shapes: Shape[]): Promise<void> {
  if (shapes.length <= IMPORT_CHUNK_SIZE) {
    mutateDocument('programmatic', () => {
      useDocumentStore.getState().addShapes(shapes);
      useDocumentStore.getState().rebuildAllConnectorRoutes();
    });
    return;
  }

  const notifications = useNotificationStore.getState();
  const total = shapes.length;
  const progressId = notifications.notify({
    message: `Importing 0/${total}…`,
    severity: 'info',
    duration: 0,
  });

  try {
    for (let offset = 0; offset < total; offset += IMPORT_CHUNK_SIZE) {
      const chunk = shapes.slice(offset, offset + IMPORT_CHUNK_SIZE);
      mutateDocument('programmatic', () => {
        useDocumentStore.getState().addShapes(chunk);
      });
      const done = Math.min(offset + IMPORT_CHUNK_SIZE, total);
      notifications.update(progressId, { message: `Importing ${done}/${total}…` });
      await yieldToFrame();
    }
    mutateDocument('programmatic', () => {
      useDocumentStore.getState().rebuildAllConnectorRoutes();
    });
  } finally {
    notifications.dismiss(progressId);
  }
}

/**
 * Insert a parsed result onto the canvas as one undoable step: register any new
 * shape kinds, place the import at the viewport (not the world origin), batch-
 * add the shapes (chunked for large imports), select + frame them, and notify.
 */
export async function applyImportResult(
  adapterId: string,
  result: ImportResult,
  ctx: ImportContext,
): Promise<ImportReport> {
  const { shapes, libraryDefs, warnings = [] } = result;

  // One snapshot before any insertion → one undo reverts the whole import,
  // however many chunks it lands in.
  pushHistory(`Import ${adapterId}`);

  if (libraryDefs && libraryDefs.length > 0) {
    useShapeLibraryStore.getState().registerShapes(libraryDefs);
  }

  placeImport(shapes, ctx);

  // An import is app-generated content, not a keystroke — the writes inside
  // insertShapes route through the provenance entrypoint (JP-192) so they
  // propagate to collaborators as `programmatic`, not as user edits.
  await insertShapes(shapes);

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
    // `await` (not bare return) so a rejection from the async insert is caught
    // here and surfaced as an error toast, not leaked as an unhandled rejection.
    return await applyImportResult(adapter.id, result, ctx);
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
