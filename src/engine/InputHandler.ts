import { Vec2 } from '../math/Vec2';
import { Camera } from './Camera';

/**
 * Modifier keys state during an input event.
 */
export interface Modifiers {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
}

/**
 * Mouse/pointer button type.
 */
export type PointerButton = 'left' | 'middle' | 'right' | 'none';

/**
 * Normalized pointer event type.
 */
export type PointerEventType = 'down' | 'move' | 'up';

/**
 * Normalized pointer event that unifies mouse, touch, and pen input.
 * All coordinates are provided in both screen and world space.
 */
export interface NormalizedPointerEvent {
  /** Event type */
  type: PointerEventType;
  /** Point in screen space (canvas pixels from top-left) */
  screenPoint: Vec2;
  /** Point in world space (converted via camera) */
  worldPoint: Vec2;
  /** Which button triggered the event */
  button: PointerButton;
  /** Modifier keys state */
  modifiers: Modifiers;
  /** Pen pressure (0-1), defaults to 0.5 for mouse */
  pressure: number;
  /** Pointer ID for multi-touch support */
  pointerId: number;
  /** Whether this is the primary pointer */
  isPrimary: boolean;
  /** Event timestamp in milliseconds */
  timestamp: number;
  /** The original DOM event */
  originalEvent: PointerEvent;
}

/**
 * Callback type for pointer events.
 */
export type PointerEventCallback = (event: NormalizedPointerEvent) => void;

/**
 * Callback type for keyboard events.
 */
export type KeyEventCallback = (event: KeyboardEvent) => void;

/**
 * Callback type for wheel events.
 * Provides both screen point (for zoom-at operations) and world point (for other uses).
 */
export type WheelEventCallback = (event: WheelEvent, screenPoint: Vec2, worldPoint: Vec2) => void;

/**
 * Firefox wheel delta mode constants.
 * Firefox reports wheel delta in lines (DOM_DELTA_LINE) or pages (DOM_DELTA_PAGE)
 * instead of pixels (DOM_DELTA_PIXEL).
 */
const DOM_DELTA_PIXEL = 0;
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

/** Approximate pixels per line for Firefox line-based wheel events */
const PIXELS_PER_LINE = 20;

/** Approximate pixels per page for Firefox page-based wheel events */
const PIXELS_PER_PAGE = 800;

/**
 * InputHandler normalizes all input events (pointer, keyboard, wheel) into
 * a consistent format for the engine to consume.
 *
 * Features:
 * - Unifies mouse, touch, and pen events via PointerEvent API
 * - Converts screen coordinates to world coordinates via Camera
 * - Captures pointer on down, releases on up
 * - Normalizes wheel delta across browsers (Firefox uses different units)
 * - Prevents default on wheel to stop page scroll
 * - Handles right-click context menu
 *
 * Usage:
 * ```typescript
 * const handler = new InputHandler(
 *   canvas,
 *   camera,
 *   (event) => toolManager.handlePointerEvent(event),
 *   (event) => toolManager.handleKeyEvent(event),
 *   (event, worldPoint) => camera.zoomAt(worldPoint, ...)
 * );
 *
 * // On component unmount
 * handler.destroy();
 * ```
 */
export class InputHandler {
  private canvas: HTMLCanvasElement;
  private camera: Camera;
  private onPointerEvent: PointerEventCallback;
  private onKeyEvent: KeyEventCallback;
  private onWheelEvent: WheelEventCallback;

  // Bound event handlers (for removal on destroy)
  private boundPointerDown: (e: PointerEvent) => void;
  private boundPointerMove: (e: PointerEvent) => void;
  private boundPointerUp: (e: PointerEvent) => void;
  private boundPointerCancel: (e: PointerEvent) => void;
  private boundWheel: (e: WheelEvent) => void;
  private boundKeyDown: (e: KeyboardEvent) => void;
  private boundKeyUp: (e: KeyboardEvent) => void;
  private boundContextMenu: (e: MouseEvent) => void;

  // Track captured pointers
  private capturedPointers: Set<number> = new Set();

  // Track active pointer positions for gesture detection
  private activePointers: Map<number, Vec2> = new Map();

  // Pinch-zoom gesture state
  private pinchStartDistance: number = 0;
  private pinchStartZoom: number = 1;
  private isPinching: boolean = false;
  // JP-307 Slice 4: previous two-finger midpoint, for two-finger pan (the
  // frame-to-frame midpoint translation pans while pinch zooms).
  private pinchLastMidpoint: Vec2 | null = null;

  // Track if destroyed
  private destroyed = false;

  constructor(
    canvas: HTMLCanvasElement,
    camera: Camera,
    onPointerEvent: PointerEventCallback,
    onKeyEvent: KeyEventCallback,
    onWheelEvent: WheelEventCallback
  ) {
    this.canvas = canvas;
    this.camera = camera;
    this.onPointerEvent = onPointerEvent;
    this.onKeyEvent = onKeyEvent;
    this.onWheelEvent = onWheelEvent;

    // Bind event handlers
    this.boundPointerDown = this.handlePointerDown.bind(this);
    this.boundPointerMove = this.handlePointerMove.bind(this);
    this.boundPointerUp = this.handlePointerUp.bind(this);
    this.boundPointerCancel = this.handlePointerCancel.bind(this);
    this.boundWheel = this.handleWheel.bind(this);
    this.boundKeyDown = this.handleKeyDown.bind(this);
    this.boundKeyUp = this.handleKeyUp.bind(this);
    this.boundContextMenu = this.handleContextMenu.bind(this);

    // Attach event listeners
    this.attachListeners();
  }

  /**
   * Clean up all event listeners.
   * Call this when the component unmounts.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    // Release any captured pointers
    for (const pointerId of this.capturedPointers) {
      try {
        this.canvas.releasePointerCapture(pointerId);
      } catch {
        // Pointer may already be released
      }
    }
    this.capturedPointers.clear();

    // Remove event listeners
    this.detachListeners();
  }

  /**
   * Update the camera reference.
   * Useful if the camera instance changes.
   */
  setCamera(camera: Camera): void {
    this.camera = camera;
  }

  /**
   * Attach all event listeners.
   */
  private attachListeners(): void {
    // Pointer events on canvas
    this.canvas.addEventListener('pointerdown', this.boundPointerDown);
    this.canvas.addEventListener('pointermove', this.boundPointerMove);
    this.canvas.addEventListener('pointerup', this.boundPointerUp);
    this.canvas.addEventListener('pointercancel', this.boundPointerCancel);

    // Wheel events on canvas
    this.canvas.addEventListener('wheel', this.boundWheel, { passive: false });

    // Context menu on canvas
    this.canvas.addEventListener('contextmenu', this.boundContextMenu);

    // Keyboard events on canvas (requires tabIndex for focus)
    this.canvas.addEventListener('keydown', this.boundKeyDown);
    this.canvas.addEventListener('keyup', this.boundKeyUp);
  }

  /**
   * Detach all event listeners.
   */
  private detachListeners(): void {
    this.canvas.removeEventListener('pointerdown', this.boundPointerDown);
    this.canvas.removeEventListener('pointermove', this.boundPointerMove);
    this.canvas.removeEventListener('pointerup', this.boundPointerUp);
    this.canvas.removeEventListener('pointercancel', this.boundPointerCancel);
    this.canvas.removeEventListener('wheel', this.boundWheel);
    this.canvas.removeEventListener('contextmenu', this.boundContextMenu);
    this.canvas.removeEventListener('keydown', this.boundKeyDown);
    this.canvas.removeEventListener('keyup', this.boundKeyUp);
  }

  /**
   * Handle pointer down event.
   */
  private handlePointerDown(e: PointerEvent): void {
    if (this.destroyed) return;

    // Capture pointer for drag tracking
    try {
      this.canvas.setPointerCapture(e.pointerId);
      this.capturedPointers.add(e.pointerId);
    } catch {
      // Some browsers may not support pointer capture
    }

    // Track position for gesture detection
    const screenPoint = this.getScreenPoint(e);
    this.activePointers.set(e.pointerId, screenPoint);

    // Detect pinch-zoom start (2 fingers)
    if (this.activePointers.size === 2) {
      this.startPinchGesture();
      return;
    }

    // Focus canvas for keyboard events
    this.canvas.focus();

    const normalized = this.normalizePointerEvent(e, 'down');
    this.onPointerEvent(normalized);
  }

  /**
   * Handle pointer move event.
   */
  private handlePointerMove(e: PointerEvent): void {
    if (this.destroyed) return;

    // Update tracked position
    const screenPoint = this.getScreenPoint(e);
    this.activePointers.set(e.pointerId, screenPoint);

    // Handle pinch-zoom gesture
    if (this.isPinching && this.activePointers.size >= 2) {
      this.updatePinchGesture();
      return;
    }

    // Skip normal event forwarding during multi-touch
    if (this.activePointers.size > 1) return;

    const normalized = this.normalizePointerEvent(e, 'move');
    this.onPointerEvent(normalized);
  }

  /**
   * Handle pointer up event.
   */
  private handlePointerUp(e: PointerEvent): void {
    if (this.destroyed) return;

    // Release pointer capture
    this.releasePointer(e.pointerId);
    this.activePointers.delete(e.pointerId);

    // End pinch gesture
    if (this.isPinching) {
      if (this.activePointers.size < 2) {
        this.isPinching = false;
        this.pinchLastMidpoint = null;
      }
      return;
    }

    const normalized = this.normalizePointerEvent(e, 'up');
    this.onPointerEvent(normalized);
  }

  /**
   * Handle pointer cancel event (e.g., touch interrupted by system).
   */
  private handlePointerCancel(e: PointerEvent): void {
    if (this.destroyed) return;

    // Release pointer capture
    this.releasePointer(e.pointerId);
    this.activePointers.delete(e.pointerId);

    // End pinch gesture
    if (this.isPinching && this.activePointers.size < 2) {
      this.isPinching = false;
      this.pinchLastMidpoint = null;
      return;
    }

    // Treat cancel as up
    const normalized = this.normalizePointerEvent(e, 'up');
    this.onPointerEvent(normalized);
  }

  /**
   * Release a captured pointer.
   */
  private releasePointer(pointerId: number): void {
    if (this.capturedPointers.has(pointerId)) {
      try {
        this.canvas.releasePointerCapture(pointerId);
      } catch {
        // Pointer may already be released
      }
      this.capturedPointers.delete(pointerId);
    }
  }

  /**
   * Handle wheel event for zoom.
   */
  private handleWheel(e: WheelEvent): void {
    if (this.destroyed) return;

    // Prevent page scroll
    e.preventDefault();

    const screenPoint = this.getScreenPoint(e);
    const worldPoint = this.camera.screenToWorld(screenPoint);

    // Normalize the wheel event for cross-browser consistency
    const normalizedEvent = this.normalizeWheelEvent(e);

    this.onWheelEvent(normalizedEvent, screenPoint, worldPoint);
  }

  /**
   * Normalize wheel event delta across browsers.
   * Firefox reports delta in lines or pages, not pixels.
   *
   * Returns a proxy object that wraps the original event with normalized delta values.
   * The original event is accessible and all methods/properties are preserved.
   */
  private normalizeWheelEvent(e: WheelEvent): WheelEvent {
    // If already in pixels, return as-is
    if (e.deltaMode === DOM_DELTA_PIXEL) {
      return e;
    }

    // Calculate pixel delta
    let normalizedDeltaX = e.deltaX;
    let normalizedDeltaY = e.deltaY;

    if (e.deltaMode === DOM_DELTA_LINE) {
      normalizedDeltaX *= PIXELS_PER_LINE;
      normalizedDeltaY *= PIXELS_PER_LINE;
    } else if (e.deltaMode === DOM_DELTA_PAGE) {
      normalizedDeltaX *= PIXELS_PER_PAGE;
      normalizedDeltaY *= PIXELS_PER_PAGE;
    }

    // Use a Proxy to intercept property access while preserving the original event
    // This ensures all original event properties and methods work correctly
    return new Proxy(e, {
      get(target, prop) {
        if (prop === 'deltaX') return normalizedDeltaX;
        if (prop === 'deltaY') return normalizedDeltaY;
        if (prop === 'deltaMode') return DOM_DELTA_PIXEL;

        const value = Reflect.get(target, prop);
        // Bind methods to the original event
        if (typeof value === 'function') {
          return value.bind(target);
        }
        return value;
      },
    });
  }

  /**
   * Handle key down event.
   */
  private handleKeyDown(e: KeyboardEvent): void {
    if (this.destroyed) return;
    this.onKeyEvent(e);

    // Keep keyboard focus on the canvas. The handler chain above calls
    // preventDefault() on keys it consumes, so an un-prevented bare key here is
    // "unbound" — and its browser default (Tab/Space/"/" etc.) would move focus
    // to the next focusable element. In split layouts that's the prose editor,
    // so the keystroke leaks into the document (JP focus-isolation). Swallow
    // un-consumed bare keys so focus stays on the canvas. Real browser/OS combos
    // (Ctrl/Meta/Alt) are left alone. Escape with nothing left to consume is the
    // deliberate, accessible way out: blur the canvas so keyboard-only users are
    // not trapped (this is last in the Escape precedence — selection-clear and
    // tool-cancel run inside onKeyEvent and preventDefault first).
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.activeElement !== this.canvas) return;
    if (e.key === 'Escape') {
      this.canvas.blur();
      return;
    }
    e.preventDefault();
  }

  /**
   * Handle key up event.
   */
  private handleKeyUp(e: KeyboardEvent): void {
    if (this.destroyed) return;
    this.onKeyEvent(e);
  }

  /**
   * Start a pinch-zoom gesture when two fingers are detected.
   */
  private startPinchGesture(): void {
    const points = Array.from(this.activePointers.values());
    if (points.length < 2) return;
    const [p1, p2] = points;
    if (!p1 || !p2) return;

    this.pinchStartDistance = p1.distanceTo(p2);
    this.pinchStartZoom = this.camera.zoom;
    this.pinchLastMidpoint = new Vec2((p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
    this.isPinching = true;
  }

  /**
   * Update pinch-zoom gesture with current finger positions.
   */
  private updatePinchGesture(): void {
    const points = Array.from(this.activePointers.values());
    if (points.length < 2) return;
    const [p1, p2] = points;
    if (!p1 || !p2) return;

    const currentDistance = p1.distanceTo(p2);
    if (this.pinchStartDistance === 0) return;

    // Calculate midpoint (zoom anchor + two-finger pan reference)
    const midpoint = new Vec2(
      (p1.x + p2.x) / 2,
      (p1.y + p2.y) / 2,
    );

    // Two-finger drag -> pan by the midpoint's frame-to-frame translation
    // (Slice 4), simultaneously with the pinch zoom below. Content follows the
    // fingers; camera.pan() moves the camera opposite a positive screen delta.
    if (this.pinchLastMidpoint) {
      const panDelta = new Vec2(
        midpoint.x - this.pinchLastMidpoint.x,
        midpoint.y - this.pinchLastMidpoint.y,
      );
      if (panDelta.x !== 0 || panDelta.y !== 0) {
        this.camera.pan(panDelta);
      }
    }
    this.pinchLastMidpoint = midpoint;

    // Apply zoom centered on midpoint between fingers
    const scale = currentDistance / this.pinchStartDistance;
    const targetZoom = this.pinchStartZoom * scale;
    const factor = targetZoom / this.camera.zoom;
    this.camera.zoomAt(midpoint, factor);
    // Notify via wheel callback so Engine can request render. handleWheel treats
    // a zero-delta wheel as a redraw request (see Engine.handleWheel).
    this.onWheelEvent(
      new WheelEvent('wheel', { deltaY: 0 }),
      midpoint,
      this.camera.screenToWorld(midpoint),
    );
  }

  /**
   * Handle context menu (right-click).
   * Prevent default to allow custom right-click behavior.
   */
  private handleContextMenu(e: MouseEvent): void {
    if (this.destroyed) return;
    e.preventDefault();
  }

  /**
   * Normalize a pointer event into our standard format.
   */
  private normalizePointerEvent(
    e: PointerEvent,
    type: PointerEventType
  ): NormalizedPointerEvent {
    const screenPoint = this.getScreenPoint(e);
    const worldPoint = this.camera.screenToWorld(screenPoint);

    return {
      type,
      screenPoint,
      worldPoint,
      button: this.getButton(e),
      modifiers: this.getModifiers(e),
      pressure: this.getPressure(e),
      pointerId: e.pointerId,
      isPrimary: e.isPrimary,
      timestamp: e.timeStamp,
      originalEvent: e,
    };
  }

  /**
   * Get screen point from mouse/pointer event.
   * Uses canvas bounding rect to get coordinates relative to canvas.
   */
  private getScreenPoint(e: MouseEvent | PointerEvent | WheelEvent): Vec2 {
    const rect = this.canvas.getBoundingClientRect();
    return new Vec2(e.clientX - rect.left, e.clientY - rect.top);
  }

  /**
   * Get button type from pointer event.
   */
  private getButton(e: PointerEvent): PointerButton {
    // For move events, check buttons bitmask
    if (e.type === 'pointermove') {
      if (e.buttons & 1) return 'left';
      if (e.buttons & 4) return 'middle';
      if (e.buttons & 2) return 'right';
      return 'none';
    }

    // For down/up events, check button property
    switch (e.button) {
      case 0:
        return 'left';
      case 1:
        return 'middle';
      case 2:
        return 'right';
      default:
        return 'none';
    }
  }

  /**
   * Get modifier keys state from event.
   */
  private getModifiers(e: PointerEvent | KeyboardEvent): Modifiers {
    return {
      shift: e.shiftKey,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      meta: e.metaKey,
    };
  }

  /**
   * Get pressure from pointer event.
   * Returns 0.5 for mouse events (no pressure data).
   */
  private getPressure(e: PointerEvent): number {
    // Pressure is 0-1 for pen/touch, but 0 for mouse
    // Use 0.5 as default for mouse to indicate "pressed"
    if (e.pressure === 0 && e.pointerType === 'mouse') {
      return e.buttons > 0 ? 0.5 : 0;
    }
    return e.pressure;
  }
}
