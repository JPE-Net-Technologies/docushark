import { Camera } from './Camera';
import { Renderer } from './Renderer';
import { InputHandler, NormalizedPointerEvent } from './InputHandler';
import { SpatialIndex } from './SpatialIndex';
import { HitTester } from './HitTester';
import { ToolManager } from './ToolManager';
import { ToolContext } from './tools/Tool';
import { PanTool } from './tools/PanTool';
import { SelectTool } from './tools/SelectTool';
import { RectangleTool } from './tools/RectangleTool';
import { EllipseTool } from './tools/EllipseTool';
import { LineTool } from './tools/LineTool';
import { TextTool } from './tools/TextTool';
import { ConnectorTool } from './tools/ConnectorTool';
import { LibraryShapeTool } from './tools/LibraryShapeTool';
import { CustomShapeTool } from './tools/CustomShapeTool';
import { Vec2 } from '../math/Vec2';
import { Shape, isConnector, isGroup, ConnectorShape } from '../shapes/Shape';
import { updateConnectorEndpoints } from '../shapes/Connector';
import { calculateConnectorWaypoints } from './OrthogonalRouter';
import { useDocumentStore } from '../store/documentStore';
import { useSessionStore, ToolType, deleteSelected } from '../store/sessionStore';
import { useHistoryStore, pushHistory } from '../store/historyStore';
import { useShapeLibraryStore } from '../store/shapeLibraryStore';
import { useCustomShapeLibraryStore } from '../store/customShapeLibraryStore';
import { useWhiteboardStore } from '../store/whiteboardStore';
import { nanoid } from 'nanoid';

// Import shape handlers to register them
import '../shapes/Rectangle';
import '../shapes/Ellipse';
import '../shapes/Line';
import '../shapes/Text';
import '../shapes/Connector';
import '../shapes/Group';
import '../shapes/FileShape';

// Clipboard for copy/paste (module-level to persist across operations)
let clipboard: Shape[] = [];

/**
 * Configuration options for the Engine.
 */
export interface EngineOptions {
  /** Whether to show the background grid */
  showGrid?: boolean;
  /** Whether to show the FPS counter */
  showFps?: boolean;
  /** Initial tool type */
  initialTool?: ToolType;
}

const DEFAULT_OPTIONS: Required<EngineOptions> = {
  showGrid: true,
  showFps: false,
  initialTool: 'select',
};

/** Pan speed in world units per frame */
const PAN_SPEED = 10;

/** Nudge speed for translating shapes (world units) */
const NUDGE_AMOUNT = 10;

/** Zoom speed per frame (multiplier) */
const ZOOM_SPEED = 0.02;

/** Keys that trigger panning (WASD only - arrow keys nudge shapes when selected) */
const PAN_KEYS = new Set([
  'w', 'W', 'a', 'A', 's', 'S', 'd', 'D',
]);

/** Arrow keys for nudging shapes or panning if no selection */
const ARROW_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

/** Keys that trigger zooming */
const ZOOM_KEYS = new Set(['q', 'Q', 'e', 'E']);

/**
 * Compare two waypoint arrays for equality.
 */
function areWaypointsEqual(
  a: Array<{ x: number; y: number }> | undefined,
  b: Array<{ x: number; y: number }> | undefined
): boolean {
  if (a === b) return true;
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;

  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i]!.x - b[i]!.x) > 0.001 || Math.abs(a[i]!.y - b[i]!.y) > 0.001) {
      return false;
    }
  }

  return true;
}

/**
 * Main engine class that coordinates all components.
 *
 * The Engine:
 * - Initializes and owns all core components (Camera, Renderer, InputHandler, etc.)
 * - Wires up event handlers between components
 * - Subscribes to store changes and updates renderer
 * - Provides the ToolContext for tools to interact with the system
 * - Manages the application lifecycle
 *
 * Usage:
 * ```typescript
 * const engine = new Engine(canvas, {
 *   showGrid: true,
 *   showFps: true,
 *   initialTool: 'select',
 * });
 *
 * // Engine auto-registers default tools and subscribes to stores
 *
 * // Set canvas size on resize
 * engine.resize(width, height);
 *
 * // Clean up
 * engine.destroy();
 * ```
 */
export class Engine {
  // Core components
  readonly camera: Camera;
  readonly renderer: Renderer;
  readonly inputHandler: InputHandler;
  readonly spatialIndex: SpatialIndex;
  readonly hitTester: HitTester;
  readonly toolManager: ToolManager;

  // State
  private canvas: HTMLCanvasElement;
  private options: Required<EngineOptions>;
  private destroyed = false;

  // Store unsubscribe functions
  private unsubscribeDocument: (() => void) | null = null;
  private unsubscribeSession: (() => void) | null = null;

  // Track previous shapes for incremental spatial index updates
  private previousShapes: Record<string, Shape> = {};
  private previousShapeOrder: string[] = [];

  // Keyboard panning state
  private activePanKeys: Set<string> = new Set();
  private panAnimationId: number | null = null;

  // Global keyboard handler for shortcuts that need to intercept browser defaults
  private boundGlobalKeyDown: (e: KeyboardEvent) => void;

  constructor(canvas: HTMLCanvasElement, options?: EngineOptions) {
    this.canvas = canvas;
    this.options = { ...DEFAULT_OPTIONS, ...options };

    // Initialize camera
    this.camera = new Camera();

    // Initialize renderer
    this.renderer = new Renderer(canvas, this.camera, {
      showGrid: this.options.showGrid,
      showFps: this.options.showFps,
    });

    // Initialize spatial index and hit tester
    this.spatialIndex = new SpatialIndex();
    this.hitTester = new HitTester(this.spatialIndex);

    // Create tool context
    const toolContext = this.createToolContext();

    // Initialize tool manager
    this.toolManager = new ToolManager(toolContext);

    // Register default tools
    this.registerDefaultTools();

    // Initialize input handler
    this.inputHandler = new InputHandler(
      canvas,
      this.camera,
      (event) => this.handlePointerEvent(event),
      (event) => this.handleKeyEvent(event),
      (event, screenPoint, _worldPoint) => this.handleWheel(event, screenPoint)
    );

    // Subscribe to stores
    this.subscribeToStores();

    // Set initial tool
    this.toolManager.setActiveTool(this.options.initialTool);

    // Add global keyboard handler for shortcuts that need to intercept browser defaults
    this.boundGlobalKeyDown = this.handleGlobalKeyDown.bind(this);
    window.addEventListener('keydown', this.boundGlobalKeyDown);

    // Initial render
    this.syncFromStores();
    this.renderer.requestRender();
  }

  /**
   * Resize the canvas and update camera viewport.
   * @param width - CSS pixel width
   * @param height - CSS pixel height
   */
  resize(width: number, height: number): void {
    // Update camera viewport
    this.camera.setViewport(width, height);

    // Update canvas size (handling DPI)
    const dpi = window.devicePixelRatio || 1;
    this.canvas.width = width * dpi;
    this.canvas.height = height * dpi;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;

    // Update renderer DPI
    this.renderer.setDpi(dpi);

    // Request render
    this.renderer.requestRender();
  }

  /**
   * Set the active tool.
   */
  setActiveTool(type: ToolType): void {
    // Handle dynamic custom shape tools
    this.ensureCustomShapeToolRegistered(type);
    this.toolManager.setActiveTool(type);
    useSessionStore.getState().setActiveTool(type);
  }

  /**
   * Ensure a custom shape tool is registered if the type starts with 'custom-shape:'.
   * Returns true if the tool is ready (either already registered or successfully created).
   */
  private ensureCustomShapeToolRegistered(type: ToolType): boolean {
    // Only handle custom shape tool types
    if (!type.startsWith('custom-shape:')) {
      return true;
    }

    // Check if already registered
    if (this.toolManager.hasToolRegistered(type)) {
      return true;
    }

    // Extract item ID from tool type
    const itemId = type.slice('custom-shape:'.length);
    if (!itemId) {
      console.error('Invalid custom shape tool type:', type);
      return false;
    }

    // Get item from custom shape library store
    const store = useCustomShapeLibraryStore.getState();
    const item = store.itemsCache[itemId];

    if (!item) {
      console.error('Custom shape item not found:', itemId);
      return false;
    }

    // Create and register the tool
    const tool = new CustomShapeTool(item.id, item.name);
    this.toolManager.register(tool);
    return true;
  }

  /**
   * Get the active tool type.
   */
  getActiveTool(): ToolType | null {
    return this.toolManager.getActiveToolType();
  }

  /**
   * Force a render on the next animation frame.
   * Also syncs engine camera position back to sessionStore.
   */
  requestRender(): void {
    this.syncCameraToStore();
    this.renderer.requestRender();
  }

  /**
   * Sync the engine camera position back to the session store
   * so that UI code can read the current viewport center.
   */
  private syncCameraToStore(): void {
    const store = useSessionStore.getState();
    const cam = this.camera;
    if (store.camera.x !== cam.x || store.camera.y !== cam.y || store.camera.zoom !== cam.zoom) {
      store.setCamera({ x: cam.x, y: cam.y, zoom: cam.zoom });
    }
  }

  /**
   * Clean up the engine and all components.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    // Stop keyboard pan animation
    if (this.panAnimationId !== null) {
      cancelAnimationFrame(this.panAnimationId);
      this.panAnimationId = null;
    }
    this.activePanKeys.clear();

    // Remove global keyboard listener
    window.removeEventListener('keydown', this.boundGlobalKeyDown);

    // Unsubscribe from stores
    this.unsubscribeDocument?.();
    this.unsubscribeSession?.();

    // Destroy components
    this.toolManager.destroy();
    this.inputHandler.destroy();
    this.renderer.destroy();
  }

  // Private methods

  /**
   * Create the tool context that provides tools access to engine components.
   */
  private createToolContext(): ToolContext {
    const documentStore = useDocumentStore;
    const sessionStore = useSessionStore;

    return {
      camera: this.camera,
      renderer: this.renderer,
      hitTester: this.hitTester,
      spatialIndex: this.spatialIndex,

      // Store accessors
      getShapes: () => documentStore.getState().shapes,
      getShapeOrder: () => documentStore.getState().shapeOrder,
      getSelectedIds: () => sessionStore.getState().getSelectedIds(),
      getSelectedShapes: () => {
        const selectedIds = sessionStore.getState().getSelectedIds();
        const shapes = documentStore.getState().shapes;
        return selectedIds
          .map((id) => shapes[id])
          .filter((s): s is Shape => s !== undefined);
      },

      // Store mutations
      select: (ids) => sessionStore.getState().select(ids),
      addToSelection: (ids) => sessionStore.getState().addToSelection(ids),
      removeFromSelection: (ids) => sessionStore.getState().removeFromSelection(ids),
      clearSelection: () => sessionStore.getState().clearSelection(),
      addShape: (shape) => documentStore.getState().addShape(shape),
      updateShape: (id, updates) => documentStore.getState().updateShape(id, updates),
      updateShapes: (updates) => documentStore.getState().updateShapes(updates),
      deleteShape: (id) => documentStore.getState().deleteShape(id),
      deleteShapes: (ids) => documentStore.getState().deleteShapes(ids),

      // UI state
      setCursor: (cursor) => {
        sessionStore.getState().setCursor(cursor);
        this.canvas.style.cursor = cursor;
      },
      setIsInteracting: (isInteracting) =>
        sessionStore.getState().setIsInteracting(isInteracting),
      setActiveTool: (tool) => {
        // Handle dynamic custom shape tools
        this.ensureCustomShapeToolRegistered(tool);
        this.toolManager.setActiveTool(tool);
        sessionStore.getState().setActiveTool(tool);
      },
      startTextEdit: (id) => {
        sessionStore.getState().startTextEdit(id);
      },
      openFileViewer: (id) => {
        sessionStore.getState().openFileViewer(id);
      },

      // Snapping
      getSnapSettings: () => sessionStore.getState().snapSettings,
      setSnapGuides: (guides) => sessionStore.getState().setSnapGuides(guides),
      clearSnapGuides: () => sessionStore.getState().clearSnapGuides(),

      // Rendering
      requestRender: () => this.renderer.requestRender(),

      // History
      pushHistory: (description) => pushHistory(description),
    };
  }

  /**
   * Register the default tools.
   */
  private registerDefaultTools(): void {
    // Core tools
    this.toolManager.register(new SelectTool());
    this.toolManager.register(new PanTool());
    this.toolManager.register(new RectangleTool());
    this.toolManager.register(new EllipseTool());
    this.toolManager.register(new LineTool());
    this.toolManager.register(new TextTool());
    this.toolManager.register(new ConnectorTool());

    // Initialize shape library and register library shape tools
    useShapeLibraryStore.getState().initialize();

    // Re-fetch state after initialization to get updated registeredDefinitions
    // (Zustand creates a new state object on update, so we need a fresh reference)
    const { registeredDefinitions } = useShapeLibraryStore.getState();

    // Register a tool for each library shape
    for (const definition of registeredDefinitions) {
      this.toolManager.register(new LibraryShapeTool(definition));
    }
  }

  /**
   * Subscribe to document and session store changes.
   */
  private subscribeToStores(): void {
    // Subscribe to document store
    this.unsubscribeDocument = useDocumentStore.subscribe((state) => {
      // Update connector endpoints when shapes move
      this.updateConnectors(state.shapes);

      // Update renderer with new shape data
      this.renderer.setShapes(state.shapes, state.shapeOrder);

      // Incremental spatial index update
      this.updateSpatialIndexIncremental(this.previousShapes, this.previousShapeOrder, state.shapes, state.shapeOrder);
      this.previousShapes = state.shapes;
      this.previousShapeOrder = state.shapeOrder;

      // Request render
      this.renderer.requestRender();
    });

    // Subscribe to session store
    let previousTool = useSessionStore.getState().activeTool;
    let previousCamera = useSessionStore.getState().camera;
    this.unsubscribeSession = useSessionStore.subscribe((state) => {
      // Sync tool changes from sessionStore to toolManager
      if (state.activeTool !== previousTool) {
        previousTool = state.activeTool;
        // Only update if different from current tool manager state
        if (this.toolManager.getActiveToolType() !== state.activeTool) {
          // Handle dynamic custom shape tools
          this.ensureCustomShapeToolRegistered(state.activeTool);
          this.toolManager.setActiveTool(state.activeTool);
        }
      }

      // Sync camera changes from sessionStore to Engine camera
      if (
        state.camera.x !== previousCamera.x ||
        state.camera.y !== previousCamera.y ||
        state.camera.zoom !== previousCamera.zoom
      ) {
        previousCamera = state.camera;
        this.camera.setState({
          x: state.camera.x,
          y: state.camera.y,
          zoom: state.camera.zoom,
        });
      }

      // Update renderer with selection
      this.renderer.setSelection(state.selectedIds);

      // Update canvas cursor
      this.canvas.style.cursor = state.cursor;

      // Update tool overlay callback
      this.renderer.setToolOverlayCallback(
        this.toolManager.getToolOverlayCallback()
      );

      // Request render
      this.renderer.requestRender();
    });
  }

  /**
   * Sync renderer state from stores (initial sync).
   */
  private syncFromStores(): void {
    const documentState = useDocumentStore.getState();
    const sessionState = useSessionStore.getState();

    this.renderer.setShapes(documentState.shapes, documentState.shapeOrder);
    this.renderer.setSelection(sessionState.selectedIds);
    this.spatialIndex.rebuild(Object.values(documentState.shapes));
    this.renderer.setToolOverlayCallback(
      this.toolManager.getToolOverlayCallback()
    );

    // Update previous state tracking to match current state
    // This ensures incremental updates work correctly after async document loading
    this.previousShapes = documentState.shapes;
    this.previousShapeOrder = documentState.shapeOrder;
  }

  /**
   * Incrementally update the spatial index based on what changed.
   * Falls back to full rebuild for bulk changes (>50% shapes changed).
   */
  private updateSpatialIndexIncremental(
    prevShapes: Record<string, Shape>,
    prevOrder: string[],
    nextShapes: Record<string, Shape>,
    nextOrder: string[],
  ): void {
    // First sync or order length changed significantly → full rebuild
    if (prevOrder.length === 0 || Math.abs(nextOrder.length - prevOrder.length) > nextOrder.length * 0.5) {
      this.spatialIndex.rebuild(Object.values(nextShapes));
      return;
    }

    // Collect changes
    const added: Shape[] = [];
    const updated: Shape[] = [];
    const removedIds: string[] = [];

    // Find removed and updated shapes
    for (const id of prevOrder) {
      const nextShape = nextShapes[id];
      if (!nextShape) {
        removedIds.push(id);
      } else if (nextShape !== prevShapes[id]) {
        updated.push(nextShape);
      }
    }

    // Find added shapes
    for (const id of nextOrder) {
      if (!(id in prevShapes)) {
        const shape = nextShapes[id];
        if (shape) added.push(shape);
      }
    }

    const totalChanges = added.length + updated.length + removedIds.length;

    // If more than half the shapes changed, full rebuild is faster
    if (totalChanges > nextOrder.length * 0.5) {
      this.spatialIndex.rebuild(Object.values(nextShapes));
      return;
    }

    // Apply incremental changes
    if (removedIds.length > 0) this.spatialIndex.removeMany(removedIds);
    for (const shape of updated) this.spatialIndex.update(shape);
    for (const shape of added) this.spatialIndex.insert(shape);
  }

  /**
   * Update connector endpoints based on connected shapes.
   * Called when shapes change to keep connectors attached.
   * Also recalculates orthogonal routing waypoints.
   */
  private updateConnectors(shapes: Record<string, Shape>): void {
    const updates: Array<{ id: string; updates: Partial<ConnectorShape> }> = [];

    for (const shape of Object.values(shapes)) {
      if (isConnector(shape)) {
        const connectorUpdates: Partial<ConnectorShape> = {};
        let hasChanges = false;

        // Check if this connector has any connected shapes
        if (shape.startShapeId || shape.endShapeId) {
          const endpointUpdates = updateConnectorEndpoints(shape, shapes);

          // Only include updates where positions actually changed
          const hasEndpointChanges =
            (endpointUpdates.x !== undefined && Math.abs(endpointUpdates.x - shape.x) > 0.001) ||
            (endpointUpdates.y !== undefined && Math.abs(endpointUpdates.y - shape.y) > 0.001) ||
            (endpointUpdates.x2 !== undefined && Math.abs(endpointUpdates.x2 - shape.x2) > 0.001) ||
            (endpointUpdates.y2 !== undefined && Math.abs(endpointUpdates.y2 - shape.y2) > 0.001);

          if (hasEndpointChanges) {
            Object.assign(connectorUpdates, endpointUpdates);
            hasChanges = true;
          }
        }

        // Recalculate orthogonal routing waypoints if in orthogonal mode
        if (shape.routingMode === 'orthogonal') {
          // Use updated positions if available, otherwise use current
          const currentConnector: ConnectorShape = {
            ...shape,
            x: connectorUpdates.x ?? shape.x,
            y: connectorUpdates.y ?? shape.y,
            x2: connectorUpdates.x2 ?? shape.x2,
            y2: connectorUpdates.y2 ?? shape.y2,
          };

          const newWaypoints = calculateConnectorWaypoints(currentConnector, shapes) ?? [];

          // Check if waypoints changed
          const waypointsChanged = !areWaypointsEqual(shape.waypoints, newWaypoints);

          if (waypointsChanged) {
            connectorUpdates.waypoints = newWaypoints;
            hasChanges = true;
          }
        }

        if (hasChanges) {
          updates.push({ id: shape.id, updates: connectorUpdates });
        }
      }
    }

    // Apply updates if any
    if (updates.length > 0) {
      const updateShape = useDocumentStore.getState().updateShape;
      for (const { id, updates: shapeUpdates } of updates) {
        updateShape(id, shapeUpdates);
      }
    }
  }

  // Event handlers

  /**
   * Global keyboard handler to intercept browser defaults like Ctrl+A, Ctrl+G.
   * This runs on window, not canvas, so it works even when canvas isn't focused.
   */
  private handleGlobalKeyDown(event: KeyboardEvent): void {
    if (this.destroyed) return;

    // Don't intercept shortcuts when focus is on an input/textarea/contenteditable
    const activeEl = document.activeElement;
    if (activeEl) {
      const tagName = activeEl.tagName.toLowerCase();
      if (
        tagName === 'input' ||
        tagName === 'textarea' ||
        (activeEl as HTMLElement).isContentEditable
      ) {
        return;
      }
    }

    const isCtrl = event.ctrlKey || event.metaKey;
    const isShift = event.shiftKey;

    // Ctrl+A: Select all - must intercept at window level to prevent browser select all
    if (isCtrl && event.key === 'a') {
      event.preventDefault();
      useSessionStore.getState().selectAll();
      this.renderer.requestRender();
      return;
    }

    // Ctrl+G: Group selected shapes - intercept to prevent browser "Find" dialog
    if (isCtrl && !isShift && event.key === 'g') {
      event.preventDefault();
      const selectedIds = useSessionStore.getState().getSelectedIds();
      if (selectedIds.length >= 2) {
        pushHistory('Group shapes');
        const groupId = nanoid();
        useDocumentStore.getState().groupShapes(selectedIds, groupId);
        useSessionStore.getState().select([groupId]);
        this.renderer.requestRender();
      }
      return;
    }

    // Ctrl+Shift+G: Ungroup selected group
    if (isCtrl && isShift && (event.key === 'G' || event.key === 'g')) {
      event.preventDefault();
      const selectedIds = useSessionStore.getState().getSelectedIds();
      if (selectedIds.length === 1) {
        const shape = useDocumentStore.getState().shapes[selectedIds[0]!];
        if (shape && isGroup(shape)) {
          pushHistory('Ungroup shapes');
          const childIds = [...shape.childIds];
          useDocumentStore.getState().ungroupShape(shape.id);
          useSessionStore.getState().select(childIds);
          this.renderer.requestRender();
        }
      }
      return;
    }

    // Ctrl+I: Toggle whiteboard (Ideas)
    if (isCtrl && event.key.toLowerCase() === 'i') {
      event.preventDefault();
      useWhiteboardStore.getState().toggleVisibility();
      return;
    }
  }

  private handlePointerEvent(event: NormalizedPointerEvent): void {
    // Update cursor world position for status bar display
    useSessionStore.getState().setCursorWorldPosition({
      x: event.worldPoint.x,
      y: event.worldPoint.y,
    });

    this.toolManager.handlePointerEvent(event);
  }

  /**
   * Handle keyboard events (both keydown and keyup).
   */
  private handleKeyEvent(event: KeyboardEvent): void {
    if (event.type === 'keydown') {
      this.handleKeyDown(event);
    } else if (event.type === 'keyup') {
      this.handleKeyUp(event);
    }
  }

  private handleKeyDown(event: KeyboardEvent): void {
    // Handle keyboard panning
    if (this.handleKeyboardPanDown(event)) {
      return;
    }

    // Let tool manager handle first
    const handled = this.toolManager.handleKeyDown(event);

    if (!handled) {
      // Handle global shortcuts
      this.handleGlobalShortcuts(event);
    }
  }

  private handleKeyUp(event: KeyboardEvent): void {
    // Handle keyboard panning
    this.handleKeyboardPanUp(event);

    // Let tool manager handle
    this.toolManager.handleKeyUp(event);
  }

  /**
   * Handle keydown for keyboard navigation (pan, zoom, and shape nudging).
   * Returns true if the event was handled.
   */
  private handleKeyboardPanDown(event: KeyboardEvent): boolean {
    // Don't handle if modifiers are pressed (allow shortcuts)
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return false;
    }

    // Check key types
    const isPanKey = PAN_KEYS.has(event.key);
    const isArrowKey = ARROW_KEYS.has(event.key);
    const isZoomKey = ZOOM_KEYS.has(event.key);

    if (!isPanKey && !isArrowKey && !isZoomKey) {
      return false;
    }

    // Don't handle if we're editing text on canvas
    if (useSessionStore.getState().isEditingText()) {
      return false;
    }

    // Don't handle if focus is on an input/textarea/contenteditable element
    const activeEl = document.activeElement;
    if (activeEl) {
      const tagName = activeEl.tagName.toLowerCase();
      if (
        tagName === 'input' ||
        tagName === 'textarea' ||
        (activeEl as HTMLElement).isContentEditable
      ) {
        return false;
      }
    }

    // Prevent page scrolling
    event.preventDefault();

    // Arrow keys: nudge selected shapes if there's a selection, otherwise pan
    if (isArrowKey) {
      const selectedIds = useSessionStore.getState().getSelectedIds();
      if (selectedIds.length > 0) {
        this.nudgeSelectedShapes(event.key, event.shiftKey);
        return true;
      }
      // Fall through to pan if no selection
    }

    // Add key to active set for panning
    this.activePanKeys.add(event.key);

    // Start pan animation if not already running
    if (this.panAnimationId === null) {
      this.startPanAnimation();
    }

    return true;
  }

  /**
   * Nudge selected shapes in the direction of the arrow key.
   */
  private nudgeSelectedShapes(key: string, shiftHeld: boolean): void {
    const amount = shiftHeld ? NUDGE_AMOUNT * 10 : NUDGE_AMOUNT;
    let dx = 0;
    let dy = 0;

    switch (key) {
      case 'ArrowUp':
        dy = -amount;
        break;
      case 'ArrowDown':
        dy = amount;
        break;
      case 'ArrowLeft':
        dx = -amount;
        break;
      case 'ArrowRight':
        dx = amount;
        break;
    }

    if (dx === 0 && dy === 0) return;

    const selectedIds = useSessionStore.getState().getSelectedIds();
    const shapes = useDocumentStore.getState().shapes;
    const updateShape = useDocumentStore.getState().updateShape;

    // Push to history on first nudge
    pushHistory('Nudge shapes');

    for (const id of selectedIds) {
      const shape = shapes[id];
      if (!shape || shape.locked) continue;

      // Update shape position based on shape type
      if ('x' in shape && 'y' in shape) {
        updateShape(id, {
          x: (shape as { x: number }).x + dx,
          y: (shape as { y: number }).y + dy,
        });
      }

      // Also update line/connector endpoints
      if ('x2' in shape && 'y2' in shape) {
        updateShape(id, {
          x2: (shape as { x2: number }).x2 + dx,
          y2: (shape as { y2: number }).y2 + dy,
        });
      }

      // Update spatial index
      const updatedShape = useDocumentStore.getState().shapes[id];
      if (updatedShape) {
        this.spatialIndex.update(updatedShape);
      }
    }

    this.renderer.requestRender();
  }

  /**
   * Handle keyup for keyboard panning.
   */
  private handleKeyboardPanUp(event: KeyboardEvent): void {
    // Remove key from active set
    this.activePanKeys.delete(event.key);

    // Stop animation if no keys are pressed
    if (this.activePanKeys.size === 0 && this.panAnimationId !== null) {
      cancelAnimationFrame(this.panAnimationId);
      this.panAnimationId = null;
    }
  }

  /**
   * Start the keyboard navigation animation loop.
   */
  private startPanAnimation(): void {
    const animate = () => {
      if (this.destroyed || this.activePanKeys.size === 0) {
        this.panAnimationId = null;
        return;
      }

      // Calculate pan direction and zoom from active keys
      let dx = 0;
      let dy = 0;
      let zoomDir = 0;

      for (const key of this.activePanKeys) {
        switch (key) {
          // Pan keys - signs are flipped because camera.pan() subtracts the delta
          // W/Up = move view up = see content above = camera moves up (negative Y)
          case 'ArrowUp':
          case 'w':
          case 'W':
            dy += 1;
            break;
          case 'ArrowDown':
          case 's':
          case 'S':
            dy -= 1;
            break;
          case 'ArrowLeft':
          case 'a':
          case 'A':
            dx += 1;
            break;
          case 'ArrowRight':
          case 'd':
          case 'D':
            dx -= 1;
            break;
          // Zoom keys
          case 'q':
          case 'Q':
            zoomDir -= 1; // Zoom out
            break;
          case 'e':
          case 'E':
            zoomDir += 1; // Zoom in
            break;
        }
      }

      let needsRender = false;

      // Apply pan (adjust for zoom to maintain consistent screen speed)
      if (dx !== 0 || dy !== 0) {
        const panAmount = PAN_SPEED / this.camera.zoom;
        this.camera.pan(new Vec2(dx * panAmount, dy * panAmount));
        needsRender = true;
      }

      // Apply zoom centered on viewport center (use screen coordinates for zoomAt)
      if (zoomDir !== 0) {
        const zoomFactor = 1 + zoomDir * ZOOM_SPEED;
        const screenCenter = new Vec2(
          this.camera.screenWidth / 2,
          this.camera.screenHeight / 2
        );
        this.camera.zoomAt(screenCenter, zoomFactor);
        needsRender = true;
      }

      if (needsRender) {
        this.renderer.requestRender();
      }

      // Continue animation
      this.panAnimationId = requestAnimationFrame(animate);
    };

    this.panAnimationId = requestAnimationFrame(animate);
  }

  /**
   * Handle global keyboard shortcuts.
   */
  private handleGlobalShortcuts(event: KeyboardEvent): void {
    const isCtrl = event.ctrlKey || event.metaKey;
    const isShift = event.shiftKey;

    // Ctrl+Z / Cmd+Z: Undo
    if (isCtrl && !isShift && event.key === 'z') {
      event.preventDefault();
      if (useHistoryStore.getState().canUndo()) {
        useHistoryStore.getState().undo();
        this.renderer.requestRender();
      }
      return;
    }

    // Ctrl+Shift+Z / Cmd+Shift+Z or Ctrl+Y / Cmd+Y: Redo
    if ((isCtrl && isShift && event.key === 'z') || (isCtrl && event.key === 'y')) {
      event.preventDefault();
      if (useHistoryStore.getState().canRedo()) {
        useHistoryStore.getState().redo();
        this.renderer.requestRender();
      }
      return;
    }

    // Ctrl+A / Cmd+A: Select All
    if (isCtrl && event.key === 'a') {
      event.preventDefault();
      useSessionStore.getState().selectAll();
      this.renderer.requestRender();
      return;
    }

    // Delete / Backspace: Delete selected shapes
    if (event.key === 'Delete' || event.key === 'Backspace') {
      const selectedIds = useSessionStore.getState().getSelectedIds();
      if (selectedIds.length > 0) {
        event.preventDefault();
        pushHistory('Delete shapes');
        deleteSelected();
        this.renderer.requestRender();
      }
      return;
    }

    // Escape: Clear selection
    if (event.key === 'Escape') {
      if (useSessionStore.getState().hasSelection()) {
        event.preventDefault();
        useSessionStore.getState().clearSelection();
        this.renderer.requestRender();
      }
      return;
    }

    // Ctrl+C / Cmd+C: Copy selected shapes
    if (isCtrl && event.key === 'c') {
      const selectedIds = useSessionStore.getState().getSelectedIds();
      if (selectedIds.length > 0) {
        event.preventDefault();
        const shapes = useDocumentStore.getState().shapes;
        clipboard = selectedIds.map((id) => ({ ...shapes[id]! }));
      }
      return;
    }

    // Ctrl+V / Cmd+V: Paste shapes
    if (isCtrl && event.key === 'v') {
      if (clipboard.length > 0) {
        event.preventDefault();
        pushHistory('Paste shapes');

        const newIds: string[] = [];
        const offset = 20; // Offset pasted shapes slightly

        for (const shape of clipboard) {
          const newId = nanoid();
          const newShape: Shape = {
            ...shape,
            id: newId,
            x: shape.x + offset,
            y: shape.y + offset,
          };
          useDocumentStore.getState().addShape(newShape);
          this.spatialIndex.insert(newShape);
          newIds.push(newId);
        }

        // Select pasted shapes
        useSessionStore.getState().select(newIds);

        // Update clipboard with new positions for subsequent pastes
        clipboard = clipboard.map((s) => ({ ...s, x: s.x + offset, y: s.y + offset }));

        this.renderer.requestRender();
      }
      return;
    }

    // Note: Ctrl+G and Ctrl+Shift+G are handled in handleGlobalKeyDown
    // to intercept browser defaults
  }

  private handleWheel(event: WheelEvent, screenPoint: Vec2): void {
    // Let tool manager handle first
    const worldPoint = this.camera.screenToWorld(screenPoint);
    const handled = this.toolManager.handleWheel(event, worldPoint);

    if (!handled) {
      // Default wheel behavior: zoom with linear acceleration
      // Use smaller base factor for smoother zooming
      const baseZoomStep = 0.02; // 2% per unit of delta
      const maxZoomStep = 0.15; // Cap maximum zoom change per event

      // Normalize deltaY (different browsers/devices have different scales)
      // Typical values: ~100 for mouse wheel, ~1-4 for trackpad
      const normalizedDelta = Math.abs(event.deltaY) / 100;

      // Linear acceleration: larger scroll = larger zoom change
      const zoomStep = Math.min(baseZoomStep * normalizedDelta, maxZoomStep);

      // Calculate zoom factor (zoom in for negative delta, out for positive)
      const zoomFactor = event.deltaY > 0 ? 1 - zoomStep : 1 + zoomStep;

      // Use screenPoint for zoomAt (it internally converts to world coordinates)
      this.camera.zoomAt(screenPoint, zoomFactor);
      this.renderer.requestRender();
    }
  }
}

/**
 * Create and initialize an engine instance.
 * Convenience factory function.
 */
export function createEngine(
  canvas: HTMLCanvasElement,
  options?: EngineOptions
): Engine {
  return new Engine(canvas, options);
}
