import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../shapes/Rectangle'; // registers the 'rectangle' handler (for bounds/framing)
import { applyImportResult, importDiagramText, importDiagramFiles } from './importPipeline';
import type { ImportContext } from './FileImportService';
import { registerImportAdapter, unregisterImportAdapter, type ImportAdapter } from '../shapes/import/ImportAdapter';
import { DEFAULT_RECTANGLE, type Shape } from '../shapes/Shape';
import { useDocumentStore } from '../store/documentStore';
import { useSessionStore } from '../store/sessionStore';

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
  });

  describe('applyImportResult', () => {
    it('adds shapes, selects, frames, and reports', () => {
      const { ctx, zoomToFit, requestRender } = makeCtx();
      const report = applyImportResult('test', { shapes: [rect('a', 0), rect('b', 300)] }, ctx);

      const shapes = useDocumentStore.getState().shapes;
      expect(shapes['a']).toBeTruthy();
      expect(shapes['b']).toBeTruthy();
      expect(useSessionStore.getState().getSelectedIds().sort()).toEqual(['a', 'b']);
      expect(zoomToFit).toHaveBeenCalled();
      expect(requestRender).toHaveBeenCalled();
      expect(report.shapeCount).toBe(2);
    });

    it('surfaces adapter warnings in the report', () => {
      const { ctx } = makeCtx();
      const report = applyImportResult('test', {
        shapes: [rect('a', 0)],
        warnings: [{ kind: 'freedraw', detail: '2 skipped', count: 2 }],
      }, ctx);
      expect(report.warnings).toHaveLength(1);
      expect(report.warnings[0]!.kind).toBe('freedraw');
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
