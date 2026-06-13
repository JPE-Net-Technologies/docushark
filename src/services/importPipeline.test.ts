import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../shapes/Rectangle'; // registers the 'rectangle' handler (for bounds/framing)
import { applyImportResult, importDiagramText, importDiagramFiles, IMPORT_CHUNK_SIZE } from './importPipeline';
import type { ImportContext } from './FileImportService';
import { registerImportAdapter, unregisterImportAdapter, type ImportAdapter } from '../shapes/import/ImportAdapter';
import { DEFAULT_RECTANGLE, type Shape } from '../shapes/Shape';
import { useDocumentStore } from '../store/documentStore';
import { useSessionStore } from '../store/sessionStore';
import { useNotificationStore } from '../store/notificationStore';

function rect(id: string, x: number): Shape {
  return { ...DEFAULT_RECTANGLE, id, type: 'rectangle', x, y: 0, width: 100, height: 60 } as Shape;
}

function makeCtx() {
  const zoomToFit = vi.fn();
  const requestRender = vi.fn();
  const ctx: ImportContext = {
    engine: {
      camera: {
        screenToWorld: (p) => p,
        getViewportCenter: () => ({ x: 0, y: 0 }) as never,
        zoomToFit,
      },
      spatialIndex: { insert: vi.fn() },
      requestRender,
    },
  };
  return { ctx, zoomToFit, requestRender };
}

const graphAdapter: ImportAdapter = {
  id: 'fake-graph',
  label: 'Fake',
  canImport: (raw) => raw.trimStart().startsWith('graph'),
  import: (raw) =>
    Promise.resolve({
      shapes: [rect('g1', 0), rect('g2', 200)],
      warnings: raw.includes('warn') ? [{ kind: 'x', detail: '1 thing skipped', count: 1 }] : [],
    }),
};

describe('importPipeline', () => {
  beforeEach(() => {
    useDocumentStore.getState().loadSnapshot({ shapes: {}, shapeOrder: [], version: 1 });
    useNotificationStore.getState().dismissAll();
  });

  describe('applyImportResult', () => {
    it('adds shapes, selects, frames, and reports', async () => {
      const { ctx, zoomToFit, requestRender } = makeCtx();
      const report = await applyImportResult('test', { shapes: [rect('a', 0), rect('b', 300)] }, ctx);

      const shapes = useDocumentStore.getState().shapes;
      expect(shapes['a']).toBeTruthy();
      expect(shapes['b']).toBeTruthy();
      expect(useSessionStore.getState().getSelectedIds().sort()).toEqual(['a', 'b']);
      expect(zoomToFit).toHaveBeenCalled();
      expect(requestRender).toHaveBeenCalled();
      expect(report.shapeCount).toBe(2);
    });

    it('surfaces adapter warnings in the report', async () => {
      const { ctx } = makeCtx();
      const report = await applyImportResult('test', {
        shapes: [rect('a', 0)],
        warnings: [{ kind: 'freedraw', detail: '2 skipped', count: 2 }],
      }, ctx);
      expect(report.warnings).toHaveLength(1);
      expect(report.warnings[0]!.kind).toBe('freedraw');
    });

    it('centers the import on the viewport, not the world origin (JP-305)', async () => {
      const { ctx } = makeCtx(); // mock viewport center is (0, 0)
      // Adapter emits the diagram far from the origin (x spans 1000..1300).
      await applyImportResult('test', { shapes: [rect('a', 1000), rect('b', 1300)] }, ctx);
      const shapes = useDocumentStore.getState().shapes;
      // Recentered so the import's midpoint sits at the viewport center.
      const midX = (shapes['a']!.x + shapes['b']!.x) / 2;
      expect(Math.round(midX)).toBe(0);
    });

    it('drops the import clear of existing content when it would overlap (JP-305)', async () => {
      // Existing shape sitting at the viewport center (bounds y: -30..30).
      useDocumentStore.getState().loadSnapshot({
        shapes: { e: rect('e', 0) },
        shapeOrder: ['e'],
        version: 1,
      });
      const { ctx } = makeCtx();
      await applyImportResult('test', { shapes: [rect('a', 0)] }, ctx);
      const a = useDocumentStore.getState().shapes['a']!;
      // Pushed below the existing content's bottom edge (30) by the gap, so
      // its own top edge (a.y - 30) clears it — no overlap.
      expect(a.y - 30).toBeGreaterThan(30);
    });

    it('inserts a large import in chunks and clears the progress toast (JP-305)', async () => {
      const { ctx } = makeCtx();
      const many = Array.from({ length: IMPORT_CHUNK_SIZE + 50 }, (_, i) => rect(`n${i}`, i * 5));
      await applyImportResult('test', { shapes: many }, ctx);

      expect(Object.keys(useDocumentStore.getState().shapes)).toHaveLength(IMPORT_CHUNK_SIZE + 50);
      // The transient "Importing N/M…" toast is gone; only the final result
      // notification remains.
      const messages = useNotificationStore.getState().notifications.map((n) => n.message);
      expect(messages.some((m) => m.startsWith('Importing'))).toBe(false);
    });
  });

  describe('importDiagramText', () => {
    beforeEach(() => registerImportAdapter(graphAdapter));
    afterEach(() => {
      unregisterImportAdapter('fake-graph');
    });

    it('imports when an adapter matches', async () => {
      const { ctx } = makeCtx();
      const report = await importDiagramText('graph TD; A-->B', ctx);
      expect(report).not.toBeNull();
      expect(report!.shapeCount).toBe(2);
      expect(Object.keys(useDocumentStore.getState().shapes)).toHaveLength(2);
    });

    it('returns null when no adapter recognizes the text', async () => {
      const { ctx } = makeCtx();
      expect(await importDiagramText('just some prose', ctx)).toBeNull();
    });
  });

  describe('importDiagramFiles', () => {
    beforeEach(() => registerImportAdapter(graphAdapter));
    afterEach(() => {
      unregisterImportAdapter('fake-graph');
    });

    // jsdom's File has no .text(); the pipeline only reads name + text().
    const fakeFile = (name: string, content: string): File =>
      ({ name, text: () => Promise.resolve(content) }) as unknown as File;

    it('imports diagram files and returns non-diagram files for embed', async () => {
      const { ctx } = makeCtx();
      const diagram = fakeFile('flow.mmd', 'graph TD; A-->B');
      const image = fakeFile('photo.png', 'binary');
      const passthrough = await importDiagramFiles([diagram, image], ctx);
      expect(passthrough.map((f) => f.name)).toEqual(['photo.png']);
      expect(Object.keys(useDocumentStore.getState().shapes)).toHaveLength(2);
    });

    it('passes a diagram-extension file through when no adapter claims it', async () => {
      const { ctx } = makeCtx();
      const notReally = fakeFile('note.mmd', 'hello world');
      const passthrough = await importDiagramFiles([notReally], ctx);
      expect(passthrough.map((f) => f.name)).toEqual(['note.mmd']);
    });
  });
});
