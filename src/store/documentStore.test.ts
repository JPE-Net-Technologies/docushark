import { describe, it, expect, beforeEach } from 'vitest';
import {
  useDocumentStore,
  getShapesByIds,
  shapeExists,
} from './documentStore';
import { getProvenance } from './writeProvenance';
import { RectangleShape, type ConnectorShape, type AnchorPosition, DEFAULT_CONNECTOR } from '../shapes/Shape';
import '../shapes/Rectangle'; // registers the handler computeAutoLayout reads for sizing

/**
 * Create a test rectangle with default properties.
 */
function createTestRect(overrides: Partial<RectangleShape> = {}): RectangleShape {
  return {
    id: 'test-rect',
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 100,
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

describe('Document Store', () => {
  beforeEach(() => {
    // Clear the store before each test
    useDocumentStore.getState().clear();
  });

  describe('write provenance (JP-178/JP-192)', () => {
    it('runs loadSnapshot and clear under load provenance, edits under user-edit', () => {
      const store = useDocumentStore.getState();
      const seen: string[] = [];
      const unsub = useDocumentStore.subscribe(() => {
        seen.push(getProvenance());
      });

      store.addShape(createTestRect({ id: 'a' })); // user-edit
      store.loadSnapshot({ shapes: {}, shapeOrder: [], version: 1 }); // load
      store.addShape(createTestRect({ id: 'b' })); // user-edit
      store.clear(); // load
      unsub();

      expect(seen).toEqual(['user-edit', 'load', 'user-edit', 'load']);
      // Provenance is restored after each bulk op.
      expect(getProvenance()).toBe('user-edit');
    });

    it('defaults to user-edit (no bulk op in flight)', () => {
      expect(getProvenance()).toBe('user-edit');
    });
  });

  describe('autoLayoutShapes (JP-305 Slice D)', () => {
    function connector(id: string, from: string, to: string): ConnectorShape {
      return {
        ...DEFAULT_CONNECTOR,
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
        startShapeId: from,
        endShapeId: to,
        routingMode: 'orthogonal',
      } as ConnectorShape;
    }

    it('repositions a connected selection into ranks and reroutes', () => {
      const store = useDocumentStore.getState();
      store.addShapes([
        createTestRect({ id: 'a', x: 500, y: 0 }),
        createTestRect({ id: 'b', x: 0, y: 300 }),
        connector('c1', 'a', 'b'),
      ]);

      store.autoLayoutShapes(['a', 'b']);

      const after = useDocumentStore.getState().shapes;
      // a now ranks above b (TB flow), and the connector got routed waypoints.
      expect(after['a']!.y).toBeLessThan(after['b']!.y);
      expect((after['c1'] as ConnectorShape).waypoints).toBeDefined();
    });

    it('is a no-op for a selection with fewer than two nodes', () => {
      const store = useDocumentStore.getState();
      store.addShape(createTestRect({ id: 'lone', x: 42, y: 7 }));
      store.autoLayoutShapes(['lone']);
      const s = useDocumentStore.getState().shapes['lone']!;
      expect(s.x).toBe(42);
      expect(s.y).toBe(7);
    });
  });

  describe('connector re-anchoring on re-layout (JP-321)', () => {
    function orthConnector(
      id: string,
      from: string,
      to: string,
      startAnchor: AnchorPosition,
      endAnchor: AnchorPosition
    ): ConnectorShape {
      return {
        ...DEFAULT_CONNECTOR,
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
        startShapeId: from,
        endShapeId: to,
        startAnchor,
        endAnchor,
        routingMode: 'orthogonal',
        waypoints: [{ x: 0, y: 0 }],
      } as ConnectorShape;
    }

    it('rebuildAllConnectorRoutes re-seats stale anchors after a move, idempotently', () => {
      const store = useDocumentStore.getState();
      // b below a → (bottom, top) is correct initially (as generate_diagram bakes it).
      store.addShapes([
        createTestRect({ id: 'a', x: 0, y: 0 }),
        createTestRect({ id: 'b', x: 0, y: 300 }),
        orthConnector('c1', 'a', 'b', 'bottom', 'top'),
      ]);
      // Simulate a collab edit: b jumps ABOVE a, leaving the baked sides stale.
      store.updateShape('b', { y: -300 });

      store.rebuildAllConnectorRoutes();
      const c = useDocumentStore.getState().shapes['c1'] as ConnectorShape;
      // Sides flip to match the new geometry (b above a) — the old waypoint-only
      // rebuild left these at (bottom, top) and could never recover the tangle.
      expect(c.startAnchor).toBe('top');
      expect(c.endAnchor).toBe('bottom');
      // Start endpoint pulled to a's top face (above a's center at y=0).
      expect(c.y).toBeLessThan(0);
      expect(Array.isArray(c.waypoints)).toBe(true);

      // Idempotent: a second rebuild reproduces the same result exactly.
      store.rebuildAllConnectorRoutes();
      const c2 = useDocumentStore.getState().shapes['c1'] as ConnectorShape;
      expect(c2.startAnchor).toBe('top');
      expect(c2.endAnchor).toBe('bottom');
      expect([c2.x, c2.y, c2.x2, c2.y2]).toEqual([c.x, c.y, c.x2, c.y2]);
      expect(c2.waypoints).toEqual(c.waypoints);
    });

    it('autoLayoutShapes re-seats anchors to match the laid-out geometry', () => {
      const store = useDocumentStore.getState();
      store.addShapes([
        createTestRect({ id: 'a', x: 0, y: 0 }),
        createTestRect({ id: 'b', x: 0, y: 300 }),
        // Deliberately wrong (horizontal) sides — must be corrected by re-layout.
        orthConnector('c1', 'a', 'b', 'left', 'right'),
      ]);
      store.autoLayoutShapes(['a', 'b']);

      const after = useDocumentStore.getState().shapes;
      const c = after['c1'] as ConnectorShape;
      // TB layout stacks the two nodes vertically; anchors follow that geometry.
      const expected =
        after['a']!.y < after['b']!.y
          ? { startAnchor: 'bottom', endAnchor: 'top' }
          : { startAnchor: 'top', endAnchor: 'bottom' };
      expect(c.startAnchor).toBe(expected.startAnchor);
      expect(c.endAnchor).toBe(expected.endAnchor);
    });
  });

  describe('addShape', () => {
    it('adds a shape to the store', () => {
      const rect = createTestRect({ id: 'rect1' });
      useDocumentStore.getState().addShape(rect);

      const state = useDocumentStore.getState();
      expect(state.shapes['rect1']).toEqual(rect);
      expect(state.shapeOrder).toContain('rect1');
    });

    it('appends shape to end of z-order', () => {
      const rect1 = createTestRect({ id: 'rect1' });
      const rect2 = createTestRect({ id: 'rect2' });

      useDocumentStore.getState().addShape(rect1);
      useDocumentStore.getState().addShape(rect2);

      const state = useDocumentStore.getState();
      expect(state.shapeOrder).toEqual(['rect1', 'rect2']);
    });

    it('does not add duplicate shape IDs', () => {
      const rect1 = createTestRect({ id: 'rect1', x: 0 });
      const rect1Dup = createTestRect({ id: 'rect1', x: 100 });

      useDocumentStore.getState().addShape(rect1);
      useDocumentStore.getState().addShape(rect1Dup);

      const state = useDocumentStore.getState();
      expect(state.shapes['rect1']!.x).toBe(0); // Original preserved
      expect(state.shapeOrder.length).toBe(1);
    });
  });

  describe('updateShape', () => {
    it('updates shape properties', () => {
      const rect = createTestRect({ id: 'rect1', x: 0, y: 0 });
      useDocumentStore.getState().addShape(rect);

      useDocumentStore.getState().updateShape('rect1', { x: 100, y: 50 });

      const updated = useDocumentStore.getState().shapes['rect1'] as RectangleShape;
      expect(updated.x).toBe(100);
      expect(updated.y).toBe(50);
      expect(updated.width).toBe(100); // Unchanged
    });

    it('does not affect z-order', () => {
      const rect1 = createTestRect({ id: 'rect1' });
      const rect2 = createTestRect({ id: 'rect2' });
      useDocumentStore.getState().addShape(rect1);
      useDocumentStore.getState().addShape(rect2);

      useDocumentStore.getState().updateShape('rect1', { x: 500 });

      expect(useDocumentStore.getState().shapeOrder).toEqual(['rect1', 'rect2']);
    });

    it('ignores updates to non-existent shapes', () => {
      useDocumentStore.getState().updateShape('nonexistent', { x: 100 });
      // Should not throw
      expect(useDocumentStore.getState().shapes['nonexistent']).toBeUndefined();
    });
  });

  describe('deleteShape', () => {
    it('removes shape from store', () => {
      const rect = createTestRect({ id: 'rect1' });
      useDocumentStore.getState().addShape(rect);
      useDocumentStore.getState().deleteShape('rect1');

      const state = useDocumentStore.getState();
      expect(state.shapes['rect1']).toBeUndefined();
      expect(state.shapeOrder).not.toContain('rect1');
    });

    it('maintains other shapes', () => {
      const rect1 = createTestRect({ id: 'rect1' });
      const rect2 = createTestRect({ id: 'rect2' });
      useDocumentStore.getState().addShape(rect1);
      useDocumentStore.getState().addShape(rect2);

      useDocumentStore.getState().deleteShape('rect1');

      const state = useDocumentStore.getState();
      expect(state.shapes['rect2']).toBeDefined();
      expect(state.shapeOrder).toEqual(['rect2']);
    });

    it('handles deleting non-existent shape gracefully', () => {
      useDocumentStore.getState().deleteShape('nonexistent');
      // Should not throw
      expect(useDocumentStore.getState().shapeOrder).toEqual([]);
    });
  });

  describe('addShapes (batch)', () => {
    it('adds multiple shapes at once', () => {
      const shapes = [
        createTestRect({ id: 'rect1' }),
        createTestRect({ id: 'rect2' }),
        createTestRect({ id: 'rect3' }),
      ];

      useDocumentStore.getState().addShapes(shapes);

      const state = useDocumentStore.getState();
      expect(Object.keys(state.shapes).length).toBe(3);
      expect(state.shapeOrder).toEqual(['rect1', 'rect2', 'rect3']);
    });

    it('skips duplicate IDs in batch', () => {
      const rect1 = createTestRect({ id: 'rect1' });
      useDocumentStore.getState().addShape(rect1);

      const newShapes = [
        createTestRect({ id: 'rect1', x: 999 }), // Duplicate
        createTestRect({ id: 'rect2' }),
      ];

      useDocumentStore.getState().addShapes(newShapes);

      const state = useDocumentStore.getState();
      expect(state.shapes['rect1']!.x).toBe(0); // Original
      expect(state.shapeOrder).toEqual(['rect1', 'rect2']);
    });
  });

  describe('updateShapes (batch)', () => {
    it('updates multiple shapes at once', () => {
      const shapes = [
        createTestRect({ id: 'rect1', x: 0 }),
        createTestRect({ id: 'rect2', x: 0 }),
      ];
      useDocumentStore.getState().addShapes(shapes);

      useDocumentStore.getState().updateShapes([
        { id: 'rect1', updates: { x: 100 } },
        { id: 'rect2', updates: { x: 200 } },
      ]);

      expect(useDocumentStore.getState().shapes['rect1']!.x).toBe(100);
      expect(useDocumentStore.getState().shapes['rect2']!.x).toBe(200);
    });

    it('skips non-existent shapes in batch', () => {
      const rect = createTestRect({ id: 'rect1', x: 0 });
      useDocumentStore.getState().addShape(rect);

      useDocumentStore.getState().updateShapes([
        { id: 'rect1', updates: { x: 100 } },
        { id: 'nonexistent', updates: { x: 200 } },
      ]);

      expect(useDocumentStore.getState().shapes['rect1']!.x).toBe(100);
    });
  });

  describe('deleteShapes (batch)', () => {
    it('deletes multiple shapes at once', () => {
      const shapes = [
        createTestRect({ id: 'rect1' }),
        createTestRect({ id: 'rect2' }),
        createTestRect({ id: 'rect3' }),
      ];
      useDocumentStore.getState().addShapes(shapes);

      useDocumentStore.getState().deleteShapes(['rect1', 'rect3']);

      const state = useDocumentStore.getState();
      expect(Object.keys(state.shapes)).toEqual(['rect2']);
      expect(state.shapeOrder).toEqual(['rect2']);
    });
  });

  describe('z-order operations', () => {
    beforeEach(() => {
      const shapes = [
        createTestRect({ id: 'rect1' }),
        createTestRect({ id: 'rect2' }),
        createTestRect({ id: 'rect3' }),
      ];
      useDocumentStore.getState().addShapes(shapes);
    });

    describe('bringToFront', () => {
      it('moves shape to end of z-order', () => {
        useDocumentStore.getState().bringToFront('rect1');
        expect(useDocumentStore.getState().shapeOrder).toEqual(['rect2', 'rect3', 'rect1']);
      });

      it('does nothing if already at front', () => {
        useDocumentStore.getState().bringToFront('rect3');
        expect(useDocumentStore.getState().shapeOrder).toEqual(['rect1', 'rect2', 'rect3']);
      });
    });

    describe('sendToBack', () => {
      it('moves shape to start of z-order', () => {
        useDocumentStore.getState().sendToBack('rect3');
        expect(useDocumentStore.getState().shapeOrder).toEqual(['rect3', 'rect1', 'rect2']);
      });

      it('does nothing if already at back', () => {
        useDocumentStore.getState().sendToBack('rect1');
        expect(useDocumentStore.getState().shapeOrder).toEqual(['rect1', 'rect2', 'rect3']);
      });
    });

    describe('bringForward', () => {
      it('moves shape one position forward', () => {
        useDocumentStore.getState().bringForward('rect1');
        expect(useDocumentStore.getState().shapeOrder).toEqual(['rect2', 'rect1', 'rect3']);
      });

      it('does nothing if already at front', () => {
        useDocumentStore.getState().bringForward('rect3');
        expect(useDocumentStore.getState().shapeOrder).toEqual(['rect1', 'rect2', 'rect3']);
      });
    });

    describe('sendBackward', () => {
      it('moves shape one position backward', () => {
        useDocumentStore.getState().sendBackward('rect3');
        expect(useDocumentStore.getState().shapeOrder).toEqual(['rect1', 'rect3', 'rect2']);
      });

      it('does nothing if already at back', () => {
        useDocumentStore.getState().sendBackward('rect1');
        expect(useDocumentStore.getState().shapeOrder).toEqual(['rect1', 'rect2', 'rect3']);
      });
    });

    describe('bringToFrontMultiple', () => {
      it('brings multiple shapes to front preserving relative order', () => {
        useDocumentStore.getState().bringToFrontMultiple(['rect1', 'rect2']);
        expect(useDocumentStore.getState().shapeOrder).toEqual(['rect3', 'rect1', 'rect2']);
      });
    });

    describe('sendToBackMultiple', () => {
      it('sends multiple shapes to back preserving relative order', () => {
        useDocumentStore.getState().sendToBackMultiple(['rect2', 'rect3']);
        expect(useDocumentStore.getState().shapeOrder).toEqual(['rect2', 'rect3', 'rect1']);
      });
    });
  });

  describe('snapshots', () => {
    it('creates a snapshot of current state', () => {
      const rect = createTestRect({ id: 'rect1', x: 100 });
      useDocumentStore.getState().addShape(rect);

      const snapshot = useDocumentStore.getState().getSnapshot();

      expect(snapshot.shapes['rect1']).toEqual(rect);
      expect(snapshot.shapeOrder).toEqual(['rect1']);
      expect(snapshot.version).toBe(1);
    });

    it('snapshot is a deep copy', () => {
      const rect = createTestRect({ id: 'rect1', x: 100 });
      useDocumentStore.getState().addShape(rect);

      const snapshot = useDocumentStore.getState().getSnapshot();
      snapshot.shapes['rect1']!.x = 999;

      // Original should be unchanged
      expect(useDocumentStore.getState().shapes['rect1']!.x).toBe(100);
    });

    it('loads a snapshot', () => {
      const rect = createTestRect({ id: 'rect1' });
      useDocumentStore.getState().addShape(rect);

      const snapshot = {
        shapes: { rect2: createTestRect({ id: 'rect2', x: 200 }) },
        shapeOrder: ['rect2'],
        version: 1,
      };

      useDocumentStore.getState().loadSnapshot(snapshot);

      const state = useDocumentStore.getState();
      expect(state.shapes['rect1']).toBeUndefined();
      expect(state.shapes['rect2']!.x).toBe(200);
      expect(state.shapeOrder).toEqual(['rect2']);
    });

    it('filters orphaned IDs when loading snapshot', () => {
      const snapshot = {
        shapes: { rect1: createTestRect({ id: 'rect1' }) },
        shapeOrder: ['rect1', 'orphan', 'rect2'], // rect2 and orphan don't exist
        version: 1,
      };

      useDocumentStore.getState().loadSnapshot(snapshot);

      expect(useDocumentStore.getState().shapeOrder).toEqual(['rect1']);
    });

    it('collapses a doubled shapeOrder keep-first on load (JP-330)', () => {
      // The dual-origin-merge corruption: each valid id appears twice (+ an
      // orphan). loadSnapshot must dedupe keep-first and drop the orphan.
      const snapshot = {
        shapes: { a: createTestRect({ id: 'a' }), b: createTestRect({ id: 'b' }) },
        shapeOrder: ['a', 'b', 'a', 'b', 'ghost'],
        version: 1,
      };

      useDocumentStore.getState().loadSnapshot(snapshot);

      expect(useDocumentStore.getState().shapeOrder).toEqual(['a', 'b']);
    });
  });

  describe('reorderShapes dedupe (JP-330)', () => {
    it('collapses a doubled incoming order (the CRDT onOrderChange funnel)', () => {
      const store = useDocumentStore.getState();
      store.addShapes([createTestRect({ id: 'a' }), createTestRect({ id: 'b' })]);

      // A doubled order arrives (dual-origin merge) — must not double z-order.
      store.reorderShapes(['b', 'a', 'b', 'a']);

      expect(useDocumentStore.getState().shapeOrder).toEqual(['b', 'a']);
    });

    it('still rejects a genuinely partial order', () => {
      const store = useDocumentStore.getState();
      store.addShapes([createTestRect({ id: 'a' }), createTestRect({ id: 'b' })]);

      // Only one of two distinct shapes — not a permutation, so ignored.
      store.reorderShapes(['a', 'a']);

      expect(useDocumentStore.getState().shapeOrder).toEqual(['a', 'b']);
    });
  });

  describe('utilities', () => {
    describe('getShape', () => {
      it('returns shape by ID', () => {
        const rect = createTestRect({ id: 'rect1', x: 100 });
        useDocumentStore.getState().addShape(rect);

        const shape = useDocumentStore.getState().getShape('rect1');
        expect(shape).toEqual(rect);
      });

      it('returns undefined for non-existent shape', () => {
        expect(useDocumentStore.getState().getShape('nonexistent')).toBeUndefined();
      });
    });

    describe('getShapesInOrder', () => {
      it('returns shapes in z-order', () => {
        const shapes = [
          createTestRect({ id: 'rect1' }),
          createTestRect({ id: 'rect2' }),
          createTestRect({ id: 'rect3' }),
        ];
        useDocumentStore.getState().addShapes(shapes);
        useDocumentStore.getState().bringToFront('rect1');

        const ordered = useDocumentStore.getState().getShapesInOrder();
        expect(ordered.map((s) => s.id)).toEqual(['rect2', 'rect3', 'rect1']);
      });

      it('filters out missing shapes', () => {
        const rect = createTestRect({ id: 'rect1' });
        useDocumentStore.getState().addShape(rect);
        // Manually corrupt shapeOrder (shouldn't happen in practice)
        useDocumentStore.setState((state) => {
          state.shapeOrder = ['rect1', 'missing'];
        });

        const ordered = useDocumentStore.getState().getShapesInOrder();
        expect(ordered.length).toBe(1);
      });
    });

    describe('clear', () => {
      it('removes all shapes', () => {
        const shapes = [
          createTestRect({ id: 'rect1' }),
          createTestRect({ id: 'rect2' }),
        ];
        useDocumentStore.getState().addShapes(shapes);

        useDocumentStore.getState().clear();

        const state = useDocumentStore.getState();
        expect(Object.keys(state.shapes).length).toBe(0);
        expect(state.shapeOrder.length).toBe(0);
      });
    });
  });

  describe('helper functions', () => {
    describe('getShapesByIds', () => {
      it('returns shapes by IDs', () => {
        const shapes = [
          createTestRect({ id: 'rect1' }),
          createTestRect({ id: 'rect2' }),
          createTestRect({ id: 'rect3' }),
        ];
        useDocumentStore.getState().addShapes(shapes);

        const result = getShapesByIds(['rect1', 'rect3']);
        expect(result.map((s) => s.id)).toEqual(['rect1', 'rect3']);
      });

      it('filters out non-existent IDs', () => {
        const rect = createTestRect({ id: 'rect1' });
        useDocumentStore.getState().addShape(rect);

        const result = getShapesByIds(['rect1', 'nonexistent']);
        expect(result.length).toBe(1);
      });
    });

    describe('shapeExists', () => {
      it('returns true for existing shape', () => {
        const rect = createTestRect({ id: 'rect1' });
        useDocumentStore.getState().addShape(rect);

        expect(shapeExists('rect1')).toBe(true);
      });

      it('returns false for non-existent shape', () => {
        expect(shapeExists('nonexistent')).toBe(false);
      });
    });
  });
});
