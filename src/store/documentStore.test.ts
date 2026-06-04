import { describe, it, expect, beforeEach } from 'vitest';
import {
  useDocumentStore,
  getShapesByIds,
  shapeExists,
  getStoreChangeKind,
} from './documentStore';
import { RectangleShape } from '../shapes/Shape';

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

  describe('change provenance (JP-178)', () => {
    it('tags loadSnapshot and clear as replace, edits as edit', () => {
      const store = useDocumentStore.getState();
      const kinds: Array<'edit' | 'replace'> = [];
      const unsub = useDocumentStore.subscribe(() => {
        kinds.push(getStoreChangeKind());
      });

      store.addShape(createTestRect({ id: 'a' })); // edit
      store.loadSnapshot({ shapes: {}, shapeOrder: [], version: 1 }); // replace
      store.addShape(createTestRect({ id: 'b' })); // edit
      store.clear(); // replace
      unsub();

      expect(kinds).toEqual(['edit', 'replace', 'edit', 'replace']);
      // The flag brackets each bulk op and resets to 'edit' afterwards.
      expect(getStoreChangeKind()).toBe('edit');
    });

    it('defaults to edit (no bulk op in flight)', () => {
      expect(getStoreChangeKind()).toBe('edit');
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
