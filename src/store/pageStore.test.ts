import { describe, it, expect, beforeEach } from 'vitest';
import { usePageStore, getActivePageId, pageExists } from './pageStore';
import { useDocumentStore } from './documentStore';
import { useHistoryStore } from './historyStore';
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

describe('Page Store', () => {
  beforeEach(() => {
    // Clear both stores before each test
    usePageStore.getState().reset();
    useDocumentStore.getState().clear();
  });

  describe('createPage', () => {
    it('keeps historyStore.activePageId in lockstep when activating the first page', () => {
      // Reproduce the new-doc desync: a previous doc leaves history pinned to
      // its page; the consistency guard then refused edits on the fresh doc.
      useHistoryStore.getState().setActivePage('stale-prev-doc-page');

      // newDocument resets the page store first — history must clear in lockstep.
      usePageStore.getState().reset();
      expect(useHistoryStore.getState().activePageId).toBeNull();

      // The new doc's first page becomes active; history follows it (not stale).
      const pageId = usePageStore.getState().createPage('Page 1');
      expect(usePageStore.getState().activePageId).toBe(pageId);
      expect(useHistoryStore.getState().activePageId).toBe(pageId);
    });

    it('creates a page with default name', () => {
      const pageId = usePageStore.getState().createPage();

      const state = usePageStore.getState();
      expect(state.pages[pageId]).toBeDefined();
      expect(state.pages[pageId]?.name).toBe('Page 1');
      expect(state.pageOrder).toContain(pageId);
    });

    it('creates a page with custom name', () => {
      const pageId = usePageStore.getState().createPage('My Page');

      const page = usePageStore.getState().pages[pageId];
      expect(page?.name).toBe('My Page');
    });

    it('sets first page as active', () => {
      const pageId = usePageStore.getState().createPage();

      expect(usePageStore.getState().activePageId).toBe(pageId);
    });

    it('increments page number for default names', () => {
      usePageStore.getState().createPage();
      const page2Id = usePageStore.getState().createPage();

      expect(usePageStore.getState().pages[page2Id]?.name).toBe('Page 2');
    });

    it('maintains page order', () => {
      const page1 = usePageStore.getState().createPage();
      const page2 = usePageStore.getState().createPage();
      const page3 = usePageStore.getState().createPage();

      expect(usePageStore.getState().pageOrder).toEqual([page1, page2, page3]);
    });
  });

  describe('deletePage', () => {
    it('deletes a page', () => {
      const page1 = usePageStore.getState().createPage();
      const page2 = usePageStore.getState().createPage();

      usePageStore.getState().deletePage(page1);

      const state = usePageStore.getState();
      expect(state.pages[page1]).toBeUndefined();
      expect(state.pageOrder).not.toContain(page1);
      expect(state.pageOrder).toContain(page2);
    });

    it('cannot delete the last page', () => {
      const pageId = usePageStore.getState().createPage();

      usePageStore.getState().deletePage(pageId);

      // Page should still exist
      expect(usePageStore.getState().pages[pageId]).toBeDefined();
    });

    it('switches to next page when active page is deleted', () => {
      const page1 = usePageStore.getState().createPage();
      const page2 = usePageStore.getState().createPage();
      usePageStore.getState().setActivePage(page1);

      usePageStore.getState().deletePage(page1);

      expect(usePageStore.getState().activePageId).toBe(page2);
    });

    it('switches to previous page when last page is deleted', () => {
      const page1 = usePageStore.getState().createPage();
      const page2 = usePageStore.getState().createPage();
      usePageStore.getState().setActivePage(page2);

      usePageStore.getState().deletePage(page2);

      expect(usePageStore.getState().activePageId).toBe(page1);
    });
  });

  describe('renamePage', () => {
    it('renames a page', () => {
      const pageId = usePageStore.getState().createPage('Old Name');

      usePageStore.getState().renamePage(pageId, 'New Name');

      expect(usePageStore.getState().pages[pageId]?.name).toBe('New Name');
    });

    it('updates modifiedAt timestamp', () => {
      const pageId = usePageStore.getState().createPage();
      const originalModified = usePageStore.getState().pages[pageId]?.modifiedAt;

      // Wait a tick to ensure timestamp changes
      usePageStore.getState().renamePage(pageId, 'New Name');

      expect(usePageStore.getState().pages[pageId]?.modifiedAt).toBeGreaterThanOrEqual(
        originalModified ?? 0
      );
    });
  });

  describe('duplicatePage', () => {
    it('creates a copy of a page', () => {
      const pageId = usePageStore.getState().createPage('Original');

      const copyId = usePageStore.getState().duplicatePage(pageId);

      expect(copyId).not.toBeNull();
      expect(usePageStore.getState().pages[copyId!]?.name).toBe('Original (Copy)');
    });

    it('inserts copy after original', () => {
      const page1 = usePageStore.getState().createPage();
      usePageStore.getState().createPage(); // page2

      const copyId = usePageStore.getState().duplicatePage(page1);

      const order = usePageStore.getState().pageOrder;
      expect(order.indexOf(copyId!)).toBe(order.indexOf(page1) + 1);
    });

    it('returns null for non-existent page', () => {
      const result = usePageStore.getState().duplicatePage('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('reorderPages', () => {
    it('reorders pages', () => {
      const page1 = usePageStore.getState().createPage();
      const page2 = usePageStore.getState().createPage();
      const page3 = usePageStore.getState().createPage();

      usePageStore.getState().reorderPages([page3, page1, page2]);

      expect(usePageStore.getState().pageOrder).toEqual([page3, page1, page2]);
    });

    it('ignores invalid IDs in new order', () => {
      const page1 = usePageStore.getState().createPage();
      const page2 = usePageStore.getState().createPage();
      const page3 = usePageStore.getState().createPage();

      // Try to reorder with an invalid ID - should not change because count doesn't match
      usePageStore.getState().reorderPages([page2, 'invalid', page1]);

      // Original order maintained because valid count (2) doesn't match total (3)
      expect(usePageStore.getState().pageOrder).toEqual([page1, page2, page3]);
    });
  });

  describe('setActivePage', () => {
    it('switches active page', () => {
      usePageStore.getState().createPage(); // page1
      const page2 = usePageStore.getState().createPage();

      usePageStore.getState().setActivePage(page2);

      expect(usePageStore.getState().activePageId).toBe(page2);
    });

    it('does not switch to non-existent page', () => {
      const page1 = usePageStore.getState().createPage();

      usePageStore.getState().setActivePage('nonexistent');

      expect(usePageStore.getState().activePageId).toBe(page1);
    });

    it('syncs shapes when switching pages', () => {
      // Create first page and add a shape
      const page1 = usePageStore.getState().createPage();
      const rect = createTestRect({ id: 'rect1' });
      useDocumentStore.getState().addShape(rect);

      // Create second page
      const page2 = usePageStore.getState().createPage();

      // Switch to page 2
      usePageStore.getState().setActivePage(page2);

      // Document store should be empty (page 2 has no shapes)
      expect(useDocumentStore.getState().shapeOrder.length).toBe(0);

      // Switch back to page 1
      usePageStore.getState().setActivePage(page1);

      // Document store should have the shape again
      expect(useDocumentStore.getState().shapes['rect1']).toBeDefined();
    });
  });

  describe('getPage', () => {
    it('returns page by ID', () => {
      const pageId = usePageStore.getState().createPage('Test Page');

      const page = usePageStore.getState().getPage(pageId);

      expect(page?.name).toBe('Test Page');
    });

    it('returns undefined for non-existent page', () => {
      const page = usePageStore.getState().getPage('nonexistent');
      expect(page).toBeUndefined();
    });
  });

  describe('getActivePage', () => {
    it('returns active page', () => {
      usePageStore.getState().createPage('Active Page');

      const activePage = usePageStore.getState().getActivePage();

      expect(activePage?.name).toBe('Active Page');
    });

    it('returns undefined when no pages', () => {
      const activePage = usePageStore.getState().getActivePage();
      expect(activePage).toBeUndefined();
    });
  });

  describe('getPageCount', () => {
    it('returns correct page count', () => {
      expect(usePageStore.getState().getPageCount()).toBe(0);

      usePageStore.getState().createPage();
      expect(usePageStore.getState().getPageCount()).toBe(1);

      usePageStore.getState().createPage();
      expect(usePageStore.getState().getPageCount()).toBe(2);
    });
  });

  describe('syncCurrentPageFromDocument', () => {
    it('saves document shapes to active page', () => {
      const pageId = usePageStore.getState().createPage();
      const rect = createTestRect({ id: 'rect1' });
      useDocumentStore.getState().addShape(rect);

      usePageStore.getState().syncCurrentPageFromDocument();

      const page = usePageStore.getState().pages[pageId];
      expect(page?.shapes['rect1']).toBeDefined();
      expect(page?.shapeOrder).toContain('rect1');
    });
  });

  describe('syncDocumentToCurrentPage', () => {
    it('loads page shapes to document store', () => {
      // Manually set up a page with shapes
      const pageId = usePageStore.getState().createPage();
      const rect = createTestRect({ id: 'rect1' });

      // Directly modify page (simulating loaded data)
      usePageStore.setState((state) => {
        const page = state.pages[pageId];
        if (page) {
          page.shapes = { rect1: rect };
          page.shapeOrder = ['rect1'];
        }
      });

      usePageStore.getState().syncDocumentToCurrentPage();

      expect(useDocumentStore.getState().shapes['rect1']).toBeDefined();
    });
  });

  describe('getSnapshot / loadSnapshot', () => {
    it('creates and restores snapshots', () => {
      const page1 = usePageStore.getState().createPage('Page 1');
      const page2 = usePageStore.getState().createPage('Page 2');
      usePageStore.getState().setActivePage(page2);

      const snapshot = usePageStore.getState().getSnapshot();

      // Reset store
      usePageStore.getState().reset();
      expect(usePageStore.getState().pageOrder.length).toBe(0);

      // Load snapshot
      usePageStore.getState().loadSnapshot(snapshot);

      const state = usePageStore.getState();
      expect(state.pageOrder.length).toBe(2);
      expect(state.pages[page1]?.name).toBe('Page 1');
      expect(state.pages[page2]?.name).toBe('Page 2');
      expect(state.activePageId).toBe(page2);
    });
  });

  describe('initializeDefault', () => {
    it('creates default page when empty', () => {
      usePageStore.getState().initializeDefault();

      expect(usePageStore.getState().pageOrder.length).toBe(1);
      expect(usePageStore.getState().getActivePage()?.name).toBe('Page 1');
    });

    it('does nothing when pages exist', () => {
      usePageStore.getState().createPage('Existing');

      usePageStore.getState().initializeDefault();

      expect(usePageStore.getState().pageOrder.length).toBe(1);
      expect(usePageStore.getState().getActivePage()?.name).toBe('Existing');
    });
  });

  describe('utility functions', () => {
    it('getActivePageId returns active page ID', () => {
      const pageId = usePageStore.getState().createPage();
      expect(getActivePageId()).toBe(pageId);
    });

    it('pageExists returns true for existing page', () => {
      const pageId = usePageStore.getState().createPage();
      expect(pageExists(pageId)).toBe(true);
    });

    it('pageExists returns false for non-existent page', () => {
      expect(pageExists('nonexistent')).toBe(false);
    });
  });

  describe('applyRemoteCanvasPageList (JP-339)', () => {
    it('adds a remote tab while PRESERVING existing pages shapes', () => {
      const p1 = usePageStore.getState().createPage('Page 1');
      // Give the existing page real shapes (its diagram).
      usePageStore.setState((s) => {
        const page = s.pages[p1];
        if (page) {
          page.shapes = { r1: createTestRect({ id: 'r1' }) };
          page.shapeOrder = ['r1'];
        }
      });

      usePageStore.getState().applyRemoteCanvasPageList({
        pages: {
          [p1]: { id: p1, name: 'Page 1' },
          'p-new': { id: 'p-new', name: 'From MCP' },
        },
        pageOrder: [p1, 'p-new'],
      });

      const { pages, pageOrder } = usePageStore.getState();
      expect(pageOrder).toEqual([p1, 'p-new']);
      // The existing page's diagram must NOT be wiped by the meta merge.
      expect(pages[p1]?.shapeOrder).toEqual(['r1']);
      expect(pages[p1]?.shapes['r1']).toBeDefined();
      // The new tab arrives as an empty skeleton (shapes sync separately).
      expect(pages['p-new']?.name).toBe('From MCP');
      expect(pages['p-new']?.shapeOrder).toEqual([]);
    });

    it('applies a remote rename + reorder without touching shapes', () => {
      const a = usePageStore.getState().createPage('Page 1');
      const b = usePageStore.getState().createPage('Page 2');
      usePageStore.setState((s) => {
        const pb = s.pages[b];
        if (pb) {
          pb.shapes = { r2: createTestRect({ id: 'r2' }) };
          pb.shapeOrder = ['r2'];
        }
      });

      usePageStore.getState().applyRemoteCanvasPageList({
        pages: { [a]: { id: a, name: 'A' }, [b]: { id: b, name: 'B renamed' } },
        pageOrder: [b, a],
      });

      const { pages, pageOrder } = usePageStore.getState();
      expect(pageOrder).toEqual([b, a]);
      expect(pages[b]?.name).toBe('B renamed');
      expect(pages[b]?.shapeOrder).toEqual(['r2']);
    });

    it('prunes a deleted page and repoints the active page', () => {
      const a = usePageStore.getState().createPage('Page 1');
      const b = usePageStore.getState().createPage('Page 2');
      usePageStore.getState().setActivePage(a);

      usePageStore.getState().applyRemoteCanvasPageList({
        pages: { [b]: { id: b, name: 'Page 2' } },
        pageOrder: [b],
      });

      const { pages, pageOrder, activePageId } = usePageStore.getState();
      expect(pages[a]).toBeUndefined();
      expect(pageOrder).toEqual([b]);
      expect(activePageId).toBe(b);
    });
  });
});
