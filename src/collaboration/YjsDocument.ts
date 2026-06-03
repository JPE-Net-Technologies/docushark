/**
 * Yjs Document Wrapper for real-time collaborative editing.
 *
 * This module wraps a Yjs document to sync shape data between clients.
 * It uses Y.Map for shapes (keyed by shape ID) and handles bidirectional
 * synchronization with the local document store.
 *
 * Architecture:
 * - Y.Doc is the root collaborative document
 * - shapes: Y.Map<string, Shape> - all shapes keyed by ID
 * - shapeOrder: Y.Array<string> - z-order of shapes
 * - metadata: Y.Map - document metadata (title, etc.)
 *
 * The sync flow:
 * 1. Local changes -> update Y.Map -> broadcast to peers
 * 2. Remote changes -> Y.Map events -> update local store
 */

import * as Y from 'yjs';
import type { Shape } from '../shapes/Shape';

/**
 * Document metadata stored in Yjs
 */
export interface YjsDocumentMetadata {
  title: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Callback for when shapes change from remote updates
 */
export type ShapeChangeCallback = (
  added: Shape[],
  updated: Shape[],
  removed: string[]
) => void;

/**
 * Callback for when shape order changes from remote updates
 */
export type OrderChangeCallback = (order: string[]) => void;

/**
 * Callback for when metadata changes from remote updates
 */
export type MetadataChangeCallback = (metadata: YjsDocumentMetadata) => void;

/**
 * YjsDocument wraps a Y.Doc for collaborative shape editing.
 *
 * Usage:
 * ```typescript
 * const yjsDoc = new YjsDocument();
 *
 * // Subscribe to remote changes
 * yjsDoc.onShapeChange((added, updated, removed) => {
 *   // Update local store
 * });
 *
 * // Apply local changes
 * yjsDoc.setShape(shape);
 * yjsDoc.deleteShape(shapeId);
 *
 * // Get the Y.Doc for sync providers
 * const doc = yjsDoc.getDoc();
 * ```
 */
export class YjsDocument {
  private doc: Y.Doc;
  private shapes: Y.Map<Shape>;
  private shapeOrder: Y.Array<string>;
  private metadata: Y.Map<unknown>;

  private shapeChangeCallbacks: Set<ShapeChangeCallback> = new Set();
  private orderChangeCallbacks: Set<OrderChangeCallback> = new Set();
  private metadataChangeCallbacks: Set<MetadataChangeCallback> = new Set();

  private isLocalUpdate = false;

  constructor() {
    // NOTE (JP-172): the Y.Doc clientID is intentionally left as Yjs's random
    // per-instance default. An earlier version pinned it deterministically to
    // hash(docId) so every client on a doc shared one clientID — which is
    // backwards for Yjs: sequence-type item IDs are (clientID, clock) tuples,
    // so colliding clientIDs corrupt ordering/dedup, and two users overwrite
    // each other's awareness. The bug was masked while the doc was ephemeral
    // (fresh clocks each session, relay-mediated) but surfaces hard with
    // persistence (y-indexeddb resumes a clock that, under a shared clientID,
    // makes peers skip each other's updates). Document identity belongs to the
    // provider room (relay docId), never the clientID.
    this.doc = new Y.Doc();

    // Initialize shared types
    this.shapes = this.doc.getMap('shapes');
    this.shapeOrder = this.doc.getArray('shapeOrder');
    this.metadata = this.doc.getMap('metadata');

    // Set up observers
    this.setupObservers();
  }

  /**
   * Get the underlying Y.Doc for use with sync providers.
   */
  getDoc(): Y.Doc {
    return this.doc;
  }

  /**
   * Get the shapes Y.Map for direct access (e.g., for awareness).
   */
  getShapesMap(): Y.Map<Shape> {
    return this.shapes;
  }

  /**
   * Get the shape order Y.Array for direct access.
   */
  getShapeOrderArray(): Y.Array<string> {
    return this.shapeOrder;
  }

  // ============ Local to Remote Sync ============

  /**
   * Set or update a shape (local change -> broadcast to peers).
   */
  setShape(shape: Shape): void {
    this.withLocalUpdate(() => {
      // Clone the shape to avoid reference issues
      this.shapes.set(shape.id, JSON.parse(JSON.stringify(shape)));
    });
  }

  /**
   * Set multiple shapes in a single transaction.
   */
  setShapes(shapes: Shape[]): void {
    this.withLocalUpdate(() => {
      for (const shape of shapes) {
        this.shapes.set(shape.id, JSON.parse(JSON.stringify(shape)));
      }
    });
  }

  /**
   * Delete a shape by ID.
   */
  deleteShape(shapeId: string): void {
    this.withLocalUpdate(() => {
      this.shapes.delete(shapeId);
    });
  }

  /**
   * Delete multiple shapes by ID.
   */
  deleteShapes(shapeIds: string[]): void {
    this.withLocalUpdate(() => {
      for (const id of shapeIds) {
        this.shapes.delete(id);
      }
    });
  }

  /**
   * Update shape order (z-index).
   */
  setShapeOrder(order: string[]): void {
    this.withLocalUpdate(() => {
      // Clear and repopulate the array
      this.shapeOrder.delete(0, this.shapeOrder.length);
      this.shapeOrder.push(order);
    });
  }

  /**
   * Update document metadata.
   */
  setMetadata(meta: Partial<YjsDocumentMetadata>): void {
    this.withLocalUpdate(() => {
      for (const [key, value] of Object.entries(meta)) {
        this.metadata.set(key, value);
      }
    });
  }

  // ============ Remote to Local Sync ============

  /**
   * Subscribe to shape changes from remote peers.
   */
  onShapeChange(callback: ShapeChangeCallback): () => void {
    this.shapeChangeCallbacks.add(callback);
    return () => this.shapeChangeCallbacks.delete(callback);
  }

  /**
   * Subscribe to shape order changes from remote peers.
   */
  onOrderChange(callback: OrderChangeCallback): () => void {
    this.orderChangeCallbacks.add(callback);
    return () => this.orderChangeCallbacks.delete(callback);
  }

  /**
   * Subscribe to metadata changes from remote peers.
   */
  onMetadataChange(callback: MetadataChangeCallback): () => void {
    this.metadataChangeCallbacks.add(callback);
    return () => this.metadataChangeCallbacks.delete(callback);
  }

  // ============ State Access ============

  /**
   * Get all shapes as a Map.
   */
  getAllShapes(): Map<string, Shape> {
    const result = new Map<string, Shape>();
    this.shapes.forEach((shape, id) => {
      result.set(id, shape);
    });
    return result;
  }

  /**
   * Get a shape by ID.
   */
  getShape(id: string): Shape | undefined {
    return this.shapes.get(id);
  }

  /**
   * Get shape order array.
   */
  getShapeOrder(): string[] {
    return this.shapeOrder.toArray();
  }

  /**
   * The document name from the `metadata` map (stored under `title`), or
   * `undefined` if unset. Unlike {@link getMetadata}, this does NOT substitute
   * a default — callers applying a remote rename must distinguish "no name in
   * the Y.Doc" from a doc legitimately named "Untitled", or they'd clobber the
   * local name with the placeholder.
   */
  getName(): string | undefined {
    const title = this.metadata.get('title');
    return typeof title === 'string' ? title : undefined;
  }

  /**
   * Get document metadata.
   */
  getMetadata(): YjsDocumentMetadata {
    return {
      title: (this.metadata.get('title') as string) ?? 'Untitled',
      createdAt: (this.metadata.get('createdAt') as number) ?? Date.now(),
      updatedAt: (this.metadata.get('updatedAt') as number) ?? Date.now(),
    };
  }

  // ============ Bulk Operations ============

  /**
   * Initialize the document with existing shapes.
   * Used when loading a document or syncing initial state.
   */
  initializeFromState(
    shapes: Shape[],
    order: string[],
    metadata?: Partial<YjsDocumentMetadata>
  ): void {
    this.doc.transact(() => {
      // Clear existing state
      this.shapes.clear();
      this.shapeOrder.delete(0, this.shapeOrder.length);

      // Set shapes
      for (const shape of shapes) {
        this.shapes.set(shape.id, JSON.parse(JSON.stringify(shape)));
      }

      // Set order
      this.shapeOrder.push(order);

      // Set metadata
      if (metadata) {
        for (const [key, value] of Object.entries(metadata)) {
          this.metadata.set(key, value);
        }
      }
    }, this); // Mark as local origin
  }

  /**
   * Clear all data from the document.
   */
  clear(): void {
    this.doc.transact(() => {
      this.shapes.clear();
      this.shapeOrder.delete(0, this.shapeOrder.length);
    }, this);
  }

  /**
   * Destroy the document and clean up observers.
   */
  destroy(): void {
    this.shapes.unobserve(this.handleShapeChange);
    this.shapeOrder.unobserve(this.handleOrderChange);
    this.metadata.unobserve(this.handleMetadataChange);
    this.doc.destroy();
  }

  // ============ Private Methods ============

  private setupObservers(): void {
    // Observe shape changes
    this.shapes.observe(this.handleShapeChange);

    // Observe order changes
    this.shapeOrder.observe(this.handleOrderChange);

    // Observe metadata changes
    this.metadata.observe(this.handleMetadataChange);
  }

  private handleShapeChange = (event: Y.YMapEvent<Shape>): void => {
    // Skip if this is a local update
    if (this.isLocalUpdate || event.transaction.origin === this) {
      return;
    }

    const added: Shape[] = [];
    const updated: Shape[] = [];
    const removed: string[] = [];

    event.changes.keys.forEach((change, key) => {
      if (change.action === 'add') {
        const shape = this.shapes.get(key);
        if (shape) added.push(shape);
      } else if (change.action === 'update') {
        const shape = this.shapes.get(key);
        if (shape) updated.push(shape);
      } else if (change.action === 'delete') {
        removed.push(key);
      }
    });

    // Notify callbacks
    if (added.length > 0 || updated.length > 0 || removed.length > 0) {
      this.shapeChangeCallbacks.forEach((cb) => cb(added, updated, removed));
    }
  };

  private handleOrderChange = (event: Y.YArrayEvent<string>): void => {
    // Skip if this is a local update
    if (this.isLocalUpdate || event.transaction.origin === this) {
      return;
    }

    const order = this.shapeOrder.toArray();
    this.orderChangeCallbacks.forEach((cb) => cb(order));
  };

  private handleMetadataChange = (event: Y.YMapEvent<unknown>): void => {
    // Skip if this is a local update
    if (this.isLocalUpdate || event.transaction.origin === this) {
      return;
    }

    const metadata = this.getMetadata();
    this.metadataChangeCallbacks.forEach((cb) => cb(metadata));
  };

  /**
   * Execute a function within a local update context.
   * This prevents the observer from re-notifying about our own changes.
   */
  private withLocalUpdate(fn: () => void): void {
    this.isLocalUpdate = true;
    this.doc.transact(() => {
      fn();
    }, this); // Mark transaction origin
    this.isLocalUpdate = false;
  }
}

export default YjsDocument;
