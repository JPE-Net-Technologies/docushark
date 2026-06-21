import { Camera } from './Camera';
import { Box } from '../math/Box';
import { Shape, isGroup, GroupShape, Handle, isConnector } from '../shapes/Shape';
import { shapeRegistry } from '../shapes/ShapeRegistry';
import type { GroupShapeHandler } from '../shapes/Group';
import { setLatexRenderCallback } from '../utils/textUtils';
import { onIconLoad } from '../utils/iconCache';
import { onThumbnailLoad } from '../shapes/FileShape';
import { ContrastCache, isAutoColor } from './ContrastResolver';
import { setRenderContext } from './RenderContext';
import { getAdaptiveBudget } from '../platform/adaptiveBudget';

/**
 * Configuration options for the Renderer.
 */
export interface RendererOptions {
  /** Whether to draw the background grid. Default: true */
  showGrid?: boolean;
  /** Grid spacing in world units. Default: 50 */
  gridSpacing?: number;
  /** Major grid line interval (every N lines). Default: 5 */
  majorGridInterval?: number;
  /** Minor grid line color. Default: '#e0e0e0' */
  gridColor?: string;
  /** Major grid line color. Default: '#c0c0c0' */
  majorGridColor?: string;
  /** Origin axis color. Default: '#808080' */
  originColor?: string;
  /** Background color. Default: '#ffffff' */
  backgroundColor?: string;
  /** Whether to show FPS counter. Default: false */
  showFps?: boolean;
  /** Selection box stroke color. Default: '#2196f3' */
  selectionColor?: string;
  /** Handle fill color. Default: '#ffffff' */
  handleFillColor?: string;
  /** Handle stroke color. Default: '#2196f3' */
  handleStrokeColor?: string;
  /** Handle size in screen pixels. Default: 8 */
  handleSize?: number;
  /** Grid opacity (0-100). Default: 100 */
  gridOpacity?: number;
  /** Show debug overlay with spatial index bounds and shape info. Default: false */
  showDebugOverlay?: boolean;
  /** Show lock indicators on locked shapes. Default: true */
  showLockIndicators?: boolean;
}

/**
 * Performance metrics for the renderer.
 */
export interface RenderMetrics {
  /** Current frames per second */
  fps: number;
  /** Time spent on last frame in milliseconds */
  frameTime: number;
  /** Number of render calls since last reset */
  frameCount: number;
}

/**
 * Callback type for tool overlay rendering.
 * Tools can use this to draw their overlays (e.g., selection box, guides).
 */
export type ToolOverlayCallback = (ctx: CanvasRenderingContext2D) => void;

const DEFAULT_OPTIONS: Required<RendererOptions> = {
  showGrid: true,
  gridSpacing: 50,
  majorGridInterval: 5,
  gridColor: '#e0e0e0',
  majorGridColor: '#c0c0c0',
  originColor: '#808080',
  backgroundColor: '#ffffff',
  showFps: false,
  selectionColor: '#2196f3',
  handleFillColor: '#ffffff',
  handleStrokeColor: '#2196f3',
  handleSize: 8,
  gridOpacity: 100,
  showDebugOverlay: false,
  showLockIndicators: true,
};

/**
 * Renderer handles all canvas rendering operations.
 *
 * The renderer uses requestAnimationFrame for efficient rendering,
 * coalescing multiple render requests into a single frame.
 *
 * Rendering flow:
 * 1. Clear canvas with background color
 * 2. Apply camera transform
 * 3. Draw grid (in world space)
 * 4. (Future) Draw shapes in z-order
 * 5. Restore transform
 * 6. (Future) Draw selection overlay (in screen space)
 * 7. Let active tool draw its overlay
 * 8. Draw FPS counter if enabled
 *
 * Usage:
 * ```typescript
 * const renderer = new Renderer(canvas, camera, { showGrid: true });
 *
 * // Request render when something changes
 * renderer.requestRender();
 *
 * // Set tool overlay callback
 * renderer.setToolOverlayCallback((ctx) => {
 *   // Draw tool-specific overlay
 * });
 *
 * // Clean up
 * renderer.destroy();
 * ```
 */
export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private camera: Camera;
  private options: Required<RendererOptions>;

  // Render state
  private frameId: number | null = null;
  private needsRender: boolean = false;
  private destroyed: boolean = false;

  // DPI scaling factor
  private dpi: number = 1;

  // Tool overlay callback
  private toolOverlayCallback: ToolOverlayCallback | null = null;

  // Cleanup callback for icon load subscription
  private unsubscribeIconLoad: (() => void) | null = null;
  private unsubscribeThumbnailLoad: (() => void) | null = null;

  // Shape data for rendering
  private shapes: Record<string, Shape> = {};
  private shapeOrder: string[] = [];
  private selectedIds: Set<string> = new Set();

  // Deferred "overlay" shapes collected during the z-order pass and drawn on
  // top afterwards (e.g. connector labels, so they sit above other connectors'
  // lines instead of being buried — JP-353). Reused across frames (cleared via
  // `length = 0`) to avoid per-frame allocation; holds already-resolved shapes.
  private overlays: Shape[] = [];

  // Emphasis animation
  private emphasizedShapeId: string | null = null;
  private emphasisStartTime: number = 0;

  // Contrast resolution cache for AUTO colours. Persisted across frames and
  // cleared only when the inputs that affect resolution change (shape data,
  // z-order, page background) — never on camera pan/zoom — so a static scene
  // does not re-resolve AUTO colours O(connectors × shapes) every frame.
  // The `lastContrast*` fields hold the inputs the live cache was populated
  // against; a reference/value mismatch on a frame triggers a clear.
  private contrastCache: ContrastCache = new ContrastCache();
  private lastContrastShapes: Record<string, Shape> | null = null;
  private lastContrastShapeOrder: string[] | null = null;
  private lastContrastPageBackground: string | null = null;

  // Performance metrics
  private lastFrameTime: number = 0;
  private frameCount: number = 0;
  private fpsUpdateTime: number = 0;
  private currentFps: number = 0;
  private lastFrameDuration: number = 0;

  constructor(
    canvas: HTMLCanvasElement,
    camera: Camera,
    options?: RendererOptions
  ) {
    this.canvas = canvas;
    this.camera = camera;
    this.options = { ...DEFAULT_OPTIONS, ...options };

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get 2D rendering context');
    }
    this.ctx = ctx;

    // Initialize timing
    this.lastFrameTime = performance.now();
    this.fpsUpdateTime = this.lastFrameTime;

    // Register LaTeX render callback for async equation rendering
    setLatexRenderCallback(() => this.requestRender());

    // Re-render when icons finish loading asynchronously
    this.unsubscribeIconLoad = onIconLoad(() => this.requestRender());

    // Re-render when FileShape thumbnails resolve (blob:// → object URL) asynchronously
    this.unsubscribeThumbnailLoad = onThumbnailLoad(() => this.requestRender());
  }

  /**
   * Request a render on the next animation frame.
   * Multiple requests within a single frame are coalesced.
   */
  requestRender(): void {
    if (this.destroyed) return;
    if (this.needsRender) return;

    this.needsRender = true;
    this.frameId = requestAnimationFrame((timestamp) => this.render(timestamp));
  }

  /**
   * Force an immediate synchronous render.
   * Use sparingly - prefer requestRender() for most cases.
   */
  renderNow(): void {
    if (this.destroyed) return;

    // Cancel any pending frame
    if (this.frameId !== null) {
      cancelAnimationFrame(this.frameId);
      this.frameId = null;
    }
    this.needsRender = false;

    this.render(performance.now());
  }

  /**
   * Set the callback for tool overlay rendering.
   * The callback receives the canvas context with screen-space transform.
   */
  setToolOverlayCallback(callback: ToolOverlayCallback | null): void {
    this.toolOverlayCallback = callback;
  }

  /**
   * Update renderer options.
   */
  setOptions(options: Partial<RendererOptions>): void {
    this.options = { ...this.options, ...options };
  }

  /**
   * Get current performance metrics.
   */
  getMetrics(): RenderMetrics {
    return {
      fps: this.currentFps,
      frameTime: this.lastFrameDuration,
      frameCount: this.frameCount,
    };
  }

  /**
   * Reset performance metrics.
   */
  resetMetrics(): void {
    this.frameCount = 0;
    this.currentFps = 0;
    this.lastFrameDuration = 0;
    this.fpsUpdateTime = performance.now();
  }

  /**
   * Update the camera reference.
   */
  setCamera(camera: Camera): void {
    this.camera = camera;
  }

  /**
   * Set the DPI scaling factor for high-DPI displays.
   * This should match window.devicePixelRatio.
   */
  setDpi(dpi: number): void {
    this.dpi = dpi;
  }

  /**
   * Set the shapes to render.
   * @param shapes - Map of shape ID to shape data
   * @param shapeOrder - Array of shape IDs in z-order (first = bottom)
   */
  setShapes(shapes: Record<string, Shape>, shapeOrder: string[]): void {
    this.shapes = shapes;
    this.shapeOrder = shapeOrder;
  }

  /**
   * Set the selected shape IDs for rendering selection overlays.
   * @param selectedIds - Set of selected shape IDs
   */
  setSelection(selectedIds: Set<string>): void {
    this.selectedIds = selectedIds;
  }

  /**
   * Set the emphasized shape ID for focus animation.
   * @param shapeId - ID of shape to emphasize, or null to clear
   */
  setEmphasis(shapeId: string | null): void {
    if (shapeId !== this.emphasizedShapeId) {
      this.emphasizedShapeId = shapeId;
      this.emphasisStartTime = performance.now();
      if (shapeId) {
        // Trigger continuous rendering for animation
        this.requestRender();
      }
    }
  }

  /**
   * Check if a render is pending.
   */
  get isPending(): boolean {
    return this.needsRender;
  }

  /**
   * Check if the renderer has been destroyed.
   */
  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /**
   * Clean up the renderer.
   * Cancels any pending animation frame.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.frameId !== null) {
      cancelAnimationFrame(this.frameId);
      this.frameId = null;
    }
    this.needsRender = false;
    this.toolOverlayCallback = null;
    this.unsubscribeIconLoad?.();
    this.unsubscribeIconLoad = null;
    this.unsubscribeThumbnailLoad?.();
    this.unsubscribeThumbnailLoad = null;
  }

  /**
   * Main render loop.
   */
  private render(timestamp: number): void {
    this.needsRender = false;
    this.frameId = null;

    if (this.destroyed) return;

    // Update performance metrics
    this.updateMetrics(timestamp);

    const { ctx, canvas, camera, options, dpi } = this;

    // Use CSS dimensions from camera viewport
    // Fall back to canvas buffer dimensions / DPI if viewport not set yet
    let width = camera.screenWidth;
    let height = camera.screenHeight;

    if (width === 0 || height === 0) {
      // Fallback to canvas dimensions (buffer pixels / DPI = CSS pixels)
      width = canvas.width / dpi;
      height = canvas.height / dpi;

      // Update camera viewport to match
      if (width > 0 && height > 0) {
        camera.setViewport(width, height);
      }
    }

    // Skip rendering if canvas has no size
    if (width === 0 || height === 0) return;

    // Reset transform and apply DPI scaling at start of each frame
    // This ensures all drawing is properly scaled for high-DPI displays
    ctx.setTransform(dpi, 0, 0, dpi, 0, 0);

    // 1. Clear canvas with background color (in CSS pixels)
    ctx.fillStyle = options.backgroundColor;
    ctx.fillRect(0, 0, width, height);

    // 2. Apply camera transform and draw world-space content
    ctx.save();
    this.applyCameraTransform();

    // 3. Draw grid in world space
    if (options.showGrid) {
      this.drawGrid();
    }

    // 4. Draw shapes in z-order with viewport culling.
    // Publish per-frame render context so shape handlers can resolve AUTO colors.
    // Invalidate the contrast cache only when an input that affects AUTO-colour
    // resolution changed since the last populated frame — shape data, z-order,
    // or the page background. These references are set via `setShapes` on
    // document mutations; camera pan/zoom leaves them untouched, so panning a
    // static scene keeps the resolved colours cached instead of re-resolving
    // every frame.
    const pageBackground = options.backgroundColor;
    if (
      this.shapes !== this.lastContrastShapes ||
      this.shapeOrder !== this.lastContrastShapeOrder ||
      pageBackground !== this.lastContrastPageBackground
    ) {
      this.contrastCache.clear();
      this.lastContrastShapes = this.shapes;
      this.lastContrastShapeOrder = this.shapeOrder;
      this.lastContrastPageBackground = pageBackground;
    }
    setRenderContext({
      shapes: this.shapes,
      shapeOrder: this.shapeOrder,
      pageBackground,
      contrastCache: this.contrastCache,
    });
    try {
      this.drawShapes();
    } finally {
      setRenderContext(null);
    }

    // 4.5. Draw lock indicators on locked shapes (in world space)
    if (options.showLockIndicators) {
      this.drawLockIndicators();
    }

    // 4.6. Draw debug overlay (spatial index bounds) in world space
    if (options.showDebugOverlay) {
      this.drawDebugOverlay();
    }

    // 5. Restore transform for screen-space drawing (back to DPI-scaled screen space)
    ctx.restore();

    // 6. Draw selection overlay (in world space, applied manually)
    this.drawSelectionOverlay();

    // 6.5. Draw emphasis animation if active
    if (this.emphasizedShapeId) {
      this.drawEmphasisAnimation(timestamp);
    }

    // 7. Let active tool draw its overlay (screen space)
    if (this.toolOverlayCallback) {
      ctx.save();
      this.toolOverlayCallback(ctx);
      ctx.restore();
    }

    // 8. Draw FPS counter if enabled
    if (options.showFps) {
      this.drawFpsCounter();
    }
  }

  /**
   * Apply the camera transformation to the canvas context.
   * Uses applyToContext (ctx.transform) to multiply with existing DPI transform,
   * rather than setOnContext (ctx.setTransform) which would replace it.
   */
  private applyCameraTransform(): void {
    const matrix = this.camera.getTransformMatrix();
    // Use applyToContext to multiply with existing DPI transform
    matrix.applyToContext(this.ctx);
  }

  /**
   * Draw the background grid.
   * Grid is drawn in world space with both minor and major lines.
   */
  private drawGrid(): void {
    const { ctx, options } = this;
    const { gridSpacing, majorGridInterval, gridColor, majorGridColor, gridOpacity } =
      options;

    // Skip drawing if opacity is 0
    if (gridOpacity <= 0) return;

    // Get visible bounds in world space
    const bounds = this.camera.getVisibleBounds();

    // Expand bounds slightly to ensure grid covers edges during pan
    const padding = gridSpacing;
    const gridBounds = new Box(
      bounds.minX - padding,
      bounds.minY - padding,
      bounds.maxX + padding,
      bounds.maxY + padding
    );

    // Calculate grid line positions (snap to grid spacing)
    const startX = Math.floor(gridBounds.minX / gridSpacing) * gridSpacing;
    const startY = Math.floor(gridBounds.minY / gridSpacing) * gridSpacing;
    const endX = Math.ceil(gridBounds.maxX / gridSpacing) * gridSpacing;
    const endY = Math.ceil(gridBounds.maxY / gridSpacing) * gridSpacing;

    // Adaptive line width based on zoom
    const zoom = this.camera.zoom;
    const baseLineWidth = 1 / zoom; // Constant screen-space width

    // Apply grid opacity
    const opacity = gridOpacity / 100;
    ctx.save();
    ctx.globalAlpha = opacity;

    // Draw minor grid lines
    ctx.beginPath();
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = baseLineWidth;

    for (let x = startX; x <= endX; x += gridSpacing) {
      // Skip major lines (will be drawn separately)
      const gridIndex = Math.round(x / gridSpacing);
      if (gridIndex % majorGridInterval === 0) continue;

      ctx.moveTo(x, gridBounds.minY);
      ctx.lineTo(x, gridBounds.maxY);
    }

    for (let y = startY; y <= endY; y += gridSpacing) {
      const gridIndex = Math.round(y / gridSpacing);
      if (gridIndex % majorGridInterval === 0) continue;

      ctx.moveTo(gridBounds.minX, y);
      ctx.lineTo(gridBounds.maxX, y);
    }

    ctx.stroke();

    // Draw major grid lines
    ctx.beginPath();
    ctx.strokeStyle = majorGridColor;
    ctx.lineWidth = baseLineWidth * 1.5;

    const majorSpacing = gridSpacing * majorGridInterval;
    const majorStartX = Math.floor(gridBounds.minX / majorSpacing) * majorSpacing;
    const majorStartY = Math.floor(gridBounds.minY / majorSpacing) * majorSpacing;

    for (let x = majorStartX; x <= endX; x += majorSpacing) {
      ctx.moveTo(x, gridBounds.minY);
      ctx.lineTo(x, gridBounds.maxY);
    }

    for (let y = majorStartY; y <= endY; y += majorSpacing) {
      ctx.moveTo(gridBounds.minX, y);
      ctx.lineTo(gridBounds.maxX, y);
    }

    ctx.stroke();

    // Draw origin crosshair (thicker line at x=0 and y=0)
    if (gridBounds.minX <= 0 && gridBounds.maxX >= 0) {
      ctx.beginPath();
      ctx.strokeStyle = options.originColor;
      ctx.lineWidth = baseLineWidth * 2;
      ctx.moveTo(0, gridBounds.minY);
      ctx.lineTo(0, gridBounds.maxY);
      ctx.stroke();
    }

    if (gridBounds.minY <= 0 && gridBounds.maxY >= 0) {
      ctx.beginPath();
      ctx.strokeStyle = options.originColor;
      ctx.lineWidth = baseLineWidth * 2;
      ctx.moveTo(gridBounds.minX, 0);
      ctx.lineTo(gridBounds.maxX, 0);
      ctx.stroke();
    }

    // Restore context (opacity)
    ctx.restore();
  }

  /**
   * If the shape uses the AUTO color sentinel for fill or stroke, return a
   * shallow clone with those values resolved against the current frame's
   * background. Connectors and groups handle AUTO themselves (per-segment
   * stroke for connectors, dynamic background lookup for groups), so they
   * are returned unchanged.
   */
  private resolveAutoFillStroke<T extends Shape>(shape: T): T {
    if (isConnector(shape) || isGroup(shape)) return shape;

    const fillIsAuto = isAutoColor(shape.fill);
    const strokeIsAuto = isAutoColor(shape.stroke);
    // `labelColor` is optional on rectangle/ellipse/file/library shapes.
    // Pre-resolving it here keeps shape handlers ignorant of the AUTO sentinel.
    const labelColorIsAuto =
      'labelColor' in shape && isAutoColor((shape as { labelColor?: string }).labelColor);
    if (!fillIsAuto && !strokeIsAuto && !labelColorIsAuto) return shape;

    const point = { x: shape.x, y: shape.y };
    const resolved = this.contrastCache.resolve(
      point,
      this.shapes,
      this.shapeOrder,
      this.options.backgroundColor,
      shape.id
    );
    const next: T & { labelColor?: string } = { ...shape };
    if (fillIsAuto) next.fill = resolved;
    if (strokeIsAuto) next.stroke = resolved;
    if (labelColorIsAuto) next.labelColor = resolved;
    return next;
  }

  /**
   * Draw all shapes in z-order with viewport culling.
   * Shapes outside the visible bounds are skipped for performance.
   */
  private drawShapes(): void {
    const { ctx, shapes, shapeOrder, camera } = this;

    if (shapeOrder.length === 0) return;

    // Reset the deferred-overlay collector for this frame (reuse the array).
    this.overlays.length = 0;

    // Get visible bounds for culling
    const visibleBounds = camera.getVisibleBounds();

    // Track rendering stats
    let rendered = 0;
    let culled = 0;

    // Render shapes in z-order (bottom to top)
    for (const id of shapeOrder) {
      const shape = shapes[id];
      if (!shape) continue;

      // Skip hidden shapes
      if (!shape.visible) {
        continue;
      }

      try {
        const handler = shapeRegistry.getHandler(shape.type);
        const bounds = handler.getBounds(shape);

        // Viewport culling - skip shapes outside visible bounds
        if (!visibleBounds.intersects(bounds)) {
          culled++;
          continue;
        }

        // Handle groups specially - render their children
        if (isGroup(shape)) {
          const stats = this.renderGroup(shape, visibleBounds);
          rendered += stats.rendered;
          culled += stats.culled;
        } else {
          // Render the shape. Resolve AUTO colours once and reuse the result
          // for both the body and any deferred overlay (avoids a second
          // contrast-cache resolve).
          const resolved = this.resolveAutoFillStroke(shape);
          ctx.save();
          handler.render(ctx, resolved);
          ctx.restore();
          if (handler.renderOverlay) this.overlays.push(resolved);
          rendered++;
        }
      } catch {
        // Shape type not registered - skip silently
      }
    }

    // Deferred overlay pass: draw collected overlays (e.g. connector labels) on
    // top of every shape body, in z-order amongst themselves (JP-353). Still
    // inside drawShapes, so the RenderContext set by the caller is live for any
    // overlay that re-resolves geometry.
    this.drawOverlays();

    // Could expose these stats via getMetrics() if needed
    void rendered;
    void culled;
  }

  /**
   * Draw the deferred overlays collected during the z-order pass. Each overlay
   * shape's handler is guaranteed to have `renderOverlay` (checked at collection
   * time). See `overlays` and JP-353.
   */
  private drawOverlays(): void {
    const { ctx } = this;
    for (const shape of this.overlays) {
      try {
        const handler = shapeRegistry.getHandler(shape.type);
        if (!handler.renderOverlay) continue;
        ctx.save();
        handler.renderOverlay(ctx, shape);
        ctx.restore();
      } catch {
        // Shape type not registered - skip silently
      }
    }
  }

  /**
   * Render a group and all its children recursively.
   * Uses two-pass rendering: background/border first, children, then label on top.
   * Children inherit the group's opacity.
   */
  private renderGroup(
    group: GroupShape,
    visibleBounds: Box,
    parentOpacity: number = 1
  ): { rendered: number; culled: number } {
    const { ctx, shapes } = this;
    let rendered = 0;
    let culled = 0;

    // Calculate effective opacity (multiply with parent)
    const effectiveOpacity = group.opacity * parentOpacity;

    // Pass 1: Render group background, border, and shadow (before children)
    try {
      const groupHandler = shapeRegistry.getHandler('group') as GroupShapeHandler;
      ctx.save();
      ctx.globalAlpha = effectiveOpacity;
      groupHandler.render(ctx, group);
      ctx.restore();
    } catch {
      // Group handler not available
    }

    // Pass 2: Render children
    for (const childId of group.childIds) {
      const child = shapes[childId];
      if (!child || !child.visible) continue;

      try {
        const handler = shapeRegistry.getHandler(child.type);
        const bounds = handler.getBounds(child);

        // Viewport culling
        if (!visibleBounds.intersects(bounds)) {
          culled++;
          continue;
        }

        // Handle nested groups recursively
        if (isGroup(child)) {
          const stats = this.renderGroup(child, visibleBounds, effectiveOpacity);
          rendered += stats.rendered;
          culled += stats.culled;
        } else {
          // Render the child with inherited opacity. Resolve AUTO colours once
          // and reuse for the deferred overlay (JP-353) — without collecting
          // here, a group-child connector's label would render nowhere, since
          // the label moved out of `render` into `renderOverlay`.
          const resolved = this.resolveAutoFillStroke(child);
          ctx.save();
          ctx.globalAlpha = child.opacity * effectiveOpacity;
          handler.render(ctx, resolved);
          ctx.restore();
          if (handler.renderOverlay) this.overlays.push(resolved);
          rendered++;
        }
      } catch {
        // Skip unregistered shape types
      }
    }

    // Pass 3: Render group label on top of children
    if (group.label) {
      try {
        const groupHandler = shapeRegistry.getHandler('group') as GroupShapeHandler;
        if (groupHandler.renderLabel) {
          ctx.save();
          groupHandler.renderLabel(ctx, group, parentOpacity);
          ctx.restore();
        }
      } catch {
        // Group handler not available
      }
    }

    return { rendered, culled };
  }

  /**
   * Draw selection overlay for selected shapes.
   * Draws bounding boxes and handles in world space.
   */
  private drawSelectionOverlay(): void {
    const { ctx, shapes, selectedIds, options, camera } = this;

    if (selectedIds.size === 0) return;

    // Apply camera transform for world-space drawing
    ctx.save();
    this.applyCameraTransform();

    const zoom = camera.zoom;
    // Handle size in world units (constant screen size)
    const handleSize = options.handleSize / zoom;
    const halfHandle = handleSize / 2;
    const strokeWidth = 1 / zoom;

    for (const id of selectedIds) {
      const shape = shapes[id];
      if (!shape) continue;

      try {
        const handler = shapeRegistry.getHandler(shape.type);
        const bounds = handler.getBounds(shape);

        // Draw bounding box
        ctx.beginPath();
        ctx.strokeStyle = options.selectionColor;
        ctx.lineWidth = strokeWidth;
        ctx.setLineDash([4 / zoom, 4 / zoom]);
        ctx.rect(bounds.minX, bounds.minY, bounds.width, bounds.height);
        ctx.stroke();
        ctx.setLineDash([]);

        // Draw handles
        const handles = handler.getHandles(shape);
        let topHandle: { x: number; y: number } | null = null;
        let rotationHandle: { x: number; y: number } | null = null;

        for (const handle of handles) {
          if (handle.type === 'rotation') {
            rotationHandle = { x: handle.x, y: handle.y };
            continue;
          }

          // Track the top handle for connecting line to rotation handle
          if (handle.type === 'top') {
            topHandle = { x: handle.x, y: handle.y };
          }

          // Check for custom line-style handles (lane dividers, header resize)
          if (handle.metadata?.style === 'line') {
            this.drawLineHandle(ctx, handle, zoom, options);
            continue;
          }

          // Draw resize handles as squares
          ctx.beginPath();
          ctx.fillStyle = options.handleFillColor;
          ctx.strokeStyle = options.handleStrokeColor;
          ctx.lineWidth = strokeWidth;
          ctx.rect(
            handle.x - halfHandle,
            handle.y - halfHandle,
            handleSize,
            handleSize
          );
          ctx.fill();
          ctx.stroke();
        }

        // Draw rotation handle if present
        if (rotationHandle) {
          // Draw connecting line from top handle to rotation handle
          if (topHandle) {
            ctx.beginPath();
            ctx.strokeStyle = options.handleStrokeColor;
            ctx.lineWidth = strokeWidth;
            ctx.moveTo(topHandle.x, topHandle.y);
            ctx.lineTo(rotationHandle.x, rotationHandle.y);
            ctx.stroke();
          }

          // Draw rotation handle as a circle
          ctx.beginPath();
          ctx.fillStyle = options.handleFillColor;
          ctx.strokeStyle = options.handleStrokeColor;
          ctx.lineWidth = strokeWidth;
          ctx.arc(rotationHandle.x, rotationHandle.y, halfHandle, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      } catch {
        // Shape type not registered - skip silently
      }
    }

    ctx.restore();
  }

  /**
   * Draw a line-style handle for custom shape operations (lane dividers, header resize).
   * Renders as a short line with grip dots to indicate draggability.
   */
  private drawLineHandle(
    ctx: CanvasRenderingContext2D,
    handle: Handle,
    zoom: number,
    options: Required<RendererOptions>
  ): void {
    const lineLength = 24 / zoom;
    const lineWidth = 3 / zoom;
    const dotRadius = 2 / zoom;
    const dotSpacing = 6 / zoom;

    // Determine orientation based on cursor
    const isVertical = handle.cursor === 'col-resize';

    ctx.save();

    // Draw the handle line
    ctx.beginPath();
    ctx.strokeStyle = options.handleStrokeColor;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';

    if (isVertical) {
      ctx.moveTo(handle.x, handle.y - lineLength / 2);
      ctx.lineTo(handle.x, handle.y + lineLength / 2);
    } else {
      ctx.moveTo(handle.x - lineLength / 2, handle.y);
      ctx.lineTo(handle.x + lineLength / 2, handle.y);
    }
    ctx.stroke();

    // Draw grip dots along the line
    ctx.fillStyle = options.handleFillColor;
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      if (isVertical) {
        ctx.arc(handle.x, handle.y + i * dotSpacing, dotRadius, 0, Math.PI * 2);
      } else {
        ctx.arc(handle.x + i * dotSpacing, handle.y, dotRadius, 0, Math.PI * 2);
      }
      ctx.fill();
    }

    ctx.restore();
  }

  /**
   * Draw emphasis animation for focused shape.
   * Creates a pulsing ring effect around the shape.
   */
  private drawEmphasisAnimation(timestamp: number): void {
    const { ctx, shapes, camera, emphasizedShapeId, emphasisStartTime } = this;

    if (!emphasizedShapeId) return;

    // Reduced-motion / low-power: skip the attention pulse entirely and snap
    // back to the resting (no-ring) state rather than running the timed loop.
    if (getAdaptiveBudget().reduceMotion) {
      this.emphasizedShapeId = null;
      return;
    }

    const shape = shapes[emphasizedShapeId];
    if (!shape) {
      this.emphasizedShapeId = null;
      return;
    }

    // Calculate animation progress (1.5 seconds duration)
    const duration = 1500;
    const elapsed = timestamp - emphasisStartTime;
    const progress = Math.min(elapsed / duration, 1);

    // Stop animation after completion
    if (progress >= 1) {
      this.emphasizedShapeId = null;
      return;
    }

    // Continue rendering for animation
    this.requestRender();

    try {
      const handler = shapeRegistry.getHandler(shape.type);
      const bounds = handler.getBounds(shape);

      // Apply camera transform
      ctx.save();
      this.applyCameraTransform();

      const zoom = camera.zoom;
      const strokeWidth = 3 / zoom;

      // Pulsing effect: expand outward and fade
      const pulsePhase = Math.sin(progress * Math.PI * 3); // 3 pulses
      const expansion = (10 + pulsePhase * 5) / zoom;
      const alpha = 1 - progress;

      // Draw expanding ring
      ctx.beginPath();
      ctx.strokeStyle = `rgba(33, 150, 243, ${alpha * 0.8})`;
      ctx.lineWidth = strokeWidth;
      ctx.rect(
        bounds.minX - expansion,
        bounds.minY - expansion,
        bounds.width + expansion * 2,
        bounds.height + expansion * 2
      );
      ctx.stroke();

      // Draw inner glow
      ctx.beginPath();
      ctx.strokeStyle = `rgba(33, 150, 243, ${alpha * 0.4})`;
      ctx.lineWidth = strokeWidth * 2;
      ctx.rect(
        bounds.minX - expansion / 2,
        bounds.minY - expansion / 2,
        bounds.width + expansion,
        bounds.height + expansion
      );
      ctx.stroke();

      ctx.restore();
    } catch {
      // Shape type not registered - skip silently
      this.emphasizedShapeId = null;
    }
  }

  /**
   * Draw lock indicators on locked shapes.
   * Shows a small lock icon at the top-right corner of locked shapes.
   */
  private drawLockIndicators(): void {
    const { ctx, shapes, shapeOrder, camera } = this;
    const zoom = camera.zoom;
    const iconSize = 14 / zoom;

    for (const id of shapeOrder) {
      const shape = shapes[id];
      if (!shape || !shape.visible) continue;

      const isLocked = shape.locked || shape.lockedPosition || shape.lockedSize;
      if (!isLocked) continue;

      try {
        const handler = shapeRegistry.getHandler(shape.type);
        const bounds = handler.getBounds(shape);

        const x = bounds.maxX - iconSize * 0.5;
        const y = bounds.minY - iconSize * 0.5;

        ctx.save();

        // Draw icon background circle
        ctx.fillStyle = shape.locked ? 'rgba(220, 50, 50, 0.8)' : 'rgba(220, 160, 50, 0.8)';
        ctx.beginPath();
        ctx.arc(x, y, iconSize * 0.6, 0, Math.PI * 2);
        ctx.fill();

        // Draw lock symbol (simple padlock)
        const s = iconSize * 0.25;
        ctx.strokeStyle = '#fff';
        ctx.fillStyle = '#fff';
        ctx.lineWidth = 1.5 / zoom;

        // Lock body (filled rect)
        ctx.fillRect(x - s, y - s * 0.2, s * 2, s * 1.4);

        // Lock shackle (arc)
        ctx.beginPath();
        ctx.arc(x, y - s * 0.5, s * 0.7, Math.PI, 0);
        ctx.stroke();

        ctx.restore();
      } catch {
        // Skip shapes without handlers
      }
    }
  }

  /**
   * Draw debug overlay showing spatial index bounds.
   */
  private drawDebugOverlay(): void {
    const { ctx, shapes, shapeOrder, camera } = this;
    const zoom = camera.zoom;

    ctx.save();
    ctx.strokeStyle = 'rgba(255, 0, 255, 0.3)';
    ctx.lineWidth = 1 / zoom;
    ctx.setLineDash([4 / zoom, 4 / zoom]);

    for (const id of shapeOrder) {
      const shape = shapes[id];
      if (!shape || !shape.visible) continue;

      try {
        const handler = shapeRegistry.getHandler(shape.type);
        const bounds = handler.getBounds(shape);
        ctx.strokeRect(bounds.minX, bounds.minY, bounds.width, bounds.height);
      } catch {
        // Skip
      }
    }

    ctx.restore();
  }

  /**
   * Draw FPS counter in screen space.
   */
  private drawFpsCounter(): void {
    const { ctx } = this;
    const text = `${Math.round(this.currentFps)} FPS`;

    ctx.save();

    // Background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(10, 10, 70, 24);

    // Text
    ctx.fillStyle = '#00ff00';
    ctx.font = '14px monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 16, 22);

    ctx.restore();
  }

  /**
   * Update performance metrics.
   */
  private updateMetrics(timestamp: number): void {
    // Calculate frame duration
    this.lastFrameDuration = timestamp - this.lastFrameTime;
    this.lastFrameTime = timestamp;
    this.frameCount++;

    // Update FPS every 500ms
    const fpsElapsed = timestamp - this.fpsUpdateTime;
    if (fpsElapsed >= 500) {
      // Calculate FPS from last frame time
      this.currentFps = this.lastFrameDuration > 0 ? 1000 / this.lastFrameDuration : 0;
      this.fpsUpdateTime = timestamp;
    }
  }
}
