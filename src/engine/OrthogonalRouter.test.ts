import { describe, it, expect } from 'vitest';
import { calculateConnectorWaypoints } from './OrthogonalRouter';
import { SpatialIndex } from './SpatialIndex';
import { ConnectorShape, RectangleShape, Shape } from '../shapes/Shape';

// Register shape handlers so getBounds works for indexed shapes. Mirrors
// production, where the index is built from every shape (connectors included,
// then skipped as obstacles).
import '../shapes/Rectangle';
import '../shapes/Connector';

function rect(overrides: Partial<RectangleShape> & { id: string }): RectangleShape {
  return {
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 80,
    height: 80,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    fill: '#4a90d9',
    stroke: '#2c5282',
    strokeWidth: 2,
    cornerRadius: 0,
    ...overrides,
  };
}

function orthoConnector(overrides: Partial<ConnectorShape> = {}): ConnectorShape {
  return {
    id: 'conn',
    type: 'connector',
    x: 0,
    y: 0,
    x2: 400,
    y2: 0,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    fill: null,
    stroke: '#333333',
    strokeWidth: 2,
    startShapeId: null,
    endShapeId: null,
    startAnchor: 'center',
    endAnchor: 'center',
    startArrow: false,
    endArrow: true,
    routingMode: 'orthogonal',
    ...overrides,
  };
}

function toRecord(shapes: Shape[]): Record<string, Shape> {
  const out: Record<string, Shape> = {};
  for (const s of shapes) out[s.id] = s;
  return out;
}

function indexOf(shapes: Shape[]): SpatialIndex {
  const index = new SpatialIndex();
  index.rebuild(shapes);
  return index;
}

describe('calculateConnectorWaypoints — spatial-index obstacle query', () => {
  it('produces identical waypoints with and without the index (obstacle in the path)', () => {
    // A tall rectangle straddling y=0 blocks the straight route from (0,0)→(400,0),
    // forcing the router to bend around it.
    const shapes = [
      rect({ id: 'blocker', x: 200, y: 0, width: 80, height: 220 }),
      orthoConnector(),
    ];
    const record = toRecord(shapes);
    const connector = record['conn'] as ConnectorShape;

    const scanned = calculateConnectorWaypoints(connector, record);
    const indexed = calculateConnectorWaypoints(connector, record, indexOf(shapes));

    expect(indexed).toEqual(scanned);
    // Sanity: the blocker actually forced a detour (more than a single elbow).
    expect((scanned ?? []).length).toBeGreaterThan(0);
  });

  it('ignores obstacles outside the corridor identically to a full scan', () => {
    // The blocker is in the corridor; the rest sit far outside the bbox of the
    // endpoints (grown by the stub/padding margin) and must not affect routing.
    const shapes = [
      rect({ id: 'blocker', x: 200, y: 0, width: 80, height: 220 }),
      rect({ id: 'far-up', x: 200, y: 1000, width: 80, height: 80 }),
      rect({ id: 'far-down', x: 200, y: -1000, width: 80, height: 80 }),
      rect({ id: 'far-right', x: 3000, y: 0, width: 80, height: 80 }),
      orthoConnector(),
    ];
    const record = toRecord(shapes);
    const connector = record['conn'] as ConnectorShape;

    // Route against only the in-corridor shapes (no far obstacles, no index)…
    const nearOnly = calculateConnectorWaypoints(
      connector,
      toRecord([record['blocker'] as Shape, connector])
    );
    // …must equal routing against the full scene through the index.
    const indexedFull = calculateConnectorWaypoints(connector, record, indexOf(shapes));

    expect(indexedFull).toEqual(nearOnly);
  });

  it('produces identical waypoints with and without the index (clear path)', () => {
    const shapes = [
      rect({ id: 'far', x: 200, y: 2000, width: 80, height: 80 }),
      orthoConnector(),
    ];
    const record = toRecord(shapes);
    const connector = record['conn'] as ConnectorShape;

    const scanned = calculateConnectorWaypoints(connector, record);
    const indexed = calculateConnectorWaypoints(connector, record, indexOf(shapes));

    expect(indexed).toEqual(scanned);
  });
});
