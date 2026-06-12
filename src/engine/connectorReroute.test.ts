import { describe, it, expect } from 'vitest';
import {
  collectChangedShapes,
  isConnectorAffected,
  connectorRouteBox,
} from './connectorReroute';
import { ConnectorShape, RectangleShape, Shape } from '../shapes/Shape';

// Register handlers so getBounds works for changed-shape obstacle boxes.
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

function connector(overrides: Partial<ConnectorShape> & { id: string }): ConnectorShape {
  return {
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
    stroke: '#333',
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

describe('collectChangedShapes', () => {
  it('detects a moved shape and records both old and new bounds', () => {
    const prev = toRecord([rect({ id: 'r1', x: 0, y: 0 })]);
    const next = toRecord([rect({ id: 'r1', x: 500, y: 0 })]);

    const changed = collectChangedShapes(prev, next);

    expect(changed.ids.has('r1')).toBe(true);
    expect(changed.count).toBe(1);
    // Old position (~0,0) and new position (~500,0) both recorded as obstacles.
    expect(changed.obstacleBoxes.length).toBe(2);
  });

  it('detects added and removed shapes', () => {
    const keep = rect({ id: 'keep' }); // same reference in both states = unchanged
    const prev = toRecord([keep, rect({ id: 'gone' })]);
    const next = toRecord([keep, rect({ id: 'added' })]);

    const changed = collectChangedShapes(prev, next);

    expect(changed.ids.has('added')).toBe(true);
    expect(changed.ids.has('gone')).toBe(true);
    expect(changed.ids.has('keep')).toBe(false);
    expect(changed.count).toBe(2);
  });

  it('ignores unchanged shapes (reference equality)', () => {
    const shared = rect({ id: 'r1' });
    const changed = collectChangedShapes(toRecord([shared]), toRecord([shared]));

    expect(changed.count).toBe(0);
    expect(changed.obstacleBoxes).toHaveLength(0);
  });

  it('records changed connectors in ids but not as obstacles', () => {
    const prev = toRecord([connector({ id: 'c1', x: 0 })]);
    const next = toRecord([connector({ id: 'c1', x: 10 })]);

    const changed = collectChangedShapes(prev, next);

    expect(changed.ids.has('c1')).toBe(true);
    expect(changed.obstacleBoxes).toHaveLength(0); // connectors aren't obstacles
  });
});

describe('isConnectorAffected', () => {
  it('is affected when the connector itself changed', () => {
    const conn = connector({ id: 'c1' });
    const changed = collectChangedShapes(
      toRecord([connector({ id: 'c1', x: 0 })]),
      toRecord([connector({ id: 'c1', x: 5 })])
    );
    expect(isConnectorAffected(conn, changed)).toBe(true);
  });

  it('is affected when a bound shape changed', () => {
    const conn = connector({ id: 'c1', startShapeId: 'r1' });
    const changed = collectChangedShapes(
      toRecord([rect({ id: 'r1', x: 0 })]),
      toRecord([rect({ id: 'r1', x: 40 })])
    );
    expect(isConnectorAffected(conn, changed)).toBe(true);
  });

  it('is affected when an obstacle moves onto its route', () => {
    // Connector runs straight along y=0 from x=0..400 (no waypoints).
    const conn = connector({ id: 'c1' });
    // An unrelated rect moves to sit on the route at (200, 0).
    const changed = collectChangedShapes(
      toRecord([rect({ id: 'blocker', x: 200, y: 600 })]),
      toRecord([rect({ id: 'blocker', x: 200, y: 0 })])
    );
    expect(isConnectorAffected(conn, changed)).toBe(true);
  });

  it('is NOT affected by an unrelated, far-away change', () => {
    const conn = connector({ id: 'c1' });
    const changed = collectChangedShapes(
      toRecord([rect({ id: 'far', x: 200, y: 1000 })]),
      toRecord([rect({ id: 'far', x: 260, y: 1000 })])
    );
    expect(isConnectorAffected(conn, changed)).toBe(false);
  });
});

describe('connectorRouteBox', () => {
  it('encloses endpoints and waypoints', () => {
    const conn = connector({
      id: 'c1',
      x: 0,
      y: 0,
      x2: 400,
      y2: 0,
      waypoints: [
        { x: 100, y: 200 },
        { x: 300, y: 200 },
      ],
    });
    const box = connectorRouteBox(conn);
    expect(box.minX).toBe(0);
    expect(box.minY).toBe(0);
    expect(box.maxX).toBe(400);
    expect(box.maxY).toBe(200);
  });
});
