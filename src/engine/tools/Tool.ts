import { Camera } from '../Camera';
import { Renderer } from '../Renderer';
import { HitTester } from '../HitTester';
import { SpatialIndex } from '../SpatialIndex';
import { NormalizedPointerEvent } from '../InputHandler';
import { Vec2 } from '../../math/Vec2';
import { Shape } from '../../shapes/Shape';
import { ToolType, CursorStyle, SnapSettings, SnapGuides } from '../../store/sessionStore';

/**
 * Context passed to tools providing access to engine components.
 * Tools use this context to interact with the canvas, camera, stores, etc.
 */
export interface ToolContext {
  /** Camera for coordinate transforms */
  camera: Camera;
  /** Renderer for requesting renders */
  renderer: Renderer;
  /** Hit tester for shape/handle detection */
  hitTester: HitTester;
  /** Spatial index for fast queries */
  spatialIndex: SpatialIndex;

  // Store accessors (to avoid tight coupling)
  /** Get current shapes */
  getShapes: () => Record<string, Shape>;
  /** Get shape order (z-order) */
  getShapeOrder: () => string[];
  /** Get selected shape IDs */
  getSelectedIds: () => string[];
  /** Get shapes by their IDs */
  getSelectedShapes: () => Shape[];

  // Store mutations
  /** Select shapes (replaces selection) */
  select: (ids: string[]) => void;
  /** Add to current selection */
  addToSelection: (ids: string[]) => void;
  /** Remove from selection */
  removeFromSelection: (ids: string[]) => void;
  /** Clear selection */
  clearSelection: () => void;
  /** Add a new shape */
  addShape: (shape: Shape) => void;
  /** Update a shape */
  updateShape: (id: string, updates: Partial<Shape>) => void;
  /** Update multiple shapes */
  updateShapes: (updates: Array<{ id: string; updates: Partial<Shape> }>) => void;
  /** Delete a shape */
  deleteShape: (id: string) => void;
  /** Delete multiple shapes */
  deleteShapes: (ids: string[]) => void;

  // UI state
  /** Set the cursor style */
  setCursor: (cursor: CursorStyle) => void;
  /** Set interaction state */
  setIsInteracting: (isInteracting: boolean) => void;
  /** Switch to a different tool */
  setActiveTool: (tool: ToolType) => void;
  /** Start inline text editing for a text shape */
  startTextEdit: (id: string) => void;
  /** Open the file viewer modal for a file shape */
  openFileViewer: (id: string) => void;

  // Snapping
  /** Get current snap settings */
  getSnapSettings: () => SnapSettings;
  /** Set active snap guides for rendering */
  setSnapGuides: (guides: SnapGuides) => void;
  /** Clear snap guides */
  clearSnapGuides: () => void;

  // Rendering
  /** Request a render on the next animation frame */
  requestRender: () => void;

  // History
  /** Push current state to history stack (call before making changes) */
  pushHistory: (description?: string) => void;
}

/**
 * Base interface for all tools.
 *
 * Tools are state machines that respond to input events.
 * Each tool type implements this interface to provide specific
 * functionality (selection, panning, shape creation, etc.).
 *
 * Lifecycle:
 * 1. onActivate() - Called when tool becomes active
 * 2. Event handlers (onPointerDown, onPointerMove, etc.) - Called for each input event
 * 3. onDeactivate() - Called when switching away from this tool
 *
 * Tools can draw overlays using renderOverlay() which is called each frame
 * after shapes are rendered.
 */
export interface Tool {
  /** Unique identifier for this tool type */
  readonly type: ToolType;

  /** Display name for UI */
  readonly name: string;

  /** Keyboard shortcut (single key, lowercase) */
  readonly shortcut?: string;

  /**
   * Called when the tool becomes active.
   * Use this to initialize state, set cursor, etc.
   */
  onActivate(ctx: ToolContext): void;

  /**
   * Called when switching away from this tool.
   * Use this to clean up state, reset cursor, etc.
   */
  onDeactivate(ctx: ToolContext): void;

  /**
   * Handle pointer down (mouse/touch/pen start).
   * @param event - Normalized pointer event with screen and world coordinates
   * @param ctx - Tool context for engine interaction
   */
  onPointerDown(event: NormalizedPointerEvent, ctx: ToolContext): void;

  /**
   * Handle pointer move (mouse/touch/pen drag or hover).
   * @param event - Normalized pointer event
   * @param ctx - Tool context
   */
  onPointerMove(event: NormalizedPointerEvent, ctx: ToolContext): void;

  /**
   * Handle pointer up (mouse/touch/pen end).
   * @param event - Normalized pointer event
   * @param ctx - Tool context
   */
  onPointerUp(event: NormalizedPointerEvent, ctx: ToolContext): void;

  /**
   * Handle keyboard events.
   * @param event - The keyboard event
   * @param ctx - Tool context
   * @returns true if the event was handled, false to allow propagation
   */
  onKeyDown?(event: KeyboardEvent, ctx: ToolContext): boolean;

  /**
   * Handle key up events.
   * @param event - The keyboard event
   * @param ctx - Tool context
   * @returns true if the event was handled, false to allow propagation
   */
  onKeyUp?(event: KeyboardEvent, ctx: ToolContext): boolean;

  /**
   * Handle wheel events (scroll/zoom).
   * @param event - The wheel event
   * @param worldPoint - Point in world coordinates
   * @param ctx - Tool context
   * @returns true if the event was handled, false to allow propagation
   */
  onWheel?(event: WheelEvent, worldPoint: Vec2, ctx: ToolContext): boolean;

  /**
   * Render tool-specific overlay (selection box, guides, etc.).
   * Called each frame after shapes are rendered.
   * The context is in screen space (no camera transform applied).
   *
   * @param ctx2d - Canvas 2D rendering context
   * @param toolCtx - Tool context
   */
  renderOverlay?(ctx2d: CanvasRenderingContext2D, toolCtx: ToolContext): void;
}

/**
 * Base class for tools that provides default no-op implementations.
 * Extend this to avoid implementing every method.
 */
export abstract class BaseTool implements Tool {
  abstract readonly type: ToolType;
  abstract readonly name: string;
  readonly shortcut?: string;

  onActivate(_ctx: ToolContext): void {
    // Default: no-op
  }

  onDeactivate(_ctx: ToolContext): void {
    // Default: no-op
  }

  onPointerDown(_event: NormalizedPointerEvent, _ctx: ToolContext): void {
    // Default: no-op
  }

  onPointerMove(_event: NormalizedPointerEvent, _ctx: ToolContext): void {
    // Default: no-op
  }

  onPointerUp(_event: NormalizedPointerEvent, _ctx: ToolContext): void {
    // Default: no-op
  }

  onKeyDown(_event: KeyboardEvent, _ctx: ToolContext): boolean {
    return false;
  }

  onKeyUp(_event: KeyboardEvent, _ctx: ToolContext): boolean {
    return false;
  }

  onWheel(_event: WheelEvent, _worldPoint: Vec2, _ctx: ToolContext): boolean {
    return false;
  }

  renderOverlay?(_ctx2d: CanvasRenderingContext2D, _toolCtx: ToolContext): void;
}
