/**
 * CanvasUndoController — per-user "best effort" canvas undo/redo in collaboration
 * (JP-402).
 *
 * Snapshot-based history (`historyStore`) is disabled in a collab session (JP-178)
 * because restoring a local snapshot diverges from the authoritative relay Y.Doc.
 * This controller is the collab-native answer: a Yjs `UndoManager` per canvas page,
 * scoped to that page's `shapes:<id>` / `shapeOrder:<id>` shared types and filtered
 * to a single tracked origin — the owning `YjsDocument` instance.
 *
 * Why that origin filter is the whole trick: every LOCAL canvas mutation runs through
 * `YjsDocument.withLocalUpdate()` → `doc.transact(fn, this)`, so local edits carry the
 * `YjsDocument` as their transaction origin, while remote edits arrive via the provider
 * (a different origin) and adopt/load writes never touch these maps. So
 * `trackedOrigins: {yjsDoc}` captures *only this user's* edits — and an `undo()` is a
 * real CRDT op (origin = the UndoManager, not `yjsDoc`), so it re-renders through the
 * existing remote-apply pipeline and broadcasts to peers like any other edit. No
 * snapshot, no divergence.
 *
 * Managers are cached per page (the `shapes:<id>` Y.Map instance is stable for the
 * Y.Doc's lifetime), so per-page undo stacks survive page switches — matching the
 * existing per-page history model. Stacks are in-memory and session-scoped (lost on
 * reload), exactly like the snapshot history they stand in for.
 */

import * as Y from 'yjs';
import type { Shape } from '../shapes/Shape';

/**
 * Coalescing window for un-anchored edit bursts (ms). The real step boundaries come
 * from `closeStep()` (called at every `pushHistory` action anchor); this timeout only
 * groups edits with no anchor between them (e.g. rapid property-panel tweaks). It is a
 * feel knob, NOT a perf lever — undo cost is in observing/inverting ops, independent of
 * the window.
 */
const CAPTURE_TIMEOUT_MS = 1000;

export class CanvasUndoController {
  /** One UndoManager per page id, created lazily on first visit. */
  private readonly managers = new Map<string, Y.UndoManager>();
  /** The manager for the currently-bound page (drives undo/redo/canUndo/canRedo). */
  private active: Y.UndoManager | null = null;
  private activePageId: string | null = null;
  private readonly stackChangeCallbacks = new Set<() => void>();

  /** Fired on any stack mutation of the active manager → notify subscribers. */
  private readonly onStackEvent = (): void => {
    this.stackChangeCallbacks.forEach((cb) => cb());
  };

  /**
   * Point the controller at a page's shape surface, get-or-creating its manager.
   * Called from `YjsDocument.rebindActivePage`. Idempotent for the same page.
   */
  setActivePage(
    pageId: string,
    shapes: Y.Map<Shape>,
    order: Y.Array<string>,
    trackedOrigin: object,
  ): void {
    if (this.activePageId === pageId && this.active) return;

    this.detachActiveListeners();

    let manager = this.managers.get(pageId);
    if (!manager) {
      manager = new Y.UndoManager([shapes, order], {
        trackedOrigins: new Set([trackedOrigin]),
        captureTimeout: CAPTURE_TIMEOUT_MS,
      });
      this.managers.set(pageId, manager);
    }

    this.active = manager;
    this.activePageId = pageId;
    this.attachActiveListeners();
    // Availability may differ between pages → let subscribers refresh.
    this.onStackEvent();
  }

  undo(): void {
    this.active?.undo();
  }

  redo(): void {
    this.active?.redo();
  }

  canUndo(): boolean {
    return (this.active?.undoStack.length ?? 0) > 0;
  }

  canRedo(): boolean {
    return (this.active?.redoStack.length ?? 0) > 0;
  }

  /**
   * Close the current undo step (action anchor). Called from the `pushHistory`
   * funnel before each discrete action's mutation, so each action becomes its own
   * undo step rather than relying on the capture timeout.
   */
  closeStep(): void {
    this.active?.stopCapturing();
  }

  /**
   * Drop the active page's undo/redo stacks (the shapes themselves are untouched).
   * Called once the adopted/seeded Y.Doc is the established baseline, so a user can't
   * undo into an empty/seed document — including a never-synced `initializeFromState`
   * seed, which transacts with the tracked origin and would otherwise be captured.
   */
  clearActive(): void {
    this.active?.clear();
  }

  /** Subscribe to undo/redo stack changes (for button reactivity). */
  onStackChange(cb: () => void): () => void {
    this.stackChangeCallbacks.add(cb);
    return () => this.stackChangeCallbacks.delete(cb);
  }

  /** Tear down every manager (call before the owning Y.Doc is destroyed). */
  destroy(): void {
    this.detachActiveListeners();
    this.managers.forEach((m) => m.destroy());
    this.managers.clear();
    this.active = null;
    this.activePageId = null;
    this.stackChangeCallbacks.clear();
  }

  private attachActiveListeners(): void {
    if (!this.active) return;
    this.active.on('stack-item-added', this.onStackEvent);
    this.active.on('stack-item-popped', this.onStackEvent);
    this.active.on('stack-cleared', this.onStackEvent);
  }

  private detachActiveListeners(): void {
    if (!this.active) return;
    this.active.off('stack-item-added', this.onStackEvent);
    this.active.off('stack-item-popped', this.onStackEvent);
    this.active.off('stack-cleared', this.onStackEvent);
  }
}

export default CanvasUndoController;
