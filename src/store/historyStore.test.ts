import { describe, it, expect, beforeEach } from 'vitest';
import { useHistoryStore } from './historyStore';
import { useDocumentStore } from './documentStore';
import { useCollaborationStore } from '../collaboration/collaborationStore';
import { RectangleShape } from '../shapes/Shape';

/**
 * Create a test rectangle shape.
 */
function createTestRect(id: string, x = 0, y = 0): RectangleShape {
  return {
    id,
    type: 'rectangle',
    x,
    y,
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
  };
}

const TEST_PAGE_ID = 'test-page-1';

describe('History Store', () => {
  beforeEach(() => {
    // Reset stores before each test
    useHistoryStore.setState({
      pageHistory: {},
      activePageId: TEST_PAGE_ID,
      isTracking: true,
    });
    useDocumentStore.setState({
      shapes: {},
      shapeOrder: [],
    });
    // Undo/redo are gated on collab being inactive (JP-178); keep it off by
    // default so the single-writer history tests behave normally.
    useCollaborationStore.setState({ isActive: false });
  });

  describe('push', () => {
    it('adds entry to past stack', () => {
      const store = useHistoryStore.getState();

      // Make a change to track
      useDocumentStore.getState().addShape(createTestRect('rect1'));

      store.push('Add rectangle');

      expect(store.getUndoCount()).toBe(1);
    });

    it('clears future stack when pushing new entry', async () => {
      const store = useHistoryStore.getState();

      // Setup: push, make change, push again
      useDocumentStore.getState().addShape(createTestRect('rect1'));
      store.push('Add rect1');

      // Wait for debounce
      await new Promise((r) => setTimeout(r, 350));

      useDocumentStore.getState().addShape(createTestRect('rect2'));
      store.push('Add rect2');

      // Undo once
      await new Promise((r) => setTimeout(r, 50));
      store.undo();

      expect(store.canRedo()).toBe(true);

      // Wait for debounce and push new change
      await new Promise((r) => setTimeout(r, 350));
      useDocumentStore.getState().addShape(createTestRect('rect3'));
      store.push('Add rect3');

      // Future should be cleared
      expect(store.canRedo()).toBe(false);
    });

    it('debounces rapid pushes', async () => {
      const store = useHistoryStore.getState();

      // Rapid pushes
      store.push('push1');
      store.push('push2');
      store.push('push3');

      // Only one should be recorded due to debouncing
      expect(store.getUndoCount()).toBe(1);

      // Wait for debounce and push again
      await new Promise((r) => setTimeout(r, 350));
      store.push('push4');

      expect(store.getUndoCount()).toBe(2);
    });

    it('respects isTracking flag', () => {
      const store = useHistoryStore.getState();

      store.setTracking(false);
      store.push('should not be recorded');

      expect(store.getUndoCount()).toBe(0);

      store.setTracking(true);
      store.push('should be recorded');

      expect(store.getUndoCount()).toBe(1);
    });

    it('does nothing without active page', () => {
      useHistoryStore.setState({ activePageId: null });
      const store = useHistoryStore.getState();

      store.push('should not be recorded');

      expect(store.getUndoCount()).toBe(0);
    });
  });

  describe('undo', () => {
    it('restores previous state', async () => {
      const store = useHistoryStore.getState();
      const docStore = useDocumentStore.getState();

      // Initial state - push BEFORE making the change
      docStore.addShape(createTestRect('rect1', 0, 0));

      // Wait for debounce
      await new Promise((r) => setTimeout(r, 350));

      // Push state BEFORE changing (this is the state we want to undo to)
      store.push('Before move');

      // Now change state
      docStore.updateShape('rect1', { x: 100, y: 100 });

      // Verify current state
      expect(useDocumentStore.getState().shapes['rect1']?.x).toBe(100);

      // Undo - should restore to state before the move
      store.undo();

      // Verify restored state
      expect(useDocumentStore.getState().shapes['rect1']?.x).toBe(0);
    });

    it('moves current state to future stack', async () => {
      const store = useHistoryStore.getState();
      const docStore = useDocumentStore.getState();

      docStore.addShape(createTestRect('rect1'));
      store.push('Add rect');

      // Wait for debounce
      await new Promise((r) => setTimeout(r, 350));

      docStore.addShape(createTestRect('rect2'));
      store.push('Add another');

      store.undo();

      expect(store.canRedo()).toBe(true);
      expect(store.getRedoCount()).toBe(1);
    });

    it('does nothing when past is empty', () => {
      const store = useHistoryStore.getState();
      const docStore = useDocumentStore.getState();

      docStore.addShape(createTestRect('rect1'));

      // No push, so no history
      store.undo();

      // Shape should still exist
      expect(useDocumentStore.getState().shapes['rect1']).toBeDefined();
    });

    it('does nothing while a collab session is active (JP-178)', async () => {
      const store = useHistoryStore.getState();
      const docStore = useDocumentStore.getState();

      docStore.addShape(createTestRect('rect1', 0, 0));
      await new Promise((r) => setTimeout(r, 350));
      store.push('Before move');
      docStore.updateShape('rect1', { x: 100, y: 100 });

      // A collab session makes the relay Y.Doc authoritative — snapshot undo is
      // disabled (it would diverge and be clobbered on sync). Undo must no-op.
      useCollaborationStore.setState({ isActive: true });
      try {
        store.undo();
        expect(useDocumentStore.getState().shapes['rect1']?.x).toBe(100);
      } finally {
        useCollaborationStore.setState({ isActive: false });
      }
    });
  });

  describe('redo', () => {
    it('restores future state', async () => {
      const store = useHistoryStore.getState();
      const docStore = useDocumentStore.getState();

      // Setup: add shape and push before making change
      docStore.addShape(createTestRect('rect1', 0, 0));

      await new Promise((r) => setTimeout(r, 350));

      // Push BEFORE the change
      store.push('Before move');
      docStore.updateShape('rect1', { x: 100 });

      // Verify current state
      expect(useDocumentStore.getState().shapes['rect1']?.x).toBe(100);

      // Undo - should restore to 0
      store.undo();
      expect(useDocumentStore.getState().shapes['rect1']?.x).toBe(0);

      // Redo - should restore to 100
      store.redo();
      expect(useDocumentStore.getState().shapes['rect1']?.x).toBe(100);
    });

    it('moves current state to past stack', async () => {
      const store = useHistoryStore.getState();
      const docStore = useDocumentStore.getState();

      docStore.addShape(createTestRect('rect1'));
      store.push();

      await new Promise((r) => setTimeout(r, 350));

      docStore.addShape(createTestRect('rect2'));
      store.push();

      store.undo();

      const pastCountAfterUndo = store.getUndoCount();

      store.redo();

      expect(store.getUndoCount()).toBe(pastCountAfterUndo + 1);
    });

    it('does nothing when future is empty', () => {
      const store = useHistoryStore.getState();
      const docStore = useDocumentStore.getState();

      docStore.addShape(createTestRect('rect1'));
      store.push();

      // No undo, so no redo available
      store.redo();

      expect(useDocumentStore.getState().shapes['rect1']).toBeDefined();
    });
  });

  describe('clear', () => {
    it('clears all page history', async () => {
      const store = useHistoryStore.getState();
      const docStore = useDocumentStore.getState();

      docStore.addShape(createTestRect('rect1'));
      store.push();

      await new Promise((r) => setTimeout(r, 350));

      docStore.addShape(createTestRect('rect2'));
      store.push();

      store.undo();

      expect(store.canUndo()).toBe(true);
      expect(store.canRedo()).toBe(true);

      store.clear();

      expect(store.canUndo()).toBe(false);
      expect(store.canRedo()).toBe(false);
    });
  });

  describe('clearPage', () => {
    it('clears history for specific page', async () => {
      const store = useHistoryStore.getState();

      // Add history for test page
      useDocumentStore.getState().addShape(createTestRect('rect1'));
      store.push();

      expect(store.getUndoCount()).toBe(1);

      store.clearPage(TEST_PAGE_ID);

      expect(store.getUndoCount()).toBe(0);
    });
  });

  describe('setActivePage', () => {
    it('switches active page for history', async () => {
      const store = useHistoryStore.getState();

      // Add history for page 1
      useDocumentStore.getState().addShape(createTestRect('rect1'));
      store.push();

      await new Promise((r) => setTimeout(r, 350));

      useDocumentStore.getState().addShape(createTestRect('rect2'));
      store.push();

      expect(store.getUndoCount()).toBe(2);

      // Switch to page 2
      store.setActivePage('test-page-2');

      // Page 2 has no history
      expect(store.getUndoCount()).toBe(0);

      // Switch back to page 1
      store.setActivePage(TEST_PAGE_ID);

      // History should still be there
      expect(store.getUndoCount()).toBe(2);
    });
  });

  describe('canUndo / canRedo', () => {
    it('returns correct values', async () => {
      const store = useHistoryStore.getState();
      const docStore = useDocumentStore.getState();

      expect(store.canUndo()).toBe(false);
      expect(store.canRedo()).toBe(false);

      docStore.addShape(createTestRect('rect1'));
      store.push();

      expect(store.canUndo()).toBe(true);
      expect(store.canRedo()).toBe(false);

      store.undo();

      expect(store.canRedo()).toBe(true);
    });

    it('returns false without active page', () => {
      useHistoryStore.setState({ activePageId: null });

      expect(useHistoryStore.getState().canUndo()).toBe(false);
      expect(useHistoryStore.getState().canRedo()).toBe(false);
    });
  });

  describe('getUndoCount / getRedoCount', () => {
    it('returns correct counts', async () => {
      const store = useHistoryStore.getState();
      const docStore = useDocumentStore.getState();

      expect(store.getUndoCount()).toBe(0);
      expect(store.getRedoCount()).toBe(0);

      docStore.addShape(createTestRect('rect1'));
      store.push();

      expect(store.getUndoCount()).toBe(1);

      await new Promise((r) => setTimeout(r, 350));

      docStore.addShape(createTestRect('rect2'));
      store.push();

      expect(store.getUndoCount()).toBe(2);

      store.undo();
      store.undo();

      expect(store.getUndoCount()).toBe(0);
      expect(store.getRedoCount()).toBe(2);
    });

    it('returns 0 without active page', () => {
      useHistoryStore.setState({ activePageId: null });

      expect(useHistoryStore.getState().getUndoCount()).toBe(0);
      expect(useHistoryStore.getState().getRedoCount()).toBe(0);
    });
  });

  describe('setTracking', () => {
    it('enables and disables tracking', () => {
      // Initial state
      expect(useHistoryStore.getState().isTracking).toBe(true);

      // Disable tracking
      useHistoryStore.getState().setTracking(false);
      expect(useHistoryStore.getState().isTracking).toBe(false);

      // Enable tracking
      useHistoryStore.getState().setTracking(true);
      expect(useHistoryStore.getState().isTracking).toBe(true);
    });
  });
});
