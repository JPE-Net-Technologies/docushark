import { describe, it, expect, beforeEach } from 'vitest';
import {
  useSessionStore,
  getSelectedShapes,
  hasSingleSelection,
  hasMultipleSelection,
  deleteSelected,
} from './sessionStore';
import { useDocumentStore } from './documentStore';
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

describe('Session Store', () => {
  beforeEach(() => {
    // Reset both stores before each test
    useSessionStore.getState().reset();
    useDocumentStore.getState().clear();
  });

  describe('selection', () => {
    describe('select', () => {
      it('selects given shape IDs', () => {
        useSessionStore.getState().select(['shape1', 'shape2']);

        const state = useSessionStore.getState();
        expect(state.selectedIds.has('shape1')).toBe(true);
        expect(state.selectedIds.has('shape2')).toBe(true);
        expect(state.selectedIds.size).toBe(2);
      });

      it('replaces previous selection', () => {
        useSessionStore.getState().select(['shape1']);
        useSessionStore.getState().select(['shape2', 'shape3']);

        const state = useSessionStore.getState();
        expect(state.selectedIds.has('shape1')).toBe(false);
        expect(state.selectedIds.has('shape2')).toBe(true);
        expect(state.selectedIds.has('shape3')).toBe(true);
      });

      it('accepts empty array to clear selection', () => {
        useSessionStore.getState().select(['shape1']);
        useSessionStore.getState().select([]);

        expect(useSessionStore.getState().selectedIds.size).toBe(0);
      });
    });

    describe('addToSelection', () => {
      it('adds to existing selection', () => {
        useSessionStore.getState().select(['shape1']);
        useSessionStore.getState().addToSelection(['shape2']);

        const state = useSessionStore.getState();
        expect(state.selectedIds.has('shape1')).toBe(true);
        expect(state.selectedIds.has('shape2')).toBe(true);
      });

      it('does not duplicate existing IDs', () => {
        useSessionStore.getState().select(['shape1']);
        useSessionStore.getState().addToSelection(['shape1', 'shape2']);

        expect(useSessionStore.getState().selectedIds.size).toBe(2);
      });
    });

    describe('removeFromSelection', () => {
      it('removes specified IDs from selection', () => {
        useSessionStore.getState().select(['shape1', 'shape2', 'shape3']);
        useSessionStore.getState().removeFromSelection(['shape2']);

        const state = useSessionStore.getState();
        expect(state.selectedIds.has('shape1')).toBe(true);
        expect(state.selectedIds.has('shape2')).toBe(false);
        expect(state.selectedIds.has('shape3')).toBe(true);
      });

      it('ignores IDs not in selection', () => {
        useSessionStore.getState().select(['shape1']);
        useSessionStore.getState().removeFromSelection(['nonexistent']);

        expect(useSessionStore.getState().selectedIds.size).toBe(1);
      });
    });

    describe('toggleSelection', () => {
      it('adds ID if not selected', () => {
        useSessionStore.getState().toggleSelection('shape1');

        expect(useSessionStore.getState().selectedIds.has('shape1')).toBe(true);
      });

      it('removes ID if already selected', () => {
        useSessionStore.getState().select(['shape1']);
        useSessionStore.getState().toggleSelection('shape1');

        expect(useSessionStore.getState().selectedIds.has('shape1')).toBe(false);
      });
    });

    describe('clearSelection', () => {
      it('removes all selections', () => {
        useSessionStore.getState().select(['shape1', 'shape2', 'shape3']);
        useSessionStore.getState().clearSelection();

        expect(useSessionStore.getState().selectedIds.size).toBe(0);
      });
    });

    describe('selectAll', () => {
      it('selects all shapes from document store', () => {
        // Add shapes to document store
        useDocumentStore.getState().addShapes([
          createTestRect({ id: 'rect1' }),
          createTestRect({ id: 'rect2' }),
          createTestRect({ id: 'rect3' }),
        ]);

        useSessionStore.getState().selectAll();

        const state = useSessionStore.getState();
        expect(state.selectedIds.has('rect1')).toBe(true);
        expect(state.selectedIds.has('rect2')).toBe(true);
        expect(state.selectedIds.has('rect3')).toBe(true);
      });

      it('handles empty document', () => {
        useSessionStore.getState().selectAll();
        expect(useSessionStore.getState().selectedIds.size).toBe(0);
      });
    });

    describe('isSelected', () => {
      it('returns true for selected ID', () => {
        useSessionStore.getState().select(['shape1']);
        expect(useSessionStore.getState().isSelected('shape1')).toBe(true);
      });

      it('returns false for non-selected ID', () => {
        expect(useSessionStore.getState().isSelected('shape1')).toBe(false);
      });
    });

    describe('getSelectedIds', () => {
      it('returns array of selected IDs', () => {
        useSessionStore.getState().select(['shape1', 'shape2']);
        const ids = useSessionStore.getState().getSelectedIds();

        expect(ids).toContain('shape1');
        expect(ids).toContain('shape2');
        expect(ids.length).toBe(2);
      });

      it('returns empty array when nothing selected', () => {
        expect(useSessionStore.getState().getSelectedIds()).toEqual([]);
      });
    });

    describe('hasSelection', () => {
      it('returns true when shapes are selected', () => {
        useSessionStore.getState().select(['shape1']);
        expect(useSessionStore.getState().hasSelection()).toBe(true);
      });

      it('returns false when nothing selected', () => {
        expect(useSessionStore.getState().hasSelection()).toBe(false);
      });
    });
  });

  describe('camera', () => {
    describe('setCamera', () => {
      it('updates camera position', () => {
        useSessionStore.getState().setCamera({ x: 100, y: 50 });

        const camera = useSessionStore.getState().camera;
        expect(camera.x).toBe(100);
        expect(camera.y).toBe(50);
        expect(camera.zoom).toBe(1); // Unchanged
      });

      it('updates zoom', () => {
        useSessionStore.getState().setCamera({ zoom: 2 });

        expect(useSessionStore.getState().camera.zoom).toBe(2);
      });

      it('partial updates preserve other values', () => {
        useSessionStore.getState().setCamera({ x: 100, y: 50, zoom: 2 });
        useSessionStore.getState().setCamera({ x: 200 });

        const camera = useSessionStore.getState().camera;
        expect(camera.x).toBe(200);
        expect(camera.y).toBe(50); // Preserved
        expect(camera.zoom).toBe(2); // Preserved
      });
    });

    describe('resetCamera', () => {
      it('resets camera to default', () => {
        useSessionStore.getState().setCamera({ x: 100, y: 50, zoom: 2 });
        useSessionStore.getState().resetCamera();

        const camera = useSessionStore.getState().camera;
        expect(camera.x).toBe(0);
        expect(camera.y).toBe(0);
        expect(camera.zoom).toBe(1);
      });
    });
  });

  describe('tool', () => {
    describe('setActiveTool', () => {
      it('changes active tool', () => {
        expect(useSessionStore.getState().activeTool).toBe('select');

        useSessionStore.getState().setActiveTool('rectangle');
        expect(useSessionStore.getState().activeTool).toBe('rectangle');

        useSessionStore.getState().setActiveTool('pan');
        expect(useSessionStore.getState().activeTool).toBe('pan');
      });
    });
  });

  describe('cursor', () => {
    describe('setCursor', () => {
      it('changes cursor style', () => {
        expect(useSessionStore.getState().cursor).toBe('default');

        useSessionStore.getState().setCursor('crosshair');
        expect(useSessionStore.getState().cursor).toBe('crosshair');

        useSessionStore.getState().setCursor('grab');
        expect(useSessionStore.getState().cursor).toBe('grab');
      });
    });
  });

  describe('interaction state', () => {
    describe('setIsInteracting', () => {
      it('sets interaction state', () => {
        expect(useSessionStore.getState().isInteracting).toBe(false);

        useSessionStore.getState().setIsInteracting(true);
        expect(useSessionStore.getState().isInteracting).toBe(true);

        useSessionStore.getState().setIsInteracting(false);
        expect(useSessionStore.getState().isInteracting).toBe(false);
      });
    });
  });

  describe('hover', () => {
    describe('setHoveredId', () => {
      it('sets hovered shape ID', () => {
        expect(useSessionStore.getState().hoveredId).toBeNull();

        useSessionStore.getState().setHoveredId('shape1');
        expect(useSessionStore.getState().hoveredId).toBe('shape1');

        useSessionStore.getState().setHoveredId(null);
        expect(useSessionStore.getState().hoveredId).toBeNull();
      });
    });
  });

  describe('reset', () => {
    it('resets all state to initial values', () => {
      // Modify all state
      useSessionStore.getState().select(['shape1']);
      useSessionStore.getState().setCamera({ x: 100, y: 50, zoom: 2 });
      useSessionStore.getState().setActiveTool('rectangle');
      useSessionStore.getState().setCursor('crosshair');
      useSessionStore.getState().setIsInteracting(true);
      useSessionStore.getState().setHoveredId('shape1');

      useSessionStore.getState().reset();

      const state = useSessionStore.getState();
      expect(state.selectedIds.size).toBe(0);
      expect(state.camera).toEqual({ x: 0, y: 0, zoom: 1 });
      expect(state.activeTool).toBe('select');
      expect(state.cursor).toBe('default');
      expect(state.isInteracting).toBe(false);
      expect(state.hoveredId).toBeNull();
    });
  });

  describe('helper functions', () => {
    describe('getSelectedShapes', () => {
      it('returns selected shapes from document store', () => {
        useDocumentStore.getState().addShapes([
          createTestRect({ id: 'rect1' }),
          createTestRect({ id: 'rect2' }),
          createTestRect({ id: 'rect3' }),
        ]);
        useSessionStore.getState().select(['rect1', 'rect3']);

        const shapes = getSelectedShapes();
        expect(shapes.map((s) => s.id)).toEqual(['rect1', 'rect3']);
      });

      it('filters out non-existent shapes', () => {
        useDocumentStore.getState().addShape(createTestRect({ id: 'rect1' }));
        useSessionStore.getState().select(['rect1', 'nonexistent']);

        const shapes = getSelectedShapes();
        expect(shapes.length).toBe(1);
        expect(shapes[0]!.id).toBe('rect1');
      });
    });

    describe('hasSingleSelection', () => {
      it('returns true when exactly one shape selected', () => {
        useSessionStore.getState().select(['shape1']);
        expect(hasSingleSelection()).toBe(true);
      });

      it('returns false when no shapes selected', () => {
        expect(hasSingleSelection()).toBe(false);
      });

      it('returns false when multiple shapes selected', () => {
        useSessionStore.getState().select(['shape1', 'shape2']);
        expect(hasSingleSelection()).toBe(false);
      });
    });

    describe('hasMultipleSelection', () => {
      it('returns true when more than one shape selected', () => {
        useSessionStore.getState().select(['shape1', 'shape2']);
        expect(hasMultipleSelection()).toBe(true);
      });

      it('returns false when one shape selected', () => {
        useSessionStore.getState().select(['shape1']);
        expect(hasMultipleSelection()).toBe(false);
      });

      it('returns false when no shapes selected', () => {
        expect(hasMultipleSelection()).toBe(false);
      });
    });

    describe('deleteSelected', () => {
      it('deletes selected shapes and clears selection', () => {
        useDocumentStore.getState().addShapes([
          createTestRect({ id: 'rect1' }),
          createTestRect({ id: 'rect2' }),
          createTestRect({ id: 'rect3' }),
        ]);
        useSessionStore.getState().select(['rect1', 'rect2']);

        deleteSelected();

        const docState = useDocumentStore.getState();
        expect(docState.shapes['rect1']).toBeUndefined();
        expect(docState.shapes['rect2']).toBeUndefined();
        expect(docState.shapes['rect3']).toBeDefined();
        expect(useSessionStore.getState().selectedIds.size).toBe(0);
      });

      it('does nothing when nothing selected', () => {
        useDocumentStore.getState().addShape(createTestRect({ id: 'rect1' }));

        deleteSelected();

        expect(useDocumentStore.getState().shapes['rect1']).toBeDefined();
      });
    });
  });

  describe('file viewing', () => {
    it('starts with no file being viewed', () => {
      const state = useSessionStore.getState();
      expect(state.viewingFileShapeId).toBeNull();
      expect(state.isViewingFile()).toBe(false);
    });

    it('opens file viewer', () => {
      useSessionStore.getState().openFileViewer('file-shape-1');
      const state = useSessionStore.getState();
      expect(state.viewingFileShapeId).toBe('file-shape-1');
      expect(state.isViewingFile()).toBe(true);
    });

    it('closes file viewer', () => {
      useSessionStore.getState().openFileViewer('file-shape-1');
      useSessionStore.getState().closeFileViewer();
      const state = useSessionStore.getState();
      expect(state.viewingFileShapeId).toBeNull();
      expect(state.isViewingFile()).toBe(false);
    });

    it('can switch between different files', () => {
      useSessionStore.getState().openFileViewer('file-1');
      expect(useSessionStore.getState().viewingFileShapeId).toBe('file-1');

      useSessionStore.getState().openFileViewer('file-2');
      expect(useSessionStore.getState().viewingFileShapeId).toBe('file-2');
    });
  });
});
