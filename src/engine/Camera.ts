import { Vec2 } from '../math/Vec2';
import { Mat3 } from '../math/Mat3';
import { Box } from '../math/Box';
import { clamp, lerp, easeInOutCubic } from '../math/geometry';

/**
 * Camera state representing the viewport in world space.
 * - x, y: world coordinates at the center of the screen
 * - zoom: scale factor (1 = 100%, 0.5 = zoomed out, 2 = zoomed in)
 */
export interface CameraState {
  x: number;
  y: number;
  zoom: number;
}

/** Minimum allowed zoom level */
export const MIN_ZOOM = 0.1;

/** Maximum allowed zoom level */
export const MAX_ZOOM = 10;

/**
 * Camera handles all coordinate transformations between screen and world space.
 *
 * The camera's (x, y) represents the world point at the center of the screen.
 * Zoom > 1 means zoomed in (world appears larger), zoom < 1 means zoomed out.
 *
 * Transform flow:
 * - Screen → World: screenToWorld() for hit testing, input handling
 * - World → Screen: worldToScreen() for positioning UI elements
 *
 * The camera provides a transform matrix for the renderer to apply
 * when drawing shapes in world coordinates.
 */
export class Camera {
  private _x: number;
  private _y: number;
  private _zoom: number;
  private _targetZoom: number;
  private _screenWidth: number;
  private _screenHeight: number;

  // Animation state for animateTo()
  private _animation: {
    startX: number;
    startY: number;
    startZoom: number;
    targetX: number;
    targetY: number;
    targetZoom: number;
    startTime: number;
    duration: number;
  } | null = null;

  constructor(state?: Partial<CameraState>) {
    this._x = state?.x ?? 0;
    this._y = state?.y ?? 0;
    this._zoom = this.clampZoom(state?.zoom ?? 1);
    this._targetZoom = this._zoom;
    this._screenWidth = 0;
    this._screenHeight = 0;
  }

  /** Current world X coordinate at screen center */
  get x(): number {
    return this._x;
  }

  /** Current world Y coordinate at screen center */
  get y(): number {
    return this._y;
  }

  /** Current zoom level (clamped to [MIN_ZOOM, MAX_ZOOM]) */
  get zoom(): number {
    return this._zoom;
  }

  /** Target zoom level for smooth interpolation */
  get targetZoom(): number {
    return this._targetZoom;
  }

  /** Screen/viewport width in pixels */
  get screenWidth(): number {
    return this._screenWidth;
  }

  /** Screen/viewport height in pixels */
  get screenHeight(): number {
    return this._screenHeight;
  }

  /** Get the complete camera state */
  get state(): CameraState {
    return { x: this._x, y: this._y, zoom: this._zoom };
  }

  /**
   * Set the camera state directly.
   * Useful for restoring camera position from saved state.
   */
  setState(state: Partial<CameraState>): void {
    if (state.x !== undefined) this._x = state.x;
    if (state.y !== undefined) this._y = state.y;
    if (state.zoom !== undefined) {
      this._zoom = this.clampZoom(state.zoom);
      this._targetZoom = this._zoom;
    }
  }

  /**
   * Set the viewport dimensions.
   * Should be called when canvas resizes.
   *
   * @param width - Screen width in pixels
   * @param height - Screen height in pixels
   */
  setViewport(width: number, height: number): void {
    this._screenWidth = width;
    this._screenHeight = height;
  }

  /**
   * Convert a screen point (canvas pixels) to world coordinates.
   *
   * @param screen - Point in screen space (pixels from canvas top-left)
   * @returns Point in world space
   */
  screenToWorld(screen: Vec2): Vec2 {
    // Screen center offset
    const centerX = this._screenWidth / 2;
    const centerY = this._screenHeight / 2;

    // Convert screen offset from center to world offset
    const worldX = this._x + (screen.x - centerX) / this._zoom;
    const worldY = this._y + (screen.y - centerY) / this._zoom;

    return new Vec2(worldX, worldY);
  }

  /**
   * Convert a world point to screen coordinates (canvas pixels).
   *
   * @param world - Point in world space
   * @returns Point in screen space (pixels from canvas top-left)
   */
  worldToScreen(world: Vec2): Vec2 {
    // Screen center offset
    const centerX = this._screenWidth / 2;
    const centerY = this._screenHeight / 2;

    // Convert world offset from camera to screen offset from center
    const screenX = centerX + (world.x - this._x) * this._zoom;
    const screenY = centerY + (world.y - this._y) * this._zoom;

    return new Vec2(screenX, screenY);
  }

  /**
   * Get the visible bounds in world coordinates.
   * Useful for viewport culling during rendering.
   *
   * @returns AABB representing the visible area in world space
   */
  /**
   * Get the world-space point at the center of the viewport.
   */
  getViewportCenter(): Vec2 {
    return this.screenToWorld(new Vec2(this._screenWidth / 2, this._screenHeight / 2));
  }

  getVisibleBounds(): Box {
    const halfWidth = this._screenWidth / 2 / this._zoom;
    const halfHeight = this._screenHeight / 2 / this._zoom;

    return new Box(
      this._x - halfWidth,
      this._y - halfHeight,
      this._x + halfWidth,
      this._y + halfHeight
    );
  }

  /**
   * Pan the camera by a screen delta.
   * Moving the mouse right while panning should move the view right,
   * which means the camera position moves left in world space.
   *
   * @param deltaScreen - Movement in screen pixels
   */
  pan(deltaScreen: Vec2): void {
    // Moving screen right = world moves left relative to camera
    this._x -= deltaScreen.x / this._zoom;
    this._y -= deltaScreen.y / this._zoom;
  }

  /**
   * Pan the camera by a world delta.
   *
   * @param deltaWorld - Movement in world units
   */
  panWorld(deltaWorld: Vec2): void {
    this._x += deltaWorld.x;
    this._y += deltaWorld.y;
  }

  /**
   * Zoom the camera centered on a screen point.
   * The world point under the screen point should remain stationary.
   *
   * @param screenPoint - The screen point to zoom toward/away from
   * @param factor - Zoom multiplier (>1 = zoom in, <1 = zoom out)
   */
  zoomAt(screenPoint: Vec2, factor: number): void {
    // Get the world point under the screen point before zoom
    const worldPoint = this.screenToWorld(screenPoint);

    // Apply zoom
    const newZoom = this.clampZoom(this._zoom * factor);
    this._zoom = newZoom;
    this._targetZoom = newZoom;

    // Calculate where the world point would now appear on screen
    const newScreenPoint = this.worldToScreen(worldPoint);

    // Adjust camera position so the world point stays under the screen point
    // pan() subtracts delta/zoom from camera position, so we need negative delta
    // to move the camera in the correct direction
    const screenDelta = new Vec2(
      screenPoint.x - newScreenPoint.x,
      screenPoint.y - newScreenPoint.y
    );
    this.pan(screenDelta);
  }

  /**
   * Set target zoom for smooth interpolation.
   * Call updateZoom() each frame to animate toward target.
   *
   * @param screenPoint - The screen point to zoom toward/away from
   * @param targetZoom - The target zoom level
   */
  setTargetZoom(_screenPoint: Vec2, targetZoom: number): void {
    this._targetZoom = this.clampZoom(targetZoom);
  }

  /**
   * Update zoom with smooth interpolation toward target.
   * Call this each frame when animating zoom.
   *
   * @param screenPoint - The screen point to zoom toward
   * @param smoothing - Interpolation factor (0-1, higher = faster)
   * @returns true if zoom is still animating
   */
  updateZoom(screenPoint: Vec2, smoothing: number = 0.15): boolean {
    const diff = Math.abs(this._targetZoom - this._zoom);
    if (diff < 0.001) {
      if (this._zoom !== this._targetZoom) {
        this.zoomAt(screenPoint, this._targetZoom / this._zoom);
      }
      return false;
    }

    const newZoom = lerp(this._zoom, this._targetZoom, smoothing);
    this.zoomAt(screenPoint, newZoom / this._zoom);
    return true;
  }

  /**
   * Zoom to fit a bounding box in the viewport.
   * Adds padding around the bounds.
   *
   * @param bounds - The world bounds to fit
   * @param padding - Padding in pixels around the bounds
   */
  zoomToFit(bounds: Box, padding: number = 50): void {
    const availableWidth = Math.max(1, this._screenWidth - padding * 2);
    const availableHeight = Math.max(1, this._screenHeight - padding * 2);

    const boundsWidth = bounds.width;
    const boundsHeight = bounds.height;

    if (boundsWidth === 0 && boundsHeight === 0) {
      // Single point - just center on it
      this._x = bounds.center.x;
      this._y = bounds.center.y;
      return;
    }

    // Calculate zoom to fit both dimensions
    const zoomX = boundsWidth > 0 ? availableWidth / boundsWidth : MAX_ZOOM;
    const zoomY = boundsHeight > 0 ? availableHeight / boundsHeight : MAX_ZOOM;
    const newZoom = this.clampZoom(Math.min(zoomX, zoomY));

    // Center on bounds
    this._x = bounds.center.x;
    this._y = bounds.center.y;
    this._zoom = newZoom;
    this._targetZoom = newZoom;
  }

  /**
   * Animate the camera to a target position and zoom with easing.
   * Call updateAnimation() each frame to advance.
   *
   * @param targetX - Target world X
   * @param targetY - Target world Y
   * @param targetZoom - Target zoom level
   * @param duration - Animation duration in milliseconds (default: 300)
   */
  animateTo(targetX: number, targetY: number, targetZoom: number, duration: number = 300): void {
    this._animation = {
      startX: this._x,
      startY: this._y,
      startZoom: this._zoom,
      targetX,
      targetY,
      targetZoom: this.clampZoom(targetZoom),
      startTime: performance.now(),
      duration: Math.max(1, duration),
    };
  }

  /**
   * Update the camera animation. Call each frame.
   *
   * @returns true if animation is still in progress
   */
  updateAnimation(): boolean {
    if (!this._animation) return false;

    const elapsed = performance.now() - this._animation.startTime;
    const t = Math.min(1, elapsed / this._animation.duration);
    const eased = easeInOutCubic(t);

    this._x = lerp(this._animation.startX, this._animation.targetX, eased);
    this._y = lerp(this._animation.startY, this._animation.targetY, eased);
    this._zoom = lerp(this._animation.startZoom, this._animation.targetZoom, eased);
    this._targetZoom = this._zoom;

    if (t >= 1) {
      this._animation = null;
      return false;
    }
    return true;
  }

  /**
   * Whether the camera is currently animating.
   */
  get isAnimating(): boolean {
    return this._animation !== null;
  }

  /**
   * Cancel any in-progress animation.
   */
  cancelAnimation(): void {
    this._animation = null;
  }

  /**
   * Animated version of zoomToFit. Smoothly transitions to fit bounds.
   *
   * @param bounds - The world bounds to fit
   * @param padding - Padding in pixels around the bounds
   * @param duration - Animation duration in ms (default: 300)
   */
  zoomToFitAnimated(bounds: Box, padding: number = 50, duration: number = 300): void {
    const availableWidth = Math.max(1, this._screenWidth - padding * 2);
    const availableHeight = Math.max(1, this._screenHeight - padding * 2);

    const boundsWidth = bounds.width;
    const boundsHeight = bounds.height;

    if (boundsWidth === 0 && boundsHeight === 0) {
      this.animateTo(bounds.center.x, bounds.center.y, this._zoom, duration);
      return;
    }

    const zoomX = boundsWidth > 0 ? availableWidth / boundsWidth : MAX_ZOOM;
    const zoomY = boundsHeight > 0 ? availableHeight / boundsHeight : MAX_ZOOM;
    const newZoom = this.clampZoom(Math.min(zoomX, zoomY));

    this.animateTo(bounds.center.x, bounds.center.y, newZoom, duration);
  }

  /**
   * Get the transformation matrix for rendering.
   * Apply this to the canvas context before drawing shapes.
   *
   * The matrix transforms world coordinates to screen coordinates:
   * 1. Translate by -camera position (center world origin)
   * 2. Scale by zoom
   * 3. Translate by screen center (move to canvas center)
   *
   * @returns 3x3 transformation matrix
   */
  getTransformMatrix(): Mat3 {
    const centerX = this._screenWidth / 2;
    const centerY = this._screenHeight / 2;

    // Build transform: translate to screen center, scale, translate by -camera
    // Order: first translate world by -camera, then scale, then translate to center
    // Combined: M = T(centerX, centerY) * S(zoom) * T(-camX, -camY)
    return Mat3.translation(centerX, centerY)
      .multiply(Mat3.scale(this._zoom))
      .multiply(Mat3.translation(-this._x, -this._y));
  }

  /**
   * Get the inverse transformation matrix.
   * Transforms screen coordinates to world coordinates.
   *
   * @returns Inverse transformation matrix, or null if not invertible
   */
  getInverseTransformMatrix(): Mat3 | null {
    return this.getTransformMatrix().inverse();
  }

  /**
   * Reset camera to default state (centered at origin, zoom 1).
   */
  reset(): void {
    this._x = 0;
    this._y = 0;
    this._zoom = 1;
    this._targetZoom = 1;
  }

  /**
   * Clone this camera.
   */
  clone(): Camera {
    const camera = new Camera({ x: this._x, y: this._y, zoom: this._zoom });
    camera._targetZoom = this._targetZoom;
    camera._screenWidth = this._screenWidth;
    camera._screenHeight = this._screenHeight;
    return camera;
  }

  /**
   * Clamp zoom to valid range.
   */
  private clampZoom(zoom: number): number {
    return clamp(zoom, MIN_ZOOM, MAX_ZOOM);
  }
}
