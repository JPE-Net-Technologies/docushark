import { Vec2 } from '../math/Vec2';
import { Box } from '../math/Box';
import { Shape, Handle, Anchor } from './Shape';
import type { ShapeMetadata, ShapeLibraryCategory } from './ShapeMetadata';

/**
 * Handler interface for shape operations.
 *
 * Each shape type (rectangle, ellipse, line, text) registers a handler
 * that implements these methods. This pattern keeps shapes as plain data
 * objects while allowing type-specific behavior.
 *
 * @template T - The specific shape type this handler operates on
 */
/**
 * Describes where and how a shape's label can be edited in place.
 *
 * Returned by `ShapeHandler.getLabelEditTarget`. The inline text editor uses
 * this to position its overlay and to know which field to write back, making
 * editability capability-driven instead of a hardcoded shape-type allowlist
 * (JP-102). A handler returns `null` when the shape has no editable label.
 */
export interface LabelEditTarget {
  /** The shape field the edited text is written back to. */
  field: 'label' | 'text';
  /** Center + size of the edit box in world coordinates. */
  worldRect: { cx: number; cy: number; width: number; height: number };
  /** Font size in world units. */
  fontSize: number;
  /** Horizontal alignment of the edited text. */
  align: 'left' | 'center' | 'right';
  /** Shape rotation in radians (applied to the overlay). */
  rotation: number;
}

export interface ShapeHandler<T extends Shape = Shape> {
  /**
   * Render the shape to a canvas context.
   * The context is already transformed to world space with camera applied.
   *
   * @param ctx - Canvas 2D rendering context
   * @param shape - The shape to render
   */
  render(ctx: CanvasRenderingContext2D, shape: T): void;

  /**
   * Test if a world point is inside the shape.
   * Used for click/hover detection.
   *
   * @param shape - The shape to test
   * @param worldPoint - Point in world coordinates
   * @returns true if the point is inside the shape
   */
  hitTest(shape: T, worldPoint: Vec2): boolean;

  /**
   * Get the axis-aligned bounding box of the shape in world coordinates.
   * Used for viewport culling and spatial indexing.
   *
   * @param shape - The shape to get bounds for
   * @returns Axis-aligned bounding box
   */
  getBounds(shape: T): Box;

  /**
   * Get the resize/rotate handles for the shape.
   * Returns handle positions in world coordinates.
   *
   * @param shape - The shape to get handles for
   * @returns Array of handles with positions and types
   */
  getHandles(shape: T): Handle[];

  /**
   * Create a new shape at the given position with default properties.
   *
   * @param position - World position for the new shape
   * @param id - Unique identifier for the shape
   * @returns A new shape instance
   */
  create(position: Vec2, id: string): T;

  /**
   * Get the connector anchor points for this shape.
   * Optional - only shapes that support connectors need to implement this.
   *
   * @param shape - The shape to get anchors for
   * @returns Array of anchor points with positions and identifiers
   */
  getAnchors?(shape: T): Anchor[];

  /**
   * Describe the in-place label edit target for this shape, or `null` if the
   * shape has no editable label. Drives capability-based double-click editing
   * (JP-102) — the inline editor positions itself from the returned target.
   *
   * @param shape - The shape to get the edit target for
   * @returns The label edit target, or null if not label-editable
   */
  getLabelEditTarget?(shape: T): LabelEditTarget | null;

  /**
   * Optional deferred "overlay" render, drawn after all shapes have rendered in
   * z-order. Used for annotations (e.g. connector labels) that must sit above
   * other shapes' bodies rather than be buried by a later shape's body in the
   * same pass. The context is in world space with the camera applied, exactly as
   * for `render`. Implementers should set `globalAlpha` themselves to match the
   * shape body's opacity.
   *
   * @param ctx - Canvas 2D rendering context
   * @param shape - The shape whose overlay to draw
   */
  renderOverlay?(ctx: CanvasRenderingContext2D, shape: T): void;
}

/**
 * Registry for shape handlers.
 *
 * The ShapeRegistry maps shape types to their handlers, enabling
 * extensible shape support without modifying core engine code.
 *
 * Usage:
 * ```typescript
 * const registry = new ShapeRegistry();
 *
 * // Register handlers for each shape type
 * registry.register('rectangle', rectangleHandler);
 * registry.register('ellipse', ellipseHandler);
 *
 * // Get handler for a shape
 * const handler = registry.getHandler(shape.type);
 * handler.render(ctx, shape);
 * ```
 */
export class ShapeRegistry {
  private handlers: Map<string, ShapeHandler> = new Map();
  private metadata: Map<string, ShapeMetadata> = new Map();

  /**
   * Register a handler for a shape type with optional metadata.
   *
   * @param type - The shape type (e.g., 'rectangle', 'ellipse')
   * @param handler - The handler implementing shape operations
   * @param metadata - Optional metadata for UI rendering (PropertyPanel, ShapePicker)
   * @throws Error if a handler is already registered for the type
   */
  register<T extends Shape>(
    type: string,
    handler: ShapeHandler<T>,
    metadata?: ShapeMetadata
  ): void {
    if (this.handlers.has(type)) {
      throw new Error(`Handler already registered for shape type: ${type}`);
    }
    this.handlers.set(type, handler as ShapeHandler);
    if (metadata) {
      this.metadata.set(type, metadata);
    }
  }

  /**
   * Get the handler for a shape type.
   *
   * @param type - The shape type to get the handler for
   * @returns The shape handler
   * @throws Error if no handler is registered for the type
   */
  getHandler(type: string): ShapeHandler {
    const handler = this.handlers.get(type);
    if (!handler) {
      throw new Error(`No handler registered for shape type: ${type}`);
    }
    return handler;
  }

  /**
   * Get the handler for a specific shape.
   * Convenience method that extracts the type from the shape.
   *
   * @param shape - The shape to get the handler for
   * @returns The shape handler
   */
  getHandlerForShape(shape: Shape): ShapeHandler {
    return this.getHandler(shape.type);
  }

  /**
   * Check if a handler is registered for a shape type.
   *
   * @param type - The shape type to check
   * @returns true if a handler is registered
   */
  hasHandler(type: string): boolean {
    return this.handlers.has(type);
  }

  /**
   * Unregister a handler for a shape type.
   * Useful for testing or dynamic handler replacement.
   *
   * @param type - The shape type to unregister
   * @returns true if a handler was removed, false if none existed
   */
  unregister(type: string): boolean {
    return this.handlers.delete(type);
  }

  /**
   * Get all registered shape types.
   *
   * @returns Array of registered shape type names
   */
  getRegisteredTypes(): string[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * Get metadata for a shape type.
   *
   * @param type - The shape type to get metadata for
   * @returns The shape metadata, or undefined if not registered
   */
  getMetadata(type: string): ShapeMetadata | undefined {
    return this.metadata.get(type);
  }

  /**
   * Get metadata for a specific shape.
   * Convenience method that extracts the type from the shape.
   *
   * @param shape - The shape to get metadata for
   * @returns The shape metadata, or undefined if not registered
   */
  getMetadataForShape(shape: Shape): ShapeMetadata | undefined {
    return this.getMetadata(shape.type);
  }

  /**
   * Check if metadata is registered for a shape type.
   *
   * @param type - The shape type to check
   * @returns true if metadata is registered
   */
  hasMetadata(type: string): boolean {
    return this.metadata.has(type);
  }

  /**
   * Get all registered metadata.
   *
   * @returns Array of all shape metadata
   */
  getAllMetadata(): ShapeMetadata[] {
    return Array.from(this.metadata.values());
  }

  /**
   * Get metadata for shapes in a specific category.
   *
   * @param category - The category to filter by
   * @returns Array of shape metadata in the category
   */
  getMetadataByCategory(category: ShapeLibraryCategory): ShapeMetadata[] {
    return this.getAllMetadata().filter((m) => m.category === category);
  }

  /**
   * Get all registered categories.
   *
   * @returns Array of unique categories
   */
  getRegisteredCategories(): ShapeLibraryCategory[] {
    const categories = new Set<ShapeLibraryCategory>();
    for (const meta of this.metadata.values()) {
      categories.add(meta.category);
    }
    return Array.from(categories);
  }

  /**
   * Clear all registered handlers and metadata.
   * Useful for testing.
   */
  clear(): void {
    this.handlers.clear();
    this.metadata.clear();
  }
}

/**
 * Global shape registry instance.
 * Shape handlers should be registered at application startup.
 */
export const shapeRegistry = new ShapeRegistry();
