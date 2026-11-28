/**
 * "Rebuild all connector routes" is its own undo step (found while
 * investigating DSK-12). The toolbar called the store action directly, with no
 * history step, though the store says its callers wrap it in one. So in a local
 * document, undo after a rebuild restored the step before it and also reverted
 * the edit made just before. The collaborative case is pinned in
 * `connectorRebuildUndo.ydoc.test.ts`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../shapes/Rectangle';
import '../shapes/Connector';
import type { Shape } from '../shapes/Shape';
import { useHistoryStore } from '../store/historyStore';
import { useDocumentStore } from '../store/documentStore';
import { useCollaborationStore } from '../collaboration/collaborationStore';
import { rebuildConnectorRoutes } from './selectionLayout';

const __dirname = dirname(fileURLToPath(import.meta.url));

function rect(id: string, x: number, y: number): Shape {
  return {
    id,
    type: 'rectangle',
    x,
    y,
    width: 80,
    height: 40,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    fill: '#fff',
    stroke: '#000',
    strokeWidth: 1,
    cornerRadius: 0,
  } as unknown as Shape;
}

function connector(id: string, from: string, to: string): Shape {
  return {
    id,
    type: 'connector',
    x: 0,
    y: 0,
    x2: 0,
    y2: 0,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    fill: null,
    stroke: '#000',
    strokeWidth: 1,
    startShapeId: from,
    endShapeId: to,
    startAnchor: 'right',
    endAnchor: 'left',
    startArrow: false,
    endArrow: true,
    routingMode: 'orthogonal',
    waypoints: [],
  } as unknown as Shape;
}

/** Past the history store's push debounce, as a real click on the toolbar is. */
const later = () => new Promise((r) => setTimeout(r, 350));

beforeEach(() => {
  useHistoryStore.setState({ pageHistory: {}, activePageId: 'page-1', isTracking: true });
  useDocumentStore.setState({ shapes: {}, shapeOrder: [] });
  useCollaborationStore.setState({ isActive: false });
});

describe('rebuilding every connector route', () => {
  it('is its own undo step: undo after it keeps the edit made just before', async () => {
    const doc = useDocumentStore.getState();
    doc.addShapes([rect('a', 0, 0), rect('b', 300, 0), connector('c', 'a', 'b')]);
    doc.rebuildAllConnectorRoutes();

    // An edit, then the rebuild.
    useHistoryStore.getState().push('Move');
    doc.updateShape('b', { y: 200 } as Partial<Shape>);
    await later();
    const beforeRebuild = JSON.stringify(useDocumentStore.getState().shapes['c']);
    rebuildConnectorRoutes();
    expect(JSON.stringify(useDocumentStore.getState().shapes['c'])).not.toBe(beforeRebuild);

    useHistoryStore.getState().undo();

    // Only the rebuild is undone: the move stays, the connector is as it was.
    expect(useDocumentStore.getState().shapes['b']?.y).toBe(200);
    expect(JSON.stringify(useDocumentStore.getState().shapes['c'])).toBe(beforeRebuild);
  });

  it('is what the canvas toolbar runs', () => {
    // The toolbar's handler lives in App.tsx; it must run the command, not the
    // bare store action.
    const app = readFileSync(resolve(__dirname, '../ui/App.tsx'), 'utf-8');
    const handler = app.slice(app.indexOf('const handleRebuildConnectors'), app.indexOf('const handleRebuildConnectors') + 200);
    expect(handler).toContain('rebuildConnectorRoutes()');
    expect(app).not.toMatch(/state\.rebuildAllConnectorRoutes/);
  });
});
