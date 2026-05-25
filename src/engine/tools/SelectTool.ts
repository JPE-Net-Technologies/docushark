import { BaseTool, ToolContext } from './Tool';
import { NormalizedPointerEvent } from '../InputHandler';
import { Vec2 } from '../../math/Vec2';
import { Box } from '../../math/Box';
import { ToolType, CursorStyle, useSessionStore } from '../../store/sessionStore';
import { MiddleClickPanHandler } from './PanTool';
import { Handle, HandleType, Shape, isRectangle, isEllipse, isLine, isText, isFile, isGroup, isConnector, isLibraryShape, Anchor, AnchorPosition } from '../../shapes/Shape';
import { snapBounds, snap, SnapResult } from '../Snapping';
import { shapeRegistry } from '../../shapes/ShapeRegistry';

/**
 * State machine states for the SelectTool.
 */
type SelectState =
  | 'idle'
  | 'pending' // Pointer down, waiting to see if drag or click
  | 'translating' // Dragging selected shapes
  | 'marquee' // Dragging a marquee selection box
  | 'resizing' // Dragging a resize handle
  | 'rotating'; // Dragging the rotation handle

/**
 * Threshold in pixels before a click becomes a drag.
 */
const DRAG_THRESHOLD = 3;

/**
 * Maximum time between clicks for a double-click (ms).
 */
const DOUBLE_CLICK_THRESHOLD = 600;

/**
 * Maximum distance between clicks for a double-click (pixels).
 */
const DOUBLE_CLICK_DISTANCE = 15;

/**
 * Distance threshold for snapping to anchors (in screen pixels).
 */
const ANCHOR_SNAP_DISTANCE = 15;

/**
 * Select tool for selecting and moving shapes.
 *
 * Features:
 * - Click to select a single shape
 * - Shift+click to add/remove from selection
 * - Click on empty space to clear selection
 * - Drag on empty space for marquee selection
 * - Drag selected shapes to move them
 * - Delete key to delete selected shapes
 * - Middle-click to pan (from any state)
 *
 * State machine:
 * - Idle: Waiting for interaction
 * - Pending: Pointer down, waiting to determine click vs drag
 * - Translating: Dragging selected shapes
 * - Marquee: Dragging a selection rectangle
 */
export class SelectTool extends BaseTool {
  readonly type: ToolType = 'select';
  readonly name = 'Select';
  readonly shortcut = 'v';

  private state: SelectState = 'idle';
  private pointerDownPoint: Vec2 | null = null;
  private pointerDownWorldPoint: Vec2 | null = null;
  private hitShapeId: string | null = null;
  // Raw (unresolved) hit id from the most recent pointer-down — preserved so
  // double-click can drill into a group and select the actual leaf shape,
  // not the group root that resolveHitToSelection lifted us to.
  private rawHitShapeId: string | null = null;

  // For translating shapes (includes x2, y2 for connectors)
  private dragStartPositions: Map<string, { x: number; y: number; x2?: number; y2?: number }> = new Map();

  // For marquee selection
  private marqueeStart: Vec2 | null = null;
  private marqueeEnd: Vec2 | null = null;

  // For resizing shapes
  private activeHandle: Handle | null = null;
  private resizeShapeId: string | null = null;
  private resizeOriginalShape: Shape | null = null;
  private resizeAnchorPoint: Vec2 | null = null;
  private isShiftHeld = false;

  // For rotating shapes
  private rotateShapeId: string | null = null;
  private rotateOriginalRotation: number = 0;
  private rotateStartAngle: number = 0;
  private rotateShapeCenter: Vec2 | null = null;

  // Middle-click pan support
  private panHandler = new MiddleClickPanHandler();

  // Double-click detection
  private lastClickTime: number = 0;
  private lastClickPoint: Vec2 | null = null;
  private lastClickShapeId: string | null = null;
  // Raw-hit shape from the previous click, used for drill-in detection
  // (the resolved id flips between "group" and "child" depending on whether
  // the group is selected, so the raw leaf is the stable anchor).
  private lastRawHitShapeId: string | null = null;

  // Snapping
  private currentSnapResult: SnapResult | null = null;

  // Connector anchor snapping (when resizing connector endpoints)
  private connectorHoveredAnchor: { shapeId: string; anchor: Anchor } | null = null;

  /**
   * Build a child→parent map for the current shape set. O(totalChildIds);
   * cheaper than running documentStore.getParentGroup() (an O(N) scan) once
   * per ancestor step.
   */
  private buildChildToParentMap(shapes: Record<string, Shape>): Map<string, string> {
    const map = new Map<string, string>();
    for (const shape of Object.values(shapes)) {
      if (isGroup(shape)) {
        for (const childId of shape.childIds) {
          map.set(childId, shape.id);
        }
      }
    }
    return map;
  }

  /**
   * Walk up from `id` until we hit `target` or run out of parents.
   * O(depth). Returns true iff `id === target` or any ancestor is `target`.
   */
  private isInSubtree(id: string, target: string, parentMap: Map<string, string>): boolean {
    let cur: string | undefined = id;
    while (cur) {
      if (cur === target) return true;
      cur = parentMap.get(cur);
    }
    return false;
  }

  /**
   * Resolve a hit shape ID to the appropriate selection target.
   *
   * Drill behaviour is "sticky and transferable":
   * - In drill mode (G set), clicks inside G's subtree return the raw
   *   hit so the user can click through any nested groups in G.
   * - Clicks outside G but inside *another* top-level group H transfer
   *   drill to H — the user stays in drill mode and now operates inside
   *   H. (Single-click hop between groups, no re-drill required.)
   * - Clicks on a top-level shape with no group ancestor exit drill mode
   *   and select the shape directly.
   *
   * Cold (no drill): hit walks up to the topmost group ancestor, stopping
   * early at any already-selected ancestor so shift / LayerPanel
   * click-through still works.
   */
  private resolveHitToSelection(hitId: string, ctx: ToolContext): string {
    const shapes = ctx.getShapes();
    const parentMap = this.buildChildToParentMap(shapes);
    const session = useSessionStore.getState();
    const editingGroupId = session.editingGroupId;

    if (editingGroupId) {
      // If the drilled-into group was deleted, drop drill and fall
      // through to cold resolution.
      if (!shapes[editingGroupId]) {
        session.setEditingGroupId(null);
      } else if (this.isInSubtree(hitId, editingGroupId, parentMap)) {
        // Still inside G — return the raw leaf (click-through).
        return hitId;
      } else {
        // Hit is outside G. Transfer drill to the new hit's top-level
        // group ancestor, or exit drill if the hit is ungrouped.
        const newTop = this.findTopGroupAncestor(hitId, parentMap);
        session.setEditingGroupId(newTop);
        return hitId;
      }
    }

    return this.resolveWithoutDrill(hitId, ctx, parentMap);
  }

  /**
   * Walk up `parentMap` from `id` and return the topmost group ancestor,
   * or null if `id` has no group ancestors. O(depth).
   */
  private findTopGroupAncestor(id: string, parentMap: Map<string, string>): string | null {
    let cur = id;
    let top: string | null = null;
    while (true) {
      const next = parentMap.get(cur);
      if (!next) return top;
      top = next;
      cur = next;
    }
  }

  /**
   * Today's resolution rules, factored out so drill-mode can short-circuit
   * before calling it. Walks up the parent chain to the top-level group,
   * but stops early at any ancestor the user has already selected.
   */
  private resolveWithoutDrill(
    hitId: string,
    ctx: ToolContext,
    parentMap: Map<string, string>
  ): string {
    const selectedIds = ctx.getSelectedIds();
    const selectedSet = new Set(selectedIds);

    // Hit shape itself already selected (e.g. via LayerPanel) — direct.
    if (selectedSet.has(hitId)) return hitId;

    const parentGroupId = parentMap.get(hitId);
    if (!parentGroupId) return hitId;

    // Parent group already selected — allow click-through to the child.
    if (selectedSet.has(parentGroupId)) return hitId;

    // Walk up to the topmost ancestor group (stopping at one that's selected).
    let cur = parentGroupId;
    while (true) {
      const next = parentMap.get(cur);
      if (!next) return cur;
      if (selectedSet.has(next)) return cur;
      cur = next;
    }
  }

  /**
   * Expand selected IDs to include children of groups.
   * When translating a group, we move all its children (not the group itself).
   * Handles nested groups recursively.
   */
  private expandGroupsToChildren(selectedIds: string[], shapes: Record<string, Shape>): string[] {
    const result = new Set<string>();

    const addShapeAndChildren = (id: string) => {
      const shape = shapes[id];
      if (!shape) return;

      if (isGroup(shape)) {
        // For groups, add children recursively, not the group itself
        for (const childId of shape.childIds) {
          addShapeAndChildren(childId);
        }
      } else {
        result.add(id);
      }
    };

    for (const id of selectedIds) {
      addShapeAndChildren(id);
    }

    return Array.from(result);
  }

  onActivate(ctx: ToolContext): void {
    ctx.setCursor('default');
  }

  onDeactivate(ctx: ToolContext): void {
    this.resetState();
    ctx.setCursor('default');
    ctx.setIsInteracting(false);
  }

  onPointerDown(event: NormalizedPointerEvent, ctx: ToolContext): void {
    // Handle middle-click pan
    if (this.panHandler.handlePointerDown(event, ctx)) {
      return;
    }

    if (event.button !== 'left') return;

    this.pointerDownPoint = event.screenPoint;
    this.pointerDownWorldPoint = event.worldPoint;
    this.isShiftHeld = event.modifiers.shift;

    // First, check if we clicked on a resize handle of a selected shape
    const selectedShapes = ctx.getSelectedShapes();
    if (selectedShapes.length === 1) {
      // Only show handles for single selection
      const handleSize = 10 / ctx.camera.zoom; // Handle size in world units
      const handleResult = ctx.hitTester.hitTestHandles(
        event.worldPoint,
        selectedShapes,
        handleSize
      );

      if (handleResult.handle && handleResult.shape) {
        const shape = handleResult.shape;

        // Check if shape is fully locked
        if (shape.locked) {
          // Locked shape - don't allow any resize or rotation
          return;
        }

        if (handleResult.handle.type === 'rotation') {
          // Clicked on rotation handle - start rotating
          // Rotation is blocked if shape is fully locked (checked above)
          this.rotateShapeId = handleResult.shapeId;
          this.rotateOriginalRotation = shape.rotation;
          this.rotateShapeCenter = new Vec2(shape.x, shape.y);

          // Calculate starting angle from shape center to click point
          const dx = event.worldPoint.x - shape.x;
          const dy = event.worldPoint.y - shape.y;
          this.rotateStartAngle = Math.atan2(dy, dx);

          this.state = 'rotating';
          ctx.setCursor('grabbing');
          ctx.setIsInteracting(true);
          ctx.pushHistory('Rotate shape');
          ctx.requestRender();
          return;
        }

        // Check if size is locked
        if (shape.lockedSize) {
          // Size locked - don't allow resize
          return;
        }

        // Clicked on a resize handle - start resizing
        this.activeHandle = handleResult.handle;
        this.resizeShapeId = handleResult.shapeId;
        this.resizeOriginalShape = { ...shape };
        this.resizeAnchorPoint = this.getAnchorPoint(shape, handleResult.handle.type);
        this.state = 'resizing';
        ctx.setCursor(handleResult.handle.cursor as CursorStyle);
        ctx.setIsInteracting(true);
        ctx.pushHistory('Resize shape');
        ctx.requestRender();
        return;
      }
    }

    // Hit test to see what we clicked on
    const hitResult = ctx.hitTester.hitTestPoint(
      event.worldPoint,
      ctx.getShapes(),
      ctx.getShapeOrder()
    );

    this.state = 'pending';

    // If we clicked on a shape, we might be starting a drag
    if (hitResult.id) {
      this.rawHitShapeId = hitResult.id;
      // Resolve to group if shape is in a group (unless group already selected for click-through)
      const effectiveId = this.resolveHitToSelection(hitResult.id, ctx);
      this.hitShapeId = effectiveId;

      // Check if it's already selected
      const selectedIds = ctx.getSelectedIds();
      const isAlreadySelected = selectedIds.includes(effectiveId);

      if (event.modifiers.shift) {
        // Shift+click: toggle selection
        if (isAlreadySelected) {
          ctx.removeFromSelection([effectiveId]);
        } else {
          ctx.addToSelection([effectiveId]);
        }
      } else if (!isAlreadySelected) {
        // Click on unselected shape: select only this shape
        ctx.select([effectiveId]);
      }
      // If already selected without shift, wait to see if it's a click or drag
    } else {
      this.hitShapeId = null;
      this.rawHitShapeId = null;
    }

    ctx.requestRender();
  }

  onPointerMove(event: NormalizedPointerEvent, ctx: ToolContext): void {
    // Handle middle-click pan
    if (this.panHandler.handlePointerMove(event, ctx)) {
      return;
    }

    this.isShiftHeld = event.modifiers.shift;

    switch (this.state) {
      case 'idle':
        this.handleIdleMove(event, ctx);
        break;

      case 'pending':
        this.handlePendingMove(event, ctx);
        break;

      case 'translating':
        this.handleTranslatingMove(event, ctx);
        break;

      case 'marquee':
        this.handleMarqueeMove(event, ctx);
        break;

      case 'resizing':
        this.handleResizingMove(event, ctx);
        break;

      case 'rotating':
        this.handleRotatingMove(event, ctx);
        break;
    }
  }

  onPointerUp(event: NormalizedPointerEvent, ctx: ToolContext): void {
    // Handle middle-click pan
    if (this.panHandler.handlePointerUp(event, ctx)) {
      return;
    }

    if (event.button !== 'left') return;

    switch (this.state) {
      case 'pending':
        // This was a click, not a drag
        this.handleClick(event, ctx);
        break;

      case 'translating':
        this.finishTranslate(ctx);
        break;

      case 'marquee':
        this.finishMarquee(ctx);
        break;

      case 'resizing':
        this.finishResize(ctx);
        break;

      case 'rotating':
        this.finishRotate(ctx);
        break;
    }

    this.resetState();
    ctx.setIsInteracting(false);
    ctx.setCursor('default');
    ctx.requestRender();
  }

  onKeyDown(event: KeyboardEvent, ctx: ToolContext): boolean {
    // Track Shift key for aspect ratio constraint during resize
    if (event.key === 'Shift') {
      this.isShiftHeld = true;
      if (this.state === 'resizing') {
        ctx.requestRender();
      }
      return false; // Let other handlers see this
    }

    // Delete or Backspace to delete selected shapes
    if (event.key === 'Delete' || event.key === 'Backspace') {
      const selectedIds = ctx.getSelectedIds();
      if (selectedIds.length > 0) {
        ctx.pushHistory('Delete shapes');
        ctx.deleteShapes(selectedIds);
        ctx.clearSelection();
        ctx.requestRender();
        return true;
      }
    }

    // Escape to cancel current operation or clear selection
    if (event.key === 'Escape') {
      if (this.state !== 'idle') {
        // Cancel current operation
        // TODO(JP-11): Revert any in-progress changes
        this.resetState();
        ctx.setIsInteracting(false);
        ctx.setCursor('default');
        ctx.requestRender();
        return true;
      } else if (ctx.getSelectedIds().length > 0) {
        // Clear selection
        ctx.clearSelection();
        ctx.requestRender();
        return true;
      }
    }

    // Ctrl+A or Cmd+A to select all
    if ((event.ctrlKey || event.metaKey) && event.key === 'a') {
      const allIds = ctx.getShapeOrder();
      if (allIds.length > 0) {
        ctx.select(allIds);
        ctx.requestRender();
        return true;
      }
    }

    return false;
  }

  onKeyUp(event: KeyboardEvent, ctx: ToolContext): boolean {
    if (event.key === 'Shift') {
      this.isShiftHeld = false;
      if (this.state === 'resizing') {
        ctx.requestRender();
      }
    }
    return false;
  }

  renderOverlay(ctx2d: CanvasRenderingContext2D, toolCtx: ToolContext): void {
    const camera = toolCtx.camera;

    // Draw snap guides when translating or resizing
    if ((this.state === 'translating' || this.state === 'resizing') && this.currentSnapResult) {
      ctx2d.save();
      ctx2d.strokeStyle = '#ff4081'; // Pink/magenta for snap guides
      ctx2d.lineWidth = 1;
      ctx2d.setLineDash([4, 4]);

      const canvasWidth = ctx2d.canvas.width;
      const canvasHeight = ctx2d.canvas.height;

      // Draw vertical snap line
      if (this.currentSnapResult.snappedX && this.currentSnapResult.snapLineX !== undefined) {
        const screenX = camera.worldToScreen(new Vec2(this.currentSnapResult.snapLineX, 0)).x;
        ctx2d.beginPath();
        ctx2d.moveTo(screenX, 0);
        ctx2d.lineTo(screenX, canvasHeight);
        ctx2d.stroke();
      }

      // Draw horizontal snap line
      if (this.currentSnapResult.snappedY && this.currentSnapResult.snapLineY !== undefined) {
        const screenY = camera.worldToScreen(new Vec2(0, this.currentSnapResult.snapLineY)).y;
        ctx2d.beginPath();
        ctx2d.moveTo(0, screenY);
        ctx2d.lineTo(canvasWidth, screenY);
        ctx2d.stroke();
      }

      ctx2d.restore();
    }

    // Draw anchor points when resizing a connector
    if (this.state === 'resizing' && this.resizeOriginalShape && isConnector(this.resizeOriginalShape)) {
      this.drawConnectorAnchorPoints(ctx2d, toolCtx);
    }

    // Draw marquee selection box
    if (this.state === 'marquee' && this.marqueeStart && this.marqueeEnd) {
      // Convert world points to screen points
      const start = camera.worldToScreen(this.marqueeStart);
      const end = camera.worldToScreen(this.marqueeEnd);

      const x = Math.min(start.x, end.x);
      const y = Math.min(start.y, end.y);
      const width = Math.abs(end.x - start.x);
      const height = Math.abs(end.y - start.y);

      // Draw marquee rectangle
      ctx2d.save();

      // Fill with semi-transparent blue
      ctx2d.fillStyle = 'rgba(33, 150, 243, 0.1)';
      ctx2d.fillRect(x, y, width, height);

      // Stroke with blue
      ctx2d.strokeStyle = '#2196f3';
      ctx2d.lineWidth = 1;
      ctx2d.setLineDash([4, 4]);
      ctx2d.strokeRect(x, y, width, height);

      ctx2d.restore();
    }
  }

  // State handlers

  private handleIdleMove(event: NormalizedPointerEvent, ctx: ToolContext): void {
    // First check for handle hover on selected shapes
    const selectedShapes = ctx.getSelectedShapes();
    if (selectedShapes.length === 1) {
      const shape = selectedShapes[0];

      // Don't show resize cursors for fully locked shapes
      if (shape && !shape.locked) {
        const handleSize = 10 / ctx.camera.zoom;
        const handleResult = ctx.hitTester.hitTestHandles(
          event.worldPoint,
          selectedShapes,
          handleSize
        );

        if (handleResult.handle) {
          // Don't show resize cursor if size is locked (but allow rotation)
          if (shape.lockedSize && handleResult.handle.type !== 'rotation') {
            ctx.setCursor('not-allowed');
          } else {
            ctx.setCursor(handleResult.handle.cursor as CursorStyle);
          }
          return;
        }
      }
    }

    // Update hover state and cursor for shapes
    const hitResult = ctx.hitTester.hitTestPoint(
      event.worldPoint,
      ctx.getShapes(),
      ctx.getShapeOrder()
    );

    if (hitResult.id) {
      const shape = ctx.getShapes()[hitResult.id];
      // Show not-allowed cursor for locked shapes or position-locked shapes
      if (shape && (shape.locked || shape.lockedPosition)) {
        ctx.setCursor('not-allowed');
      } else {
        ctx.setCursor('move');
      }
    } else {
      ctx.setCursor('default');
    }
  }

  private handlePendingMove(event: NormalizedPointerEvent, ctx: ToolContext): void {
    if (!this.pointerDownPoint) return;

    // Check if we've moved enough to start a drag
    const dx = event.screenPoint.x - this.pointerDownPoint.x;
    const dy = event.screenPoint.y - this.pointerDownPoint.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance >= DRAG_THRESHOLD) {
      // Start drag
      if (this.hitShapeId) {
        // Start translating selected shapes
        this.startTranslate(ctx);
      } else {
        // Start marquee selection
        this.startMarquee();
      }
      ctx.setIsInteracting(true);
    }
  }

  private handleTranslatingMove(event: NormalizedPointerEvent, ctx: ToolContext): void {
    if (!this.pointerDownWorldPoint) return;

    const delta = Vec2.subtract(event.worldPoint, this.pointerDownWorldPoint);
    const snapSettings = ctx.getSnapSettings();

    // Calculate the proposed new positions and get combined bounds
    let combinedBounds: Box | null = null;
    let firstShapeCenter: Vec2 | null = null;

    for (const [id, startPos] of this.dragStartPositions) {
      const shape = ctx.getShapes()[id];
      if (!shape) continue;

      const handler = shapeRegistry.getHandler(shape.type);
      const newCenter = new Vec2(startPos.x + delta.x, startPos.y + delta.y);

      // Create a temporary shape position to get bounds
      const tempShape = { ...shape, x: newCenter.x, y: newCenter.y };
      const bounds = handler.getBounds(tempShape);

      if (!combinedBounds) {
        combinedBounds = bounds;
        firstShapeCenter = newCenter;
      } else {
        combinedBounds = combinedBounds.union(bounds);
      }
    }

    // Apply snapping if enabled
    let finalDelta = delta;
    this.currentSnapResult = null;

    if (snapSettings.enabled && combinedBounds && firstShapeCenter) {
      const selectedIds = new Set(ctx.getSelectedIds());
      const snapResult = snapBounds(
        combinedBounds,
        firstShapeCenter,
        ctx.getShapes(),
        ctx.getShapeOrder(),
        {
          snapToGrid: snapSettings.snapToGrid,
          snapToShapes: snapSettings.snapToShapes,
          gridSpacing: snapSettings.gridSpacing,
          threshold: 10 / ctx.camera.zoom, // Adjust threshold based on zoom
          excludeIds: selectedIds,
        }
      );

      if (snapResult.snappedX || snapResult.snappedY) {
        this.currentSnapResult = snapResult;
        // Adjust delta based on snap
        const snapOffset = Vec2.subtract(snapResult.position, firstShapeCenter);
        finalDelta = Vec2.add(delta, snapOffset);

        // Set snap guides for rendering
        const guides: { verticalX?: number; horizontalY?: number } = {};
        if (snapResult.snappedX && snapResult.snapLineX !== undefined) {
          guides.verticalX = snapResult.snapLineX;
        }
        if (snapResult.snappedY && snapResult.snapLineY !== undefined) {
          guides.horizontalY = snapResult.snapLineY;
        }
        ctx.setSnapGuides(guides);
      } else {
        ctx.clearSnapGuides();
      }
    }

    // Update all selected shapes with the (possibly snapped) delta
    const updates: Array<{ id: string; updates: Partial<Shape> }> = [];

    for (const [id, startPos] of this.dragStartPositions) {
      const shapeUpdates: Partial<Shape> = {
        x: startPos.x + finalDelta.x,
        y: startPos.y + finalDelta.y,
      };

      // For connectors, also update x2 and y2
      if (startPos.x2 !== undefined && startPos.y2 !== undefined) {
        (shapeUpdates as { x2: number; y2: number }).x2 = startPos.x2 + finalDelta.x;
        (shapeUpdates as { x2: number; y2: number }).y2 = startPos.y2 + finalDelta.y;
      }

      updates.push({ id, updates: shapeUpdates });
    }

    ctx.updateShapes(updates);
    ctx.requestRender();
  }

  private handleMarqueeMove(event: NormalizedPointerEvent, ctx: ToolContext): void {
    this.marqueeEnd = event.worldPoint;
    ctx.requestRender();
  }

  private handleClick(event: NormalizedPointerEvent, ctx: ToolContext): void {
    const now = Date.now();

    // Check for double-click on editable shape (Text, Rectangle, Ellipse) or file shape
    if (this.hitShapeId) {
      const shape = ctx.getShapes()[this.hitShapeId];

      // Check if this shape supports label editing
      const supportsLabelEditing =
        shape && (isText(shape) || isRectangle(shape) || isEllipse(shape));
      const isFileShape = shape && isFile(shape);
      const supportsDoubleClick = supportsLabelEditing || isFileShape;

      // Check if this is a double-click on the same shape
      const isDoubleClick =
        supportsDoubleClick &&
        this.lastClickShapeId === this.hitShapeId &&
        this.lastClickPoint !== null &&
        now - this.lastClickTime < DOUBLE_CLICK_THRESHOLD;

      if (isDoubleClick && this.lastClickPoint) {
        // Calculate distance between clicks
        const dx = event.screenPoint.x - this.lastClickPoint.x;
        const dy = event.screenPoint.y - this.lastClickPoint.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance < DOUBLE_CLICK_DISTANCE) {
          if (isFileShape) {
            ctx.openFileViewer(this.hitShapeId);
          } else {
            ctx.startTextEdit(this.hitShapeId);
          }
          this.resetClickTracking();
          ctx.requestRender();
          return;
        }
      }

      // Drill into a group on double-click. The raw hit is the stable anchor
      // (resolved id flips between group and child depending on selection).
      // Only triggers when we're not already drilled in — once inside G, a
      // double-click falls through to text-edit on the leaf.
      const session = useSessionStore.getState();
      const sameRawHitDouble =
        this.rawHitShapeId !== null &&
        this.lastRawHitShapeId === this.rawHitShapeId &&
        this.lastClickPoint !== null &&
        now - this.lastClickTime < DOUBLE_CLICK_THRESHOLD;

      if (!session.editingGroupId && sameRawHitDouble && this.lastClickPoint && this.rawHitShapeId) {
        const dx = event.screenPoint.x - this.lastClickPoint.x;
        const dy = event.screenPoint.y - this.lastClickPoint.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance < DOUBLE_CLICK_DISTANCE) {
          const shapes = ctx.getShapes();
          const parentMap = this.buildChildToParentMap(shapes);
          const directParent = parentMap.get(this.rawHitShapeId);
          if (directParent) {
            session.setEditingGroupId(directParent);
            ctx.select([this.rawHitShapeId]);
            this.resetClickTracking();
            ctx.requestRender();
            return;
          }
        }
      }

      // Track this click for double-click detection
      // Clone the point to avoid reference issues
      this.lastClickTime = now;
      this.lastClickPoint = new Vec2(event.screenPoint.x, event.screenPoint.y);
      this.lastClickShapeId = this.hitShapeId;
      this.lastRawHitShapeId = this.rawHitShapeId;

      // Clicked on a shape
      if (!event.modifiers.shift) {
        // Without shift, select only this shape (might already be selected)
        ctx.select([this.hitShapeId]);
      }
      // With shift, toggle already happened in onPointerDown
    } else {
      // Clicked on empty space
      this.resetClickTracking();
      if (!event.modifiers.shift) {
        ctx.clearSelection();
      }
    }
  }

  private resetClickTracking(): void {
    this.lastClickTime = 0;
    this.lastClickPoint = null;
    this.lastClickShapeId = null;
    this.lastRawHitShapeId = null;
  }

  private startTranslate(ctx: ToolContext): void {
    this.state = 'translating';
    ctx.setCursor('move');

    // Push history before moving shapes
    ctx.pushHistory('Move shapes');

    // Store starting positions of all selected shapes
    // Expand groups to their children since we move children, not the group itself
    this.dragStartPositions.clear();
    const shapes = ctx.getShapes();
    const idsToTranslate = this.expandGroupsToChildren(ctx.getSelectedIds(), shapes);

    for (const id of idsToTranslate) {
      const shape = shapes[id];
      // Skip shapes that are locked or have position locked
      if (shape && !shape.locked && !shape.lockedPosition) {
        const startPos: { x: number; y: number; x2?: number; y2?: number } = { x: shape.x, y: shape.y };
        // For connectors, also store x2, y2
        if (isConnector(shape)) {
          startPos.x2 = shape.x2;
          startPos.y2 = shape.y2;
        }
        this.dragStartPositions.set(id, startPos);
      }
    }
  }

  private finishTranslate(ctx: ToolContext): void {
    // Shapes are already updated during drag
    // In the future, we might want to record this for undo/redo
    this.dragStartPositions.clear();

    // Clear snap guides
    ctx.clearSnapGuides();
    this.currentSnapResult = null;

    // Update spatial index for moved shapes
    const selectedIds = ctx.getSelectedIds();
    const shapes = ctx.getShapes();
    for (const id of selectedIds) {
      const shape = shapes[id];
      if (shape) {
        ctx.spatialIndex.update(shape);
      }
    }
  }

  private startMarquee(): void {
    this.state = 'marquee';
    this.marqueeStart = this.pointerDownWorldPoint;
    this.marqueeEnd = this.pointerDownWorldPoint;
  }

  private finishMarquee(ctx: ToolContext): void {
    if (!this.marqueeStart || !this.marqueeEnd) return;

    // Create selection box
    const rect = new Box(
      Math.min(this.marqueeStart.x, this.marqueeEnd.x),
      Math.min(this.marqueeStart.y, this.marqueeEnd.y),
      Math.max(this.marqueeStart.x, this.marqueeEnd.x),
      Math.max(this.marqueeStart.y, this.marqueeEnd.y)
    );

    // Find shapes in the marquee
    const hitIds = ctx.hitTester.hitTestRectIds(
      rect,
      ctx.getShapes(),
      ctx.getShapeOrder()
    );

    // Select found shapes
    if (hitIds.length > 0) {
      ctx.select(hitIds);
    }

    this.marqueeStart = null;
    this.marqueeEnd = null;
  }

  private resetState(): void {
    this.state = 'idle';
    this.pointerDownPoint = null;
    this.pointerDownWorldPoint = null;
    this.hitShapeId = null;
    this.dragStartPositions.clear();
    this.marqueeStart = null;
    this.marqueeEnd = null;
    this.activeHandle = null;
    this.resizeShapeId = null;
    this.resizeOriginalShape = null;
    this.resizeAnchorPoint = null;
    this.isShiftHeld = false;
    this.rotateShapeId = null;
    this.rotateOriginalRotation = 0;
    this.rotateStartAngle = 0;
    this.rotateShapeCenter = null;
    this.currentSnapResult = null;
    this.connectorHoveredAnchor = null;
    this.panHandler.reset();
    // Note: Don't reset click tracking here, it persists across interactions
  }

  /**
   * Handle mouse move during rotation operation.
   */
  private handleRotatingMove(event: NormalizedPointerEvent, ctx: ToolContext): void {
    if (!this.rotateShapeId || !this.rotateShapeCenter) {
      return;
    }

    // Calculate current angle from shape center to mouse
    const dx = event.worldPoint.x - this.rotateShapeCenter.x;
    const dy = event.worldPoint.y - this.rotateShapeCenter.y;
    const currentAngle = Math.atan2(dy, dx);

    // Calculate rotation delta
    let deltaAngle = currentAngle - this.rotateStartAngle;

    // Snap to 15-degree increments if Shift is held
    if (this.isShiftHeld) {
      const snapAngle = Math.PI / 12; // 15 degrees
      const newRotation = this.rotateOriginalRotation + deltaAngle;
      const snappedRotation = Math.round(newRotation / snapAngle) * snapAngle;
      deltaAngle = snappedRotation - this.rotateOriginalRotation;
    }

    const newRotation = this.rotateOriginalRotation + deltaAngle;

    ctx.updateShape(this.rotateShapeId, { rotation: newRotation });
    ctx.requestRender();
  }

  /**
   * Finish rotation operation and update spatial index.
   */
  private finishRotate(ctx: ToolContext): void {
    if (this.rotateShapeId) {
      const shape = ctx.getShapes()[this.rotateShapeId];
      if (shape) {
        ctx.spatialIndex.update(shape);
      }
    }
  }

  /**
   * Handle mouse move during resize operation.
   */
  private handleResizingMove(event: NormalizedPointerEvent, ctx: ToolContext): void {
    if (!this.activeHandle || !this.resizeShapeId || !this.resizeOriginalShape) {
      return;
    }

    const original = this.resizeOriginalShape;
    const handleType = this.activeHandle.type;

    // Handle custom swimlane handles
    if (handleType.startsWith('lane-divider-')) {
      this.handleLaneDividerDrag(event, ctx);
      return;
    }
    if (handleType === 'header-resize') {
      this.handleHeaderResizeDrag(event, ctx);
      return;
    }
    // Handle lifeline tail drag
    if (handleType === 'lifeline-tail') {
      this.handleLifelineTailDrag(event, ctx);
      return;
    }

    // Standard resize handles require anchor point
    if (!this.resizeAnchorPoint) {
      return;
    }

    let currentPoint = event.worldPoint;

    // For connectors, check for anchor snapping
    if (isConnector(original)) {
      const anchorResult = this.findNearestAnchor(event.worldPoint, event.screenPoint, ctx, this.resizeShapeId);
      if (anchorResult) {
        this.connectorHoveredAnchor = anchorResult;
        currentPoint = new Vec2(anchorResult.anchor.x, anchorResult.anchor.y);
      } else {
        this.connectorHoveredAnchor = null;
      }
    } else {
      // For non-connectors, apply smart-alignment snapping
      const snapSettings = ctx.getSnapSettings();
      if (snapSettings.enabled) {
        const shapes = ctx.getShapes();
        const shapeOrder = ctx.getShapeOrder();
        const excludeIds = new Set([this.resizeShapeId]);

        const snapResult = snap(currentPoint, shapes, shapeOrder, {
          snapToGrid: snapSettings.snapToGrid,
          snapToShapes: snapSettings.snapToShapes,
          gridSpacing: snapSettings.gridSpacing,
          excludeIds,
        });

        if (snapResult.snappedX || snapResult.snappedY) {
          currentPoint = snapResult.position;
          this.currentSnapResult = snapResult;

          // Set snap guides for visual feedback
          const guides: { verticalX?: number; horizontalY?: number } = {};
          if (snapResult.snappedX && snapResult.snapLineX !== undefined) {
            guides.verticalX = snapResult.snapLineX;
          }
          if (snapResult.snappedY && snapResult.snapLineY !== undefined) {
            guides.horizontalY = snapResult.snapLineY;
          }
          ctx.setSnapGuides(guides);
        } else {
          this.currentSnapResult = null;
          ctx.clearSnapGuides();
        }
      }
    }

    // Calculate new shape properties based on handle type and original shape
    const updates = this.calculateResize(
      original,
      handleType,
      currentPoint,
      this.resizeAnchorPoint,
      this.isShiftHeld
    );

    if (updates) {
      // For connectors, add anchor connection info
      if (isConnector(original) && this.connectorHoveredAnchor) {
        if (handleType === 'left') {
          (updates as Partial<Shape> & { startShapeId?: string; startAnchor?: AnchorPosition }).startShapeId = this.connectorHoveredAnchor.shapeId;
          (updates as Partial<Shape> & { startShapeId?: string; startAnchor?: AnchorPosition }).startAnchor = this.connectorHoveredAnchor.anchor.position;
        } else {
          (updates as Partial<Shape> & { endShapeId?: string; endAnchor?: AnchorPosition }).endShapeId = this.connectorHoveredAnchor.shapeId;
          (updates as Partial<Shape> & { endShapeId?: string; endAnchor?: AnchorPosition }).endAnchor = this.connectorHoveredAnchor.anchor.position;
        }
      }

      ctx.updateShape(this.resizeShapeId, updates);
      ctx.requestRender();
    }
  }

  /**
   * Handle lane divider drag to adjust swimlane lane widths.
   */
  private handleLaneDividerDrag(event: NormalizedPointerEvent, ctx: ToolContext): void {
    if (!this.activeHandle || !this.resizeShapeId || !this.resizeOriginalShape) return;

    const shape = this.resizeOriginalShape;
    if (!isLibraryShape(shape) || shape.type !== 'activity-swimlane') return;

    // Extract lane index from handle type: 'lane-divider-0' -> 0
    const laneIndex = parseInt(this.activeHandle.type.split('-')[2] || '0', 10);

    // Get current custom properties
    const customProps = (shape.customProperties || {}) as {
      orientation?: 'horizontal' | 'vertical';
      laneHeaders?: string[];
      laneWidths?: number[];
      headerSize?: number;
    };
    const orientation = customProps.orientation ?? 'horizontal';
    const laneHeaders = customProps.laneHeaders || ['Lane 1', 'Lane 2'];
    const numLanes = laneHeaders.length;

    // Transform mouse position to local space
    const local = this.worldToLocal(event.worldPoint, shape);

    if (orientation === 'horizontal') {
      // Dragging vertical divider - affects lane widths
      const totalWidth = shape.width;
      const hw = totalWidth / 2;

      // Calculate new position as cumulative ratio
      const dividerX = local.x + hw; // Convert from centered to left-origin
      const cumulativeRatio = Math.max(0.1, Math.min(0.9, dividerX / totalWidth));

      // Redistribute widths
      const newWidths = this.redistributeLaneWidths(
        numLanes,
        laneIndex,
        cumulativeRatio,
        customProps.laneWidths || []
      );

      ctx.updateShape(this.resizeShapeId, {
        customProperties: {
          ...customProps,
          laneWidths: newWidths,
        },
      } as Partial<Shape>);
    } else {
      // Dragging horizontal divider - affects lane heights (stored as laneWidths)
      const totalHeight = shape.height;
      const hh = totalHeight / 2;

      const dividerY = local.y + hh;
      const cumulativeRatio = Math.max(0.1, Math.min(0.9, dividerY / totalHeight));

      const newWidths = this.redistributeLaneWidths(
        numLanes,
        laneIndex,
        cumulativeRatio,
        customProps.laneWidths || []
      );

      ctx.updateShape(this.resizeShapeId, {
        customProperties: {
          ...customProps,
          laneWidths: newWidths,
        },
      } as Partial<Shape>);
    }

    ctx.requestRender();
  }

  /**
   * Handle header resize drag to adjust swimlane header size.
   */
  private handleHeaderResizeDrag(event: NormalizedPointerEvent, ctx: ToolContext): void {
    if (!this.resizeShapeId || !this.resizeOriginalShape) return;

    const shape = this.resizeOriginalShape;
    if (!isLibraryShape(shape) || shape.type !== 'activity-swimlane') return;

    const customProps = (shape.customProperties || {}) as {
      orientation?: 'horizontal' | 'vertical';
      headerSize?: number;
      laneHeaders?: string[];
      laneWidths?: number[];
    };
    const orientation = customProps.orientation ?? 'horizontal';

    const local = this.worldToLocal(event.worldPoint, shape);

    let newHeaderSize: number;
    const minHeader = 20;
    const maxHeader = 100;

    if (orientation === 'horizontal') {
      // Header is at top - drag Y affects headerSize
      const hh = shape.height / 2;
      newHeaderSize = Math.max(minHeader, Math.min(maxHeader, local.y + hh));
    } else {
      // Header is at left - drag X affects headerSize
      const hw = shape.width / 2;
      newHeaderSize = Math.max(minHeader, Math.min(maxHeader, local.x + hw));
    }

    ctx.updateShape(this.resizeShapeId, {
      customProperties: {
        ...customProps,
        headerSize: newHeaderSize,
      },
    } as Partial<Shape>);

    ctx.requestRender();
  }

  /**
   * Handle lifeline tail drag to adjust lifelineLength.
   */
  private handleLifelineTailDrag(event: NormalizedPointerEvent, ctx: ToolContext): void {
    if (!this.resizeShapeId || !this.resizeOriginalShape) return;

    const shape = this.resizeOriginalShape;
    if (!isLibraryShape(shape) || shape.type !== 'seq-lifeline') return;

    const customProps = (shape.customProperties || {}) as {
      lifelineLength?: number;
      headType?: string;
      stereotype?: string;
    };

    const local = this.worldToLocal(event.worldPoint, shape);

    // Calculate header height and line start position
    const headerHeight = Math.min(50, shape.height);
    const lineStartY = -shape.height / 2 + headerHeight;

    // New lifeline length is the distance from lineStartY to current mouse Y
    const newLifelineLength = Math.max(50, local.y - lineStartY);

    ctx.updateShape(this.resizeShapeId, {
      customProperties: {
        ...customProps,
        lifelineLength: newLifelineLength,
      },
    } as Partial<Shape>);

    ctx.requestRender();
  }

  /**
   * Transform a world point to local shape space.
   */
  private worldToLocal(worldPoint: Vec2, shape: Shape): Vec2 {
    const translated = new Vec2(worldPoint.x - shape.x, worldPoint.y - shape.y);
    return translated.rotate(-shape.rotation);
  }

  /**
   * Redistribute lane widths when a divider is dragged.
   * Scales lanes on each side of the divider to achieve the target cumulative ratio.
   */
  private redistributeLaneWidths(
    numLanes: number,
    dividerIndex: number,
    cumulativeRatio: number,
    currentWidths: number[]
  ): number[] {
    // Initialize weights if empty or wrong length
    let weights =
      currentWidths.length === numLanes ? [...currentWidths] : Array(numLanes).fill(1);

    // Calculate current cumulative ratio up to dividerIndex
    const total = weights.reduce((a, b) => a + b, 0);
    let leftTotal = 0;
    for (let i = 0; i <= dividerIndex; i++) {
      leftTotal += weights[i] ?? 0;
    }

    // Scale left lanes and right lanes to achieve new ratio
    const newLeftTotal = cumulativeRatio * total;
    const newRightTotal = (1 - cumulativeRatio) * total;

    // Scale factors
    const leftScale = leftTotal > 0 ? newLeftTotal / leftTotal : 1;
    const rightTotal = total - leftTotal;
    const rightScale = rightTotal > 0 ? newRightTotal / rightTotal : 1;

    // Apply scaling
    for (let i = 0; i <= dividerIndex; i++) {
      weights[i] = (weights[i] ?? 1) * leftScale;
    }
    for (let i = dividerIndex + 1; i < numLanes; i++) {
      weights[i] = (weights[i] ?? 1) * rightScale;
    }

    // Normalize to keep weights reasonable (sum to numLanes)
    const newTotal = weights.reduce((a, b) => a + b, 0);
    return weights.map((w) => (w / newTotal) * numLanes);
  }

  /**
   * Draw anchor points on shapes when resizing a connector.
   * Recursively draws anchors for shapes inside groups.
   */
  private drawConnectorAnchorPoints(ctx2d: CanvasRenderingContext2D, toolCtx: ToolContext): void {
    const camera = toolCtx.camera;
    const shapes = toolCtx.getShapes();

    ctx2d.save();

    // Helper to recursively draw anchors, including inside groups
    const drawAnchorsForShape = (shapeId: string) => {
      // Don't show anchors on the connector itself
      if (shapeId === this.resizeShapeId) return;

      const shape = shapes[shapeId];
      if (!shape || isConnector(shape)) return;

      // For groups, recursively draw children's anchors
      if (isGroup(shape)) {
        for (const childId of shape.childIds) {
          drawAnchorsForShape(childId);
        }
        return;
      }

      const handler = shapeRegistry.getHandler(shape.type);
      if (!handler.getAnchors) return;

      const anchors = handler.getAnchors(shape);
      for (const anchor of anchors) {
        const screenPos = camera.worldToScreen(new Vec2(anchor.x, anchor.y));

        // Highlight hovered anchor
        const isHovered =
          this.connectorHoveredAnchor?.shapeId === shapeId &&
          this.connectorHoveredAnchor?.anchor.position === anchor.position;

        ctx2d.beginPath();
        ctx2d.arc(screenPos.x, screenPos.y, isHovered ? 8 : 5, 0, Math.PI * 2);

        if (isHovered) {
          ctx2d.fillStyle = '#2196f3';
          ctx2d.fill();
          ctx2d.strokeStyle = '#ffffff';
          ctx2d.lineWidth = 2;
          ctx2d.stroke();
        } else {
          ctx2d.fillStyle = 'rgba(33, 150, 243, 0.3)';
          ctx2d.fill();
          ctx2d.strokeStyle = '#2196f3';
          ctx2d.lineWidth = 1;
          ctx2d.stroke();
        }
      }
    };

    for (const shapeId of toolCtx.getShapeOrder()) {
      drawAnchorsForShape(shapeId);
    }

    ctx2d.restore();
  }

  /**
   * Find the nearest anchor point on any shape (for connector snapping).
   * Recursively searches inside groups to find child shape anchors.
   */
  private findNearestAnchor(
    _worldPoint: Vec2,
    screenPoint: Vec2,
    ctx: ToolContext,
    excludeShapeId?: string
  ): { shapeId: string; anchor: Anchor } | null {
    const shapes = ctx.getShapes();
    let bestResult: { shapeId: string; anchor: Anchor } | null = null;
    let bestDistance = ANCHOR_SNAP_DISTANCE;

    // Helper to recursively find anchors, including inside groups
    const findAnchorsInShape = (shapeId: string) => {
      // Don't snap to the connector itself or excluded shapes
      if (shapeId === excludeShapeId) return;

      const shape = shapes[shapeId];
      if (!shape || isConnector(shape)) return;

      // For groups, recursively check children
      if (isGroup(shape)) {
        for (const childId of shape.childIds) {
          findAnchorsInShape(childId);
        }
        return;
      }

      const handler = shapeRegistry.getHandler(shape.type);
      if (!handler.getAnchors) return;

      const anchors = handler.getAnchors(shape);
      for (const anchor of anchors) {
        // Calculate distance in screen pixels
        const anchorScreen = ctx.camera.worldToScreen(new Vec2(anchor.x, anchor.y));
        const screenDistance = Vec2.distance(anchorScreen, screenPoint);

        if (screenDistance < bestDistance) {
          bestDistance = screenDistance;
          bestResult = { shapeId, anchor };
        }
      }
    };

    for (const shapeId of ctx.getShapeOrder()) {
      findAnchorsInShape(shapeId);
    }

    return bestResult;
  }

  /**
   * Finish resize operation and update spatial index.
   */
  private finishResize(ctx: ToolContext): void {
    // Clear snap guides
    ctx.clearSnapGuides();
    this.currentSnapResult = null;

    if (this.resizeShapeId) {
      const shape = ctx.getShapes()[this.resizeShapeId];
      if (shape) {
        ctx.spatialIndex.update(shape);
      }
    }
  }

  /**
   * Get the anchor point (opposite corner/edge) for a resize handle.
   */
  private getAnchorPoint(shape: Shape, handleType: HandleType): Vec2 {
    if (isRectangle(shape)) {
      const halfWidth = shape.width / 2;
      const halfHeight = shape.height / 2;

      // Get the opposite corner/edge point
      const anchorOffsets: Record<string, { x: number; y: number }> = {
        'top-left': { x: halfWidth, y: halfHeight },
        'top': { x: 0, y: halfHeight },
        'top-right': { x: -halfWidth, y: halfHeight },
        'right': { x: -halfWidth, y: 0 },
        'bottom-right': { x: -halfWidth, y: -halfHeight },
        'bottom': { x: 0, y: -halfHeight },
        'bottom-left': { x: halfWidth, y: -halfHeight },
        'left': { x: halfWidth, y: 0 },
        'rotation': { x: 0, y: 0 },
      };

      const offset = anchorOffsets[handleType] ?? { x: 0, y: 0 };
      // Apply rotation to the offset
      const rotatedOffset = new Vec2(offset.x, offset.y).rotate(shape.rotation);
      return new Vec2(shape.x + rotatedOffset.x, shape.y + rotatedOffset.y);
    }

    if (isEllipse(shape)) {
      // For ellipse, use the opposite point on the ellipse
      const anchorOffsets: Record<string, { x: number; y: number }> = {
        'top-left': { x: shape.radiusX, y: shape.radiusY },
        'top': { x: 0, y: shape.radiusY },
        'top-right': { x: -shape.radiusX, y: shape.radiusY },
        'right': { x: -shape.radiusX, y: 0 },
        'bottom-right': { x: -shape.radiusX, y: -shape.radiusY },
        'bottom': { x: 0, y: -shape.radiusY },
        'bottom-left': { x: shape.radiusX, y: -shape.radiusY },
        'left': { x: shape.radiusX, y: 0 },
        'rotation': { x: 0, y: 0 },
      };

      const offset = anchorOffsets[handleType] ?? { x: 0, y: 0 };
      const rotatedOffset = new Vec2(offset.x, offset.y).rotate(shape.rotation);
      return new Vec2(shape.x + rotatedOffset.x, shape.y + rotatedOffset.y);
    }

    if (isLine(shape)) {
      // For lines, anchor is the other endpoint
      if (handleType === 'top-left' || handleType === 'left' || handleType === 'bottom-left') {
        return new Vec2(shape.x2, shape.y2);
      } else {
        return new Vec2(shape.x, shape.y);
      }
    }

    if (isConnector(shape)) {
      // For connectors, anchor is the other endpoint
      if (handleType === 'left') {
        return new Vec2(shape.x2, shape.y2);
      } else {
        return new Vec2(shape.x, shape.y);
      }
    }

    if (isText(shape)) {
      // For text, estimate height based on content (simplified)
      const lineHeight = shape.fontSize * 1.4;
      const lines = shape.text.split('\n').length;
      const height = Math.max(lines * lineHeight, lineHeight);
      const halfWidth = shape.width / 2;
      const halfHeight = height / 2;

      const anchorOffsets: Record<string, { x: number; y: number }> = {
        'top-left': { x: halfWidth, y: halfHeight },
        'top': { x: 0, y: halfHeight },
        'top-right': { x: -halfWidth, y: halfHeight },
        'right': { x: -halfWidth, y: 0 },
        'bottom-right': { x: -halfWidth, y: -halfHeight },
        'bottom': { x: 0, y: -halfHeight },
        'bottom-left': { x: halfWidth, y: -halfHeight },
        'left': { x: halfWidth, y: 0 },
        'rotation': { x: 0, y: 0 },
      };

      const offset = anchorOffsets[handleType] ?? { x: 0, y: 0 };
      const rotatedOffset = new Vec2(offset.x, offset.y).rotate(shape.rotation);
      return new Vec2(shape.x + rotatedOffset.x, shape.y + rotatedOffset.y);
    }

    // Library shapes use width/height like rectangles
    if (isLibraryShape(shape)) {
      const halfWidth = shape.width / 2;
      const halfHeight = shape.height / 2;

      const anchorOffsets: Record<string, { x: number; y: number }> = {
        'top-left': { x: halfWidth, y: halfHeight },
        'top': { x: 0, y: halfHeight },
        'top-right': { x: -halfWidth, y: halfHeight },
        'right': { x: -halfWidth, y: 0 },
        'bottom-right': { x: -halfWidth, y: -halfHeight },
        'bottom': { x: 0, y: -halfHeight },
        'bottom-left': { x: halfWidth, y: -halfHeight },
        'left': { x: halfWidth, y: 0 },
        'rotation': { x: 0, y: 0 },
      };

      const offset = anchorOffsets[handleType] ?? { x: 0, y: 0 };
      const rotatedOffset = new Vec2(offset.x, offset.y).rotate(shape.rotation);
      return new Vec2(shape.x + rotatedOffset.x, shape.y + rotatedOffset.y);
    }

    // Default fallback for any other shape types
    return new Vec2((shape as { x: number }).x, (shape as { y: number }).y);
  }

  /**
   * Calculate new shape properties based on resize operation.
   */
  private calculateResize(
    original: Shape,
    handleType: HandleType,
    currentPoint: Vec2,
    anchor: Vec2,
    maintainAspectRatio: boolean
  ): Partial<Shape> | null {
    if (isRectangle(original)) {
      return this.calculateRectangleResize(original, handleType, currentPoint, anchor, maintainAspectRatio);
    }

    if (isEllipse(original)) {
      return this.calculateEllipseResize(original, handleType, currentPoint, anchor, maintainAspectRatio);
    }

    if (isLine(original)) {
      return this.calculateLineResize(original, handleType, currentPoint);
    }

    if (isConnector(original)) {
      return this.calculateConnectorResize(original, handleType, currentPoint);
    }

    if (isText(original)) {
      return this.calculateTextResize(original, handleType, currentPoint, anchor);
    }

    // Library shapes use the same resize logic as rectangles (width/height based)
    if (isLibraryShape(original)) {
      return this.calculateLibraryShapeResize(original, handleType, currentPoint, anchor, maintainAspectRatio);
    }

    return null;
  }

  /**
   * Calculate rectangle resize.
   */
  private calculateRectangleResize(
    original: Shape,
    handleType: HandleType,
    currentPoint: Vec2,
    anchor: Vec2,
    maintainAspectRatio: boolean
  ): Partial<Shape> {
    if (!isRectangle(original)) return {};

    // Transform current point to local space (un-rotate around original center)
    const toLocal = (p: Vec2): Vec2 => {
      const translated = Vec2.subtract(p, new Vec2(original.x, original.y));
      return translated.rotate(-original.rotation);
    };

    const localAnchor = toLocal(anchor);
    const localCurrent = toLocal(currentPoint);

    // Calculate new dimensions based on handle type
    let newWidth = original.width;
    let newHeight = original.height;
    let newCenterX = 0;
    let newCenterY = 0;

    const isCorner = ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(handleType);
    const isHorizontal = ['left', 'right'].includes(handleType);
    const isVertical = ['top', 'bottom'].includes(handleType);

    if (isCorner) {
      // Corner resize: both dimensions change
      newWidth = Math.abs(localCurrent.x - localAnchor.x);
      newHeight = Math.abs(localCurrent.y - localAnchor.y);
      newCenterX = (localCurrent.x + localAnchor.x) / 2;
      newCenterY = (localCurrent.y + localAnchor.y) / 2;

      if (maintainAspectRatio && original.width > 0 && original.height > 0) {
        const aspectRatio = original.width / original.height;
        const currentRatio = newWidth / newHeight;

        if (currentRatio > aspectRatio) {
          newWidth = newHeight * aspectRatio;
        } else {
          newHeight = newWidth / aspectRatio;
        }

        // Adjust center based on which corner
        if (handleType === 'top-left') {
          newCenterX = localAnchor.x - newWidth / 2;
          newCenterY = localAnchor.y - newHeight / 2;
        } else if (handleType === 'top-right') {
          newCenterX = localAnchor.x + newWidth / 2;
          newCenterY = localAnchor.y - newHeight / 2;
        } else if (handleType === 'bottom-left') {
          newCenterX = localAnchor.x - newWidth / 2;
          newCenterY = localAnchor.y + newHeight / 2;
        } else {
          newCenterX = localAnchor.x + newWidth / 2;
          newCenterY = localAnchor.y + newHeight / 2;
        }
      }
    } else if (isHorizontal) {
      // Horizontal resize: only width changes
      newWidth = Math.abs(localCurrent.x - localAnchor.x);
      newCenterX = (localCurrent.x + localAnchor.x) / 2;
      newCenterY = 0;

      if (maintainAspectRatio && original.width > 0) {
        const aspectRatio = original.width / original.height;
        newHeight = newWidth / aspectRatio;
      }
    } else if (isVertical) {
      // Vertical resize: only height changes
      newHeight = Math.abs(localCurrent.y - localAnchor.y);
      newCenterX = 0;
      newCenterY = (localCurrent.y + localAnchor.y) / 2;

      if (maintainAspectRatio && original.height > 0) {
        const aspectRatio = original.width / original.height;
        newWidth = newHeight * aspectRatio;
      }
    }

    // Enforce minimum size
    const minSize = 5;
    newWidth = Math.max(newWidth, minSize);
    newHeight = Math.max(newHeight, minSize);

    // Transform new center back to world space
    const worldCenter = new Vec2(newCenterX, newCenterY).rotate(original.rotation);

    return {
      x: original.x + worldCenter.x,
      y: original.y + worldCenter.y,
      width: newWidth,
      height: newHeight,
    };
  }

  /**
   * Calculate ellipse resize.
   */
  private calculateEllipseResize(
    original: Shape,
    handleType: HandleType,
    currentPoint: Vec2,
    anchor: Vec2,
    maintainAspectRatio: boolean
  ): Partial<Shape> {
    if (!isEllipse(original)) return {};

    // Transform current point to local space
    const toLocal = (p: Vec2): Vec2 => {
      const translated = Vec2.subtract(p, new Vec2(original.x, original.y));
      return translated.rotate(-original.rotation);
    };

    const localAnchor = toLocal(anchor);
    const localCurrent = toLocal(currentPoint);

    let newRadiusX = original.radiusX;
    let newRadiusY = original.radiusY;
    let newCenterX = 0;
    let newCenterY = 0;

    const isCorner = ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(handleType);
    const isHorizontal = ['left', 'right'].includes(handleType);
    const isVertical = ['top', 'bottom'].includes(handleType);

    if (isCorner) {
      // Corner resize: both radii change
      newRadiusX = Math.abs(localCurrent.x - localAnchor.x) / 2;
      newRadiusY = Math.abs(localCurrent.y - localAnchor.y) / 2;
      newCenterX = (localCurrent.x + localAnchor.x) / 2;
      newCenterY = (localCurrent.y + localAnchor.y) / 2;

      if (maintainAspectRatio && original.radiusX > 0 && original.radiusY > 0) {
        const aspectRatio = original.radiusX / original.radiusY;
        const currentRatio = newRadiusX / newRadiusY;

        if (currentRatio > aspectRatio) {
          newRadiusX = newRadiusY * aspectRatio;
        } else {
          newRadiusY = newRadiusX / aspectRatio;
        }

        // Adjust center based on which corner
        if (handleType === 'top-left') {
          newCenterX = localAnchor.x - newRadiusX;
          newCenterY = localAnchor.y - newRadiusY;
        } else if (handleType === 'top-right') {
          newCenterX = localAnchor.x + newRadiusX;
          newCenterY = localAnchor.y - newRadiusY;
        } else if (handleType === 'bottom-left') {
          newCenterX = localAnchor.x - newRadiusX;
          newCenterY = localAnchor.y + newRadiusY;
        } else {
          newCenterX = localAnchor.x + newRadiusX;
          newCenterY = localAnchor.y + newRadiusY;
        }
      }
    } else if (isHorizontal) {
      newRadiusX = Math.abs(localCurrent.x - localAnchor.x) / 2;
      newCenterX = (localCurrent.x + localAnchor.x) / 2;
      newCenterY = 0;

      if (maintainAspectRatio && original.radiusX > 0) {
        const aspectRatio = original.radiusX / original.radiusY;
        newRadiusY = newRadiusX / aspectRatio;
      }
    } else if (isVertical) {
      newRadiusY = Math.abs(localCurrent.y - localAnchor.y) / 2;
      newCenterX = 0;
      newCenterY = (localCurrent.y + localAnchor.y) / 2;

      if (maintainAspectRatio && original.radiusY > 0) {
        const aspectRatio = original.radiusX / original.radiusY;
        newRadiusX = newRadiusY * aspectRatio;
      }
    }

    // Enforce minimum size
    const minRadius = 5;
    newRadiusX = Math.max(newRadiusX, minRadius);
    newRadiusY = Math.max(newRadiusY, minRadius);

    // Transform new center back to world space
    const worldCenter = new Vec2(newCenterX, newCenterY).rotate(original.rotation);

    return {
      x: original.x + worldCenter.x,
      y: original.y + worldCenter.y,
      radiusX: newRadiusX,
      radiusY: newRadiusY,
    };
  }

  /**
   * Calculate line resize (moving endpoints).
   */
  private calculateLineResize(
    original: Shape,
    handleType: HandleType,
    currentPoint: Vec2
  ): Partial<Shape> {
    if (!isLine(original)) return {};

    // For lines, we move the endpoint that corresponds to the handle
    // Left-side handles move the start point, right-side handles move the end point
    if (handleType === 'top-left' || handleType === 'left' || handleType === 'bottom-left') {
      return {
        x: currentPoint.x,
        y: currentPoint.y,
      };
    } else {
      return {
        x2: currentPoint.x,
        y2: currentPoint.y,
      };
    }
  }

  /**
   * Calculate connector resize (moving endpoints).
   * Connection info (startShapeId/endShapeId) is handled separately in handleResizingMove
   * based on whether we're snapping to an anchor.
   */
  private calculateConnectorResize(
    original: Shape,
    handleType: HandleType,
    currentPoint: Vec2
  ): Partial<Shape> {
    if (!isConnector(original)) return {};

    // For connectors, 'left' handle moves start point, 'right' handle moves end point
    // Connection clearing/setting is handled in handleResizingMove based on anchor snapping
    if (handleType === 'left') {
      const updates: Partial<Shape> = {
        x: currentPoint.x,
        y: currentPoint.y,
      };
      // Clear connection if not snapping to an anchor (will be set in handleResizingMove if snapping)
      if (!this.connectorHoveredAnchor) {
        (updates as { startShapeId?: string | null; startAnchor?: AnchorPosition | null }).startShapeId = null;
        (updates as { startShapeId?: string | null; startAnchor?: AnchorPosition | null }).startAnchor = null;
      }
      return updates;
    } else {
      const updates: Partial<Shape> = {
        x2: currentPoint.x,
        y2: currentPoint.y,
      };
      // Clear connection if not snapping to an anchor
      if (!this.connectorHoveredAnchor) {
        (updates as { endShapeId?: string | null; endAnchor?: AnchorPosition | null }).endShapeId = null;
        (updates as { endShapeId?: string | null; endAnchor?: AnchorPosition | null }).endAnchor = null;
      }
      return updates;
    }
  }

  /**
   * Calculate text resize (adjust width, font size scales with vertical resize).
   */
  private calculateTextResize(
    original: Shape,
    handleType: HandleType,
    currentPoint: Vec2,
    anchor: Vec2
  ): Partial<Shape> {
    if (!isText(original)) return {};

    // Transform current point to local space
    const toLocal = (p: Vec2): Vec2 => {
      const translated = Vec2.subtract(p, new Vec2(original.x, original.y));
      return translated.rotate(-original.rotation);
    };

    const localAnchor = toLocal(anchor);
    const localCurrent = toLocal(currentPoint);

    // Calculate new width based on horizontal handles
    let newWidth = original.width;
    let newCenterX = 0;

    const isHorizontal = ['left', 'right'].includes(handleType);
    const isCorner = ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(handleType);

    if (isHorizontal || isCorner) {
      newWidth = Math.abs(localCurrent.x - localAnchor.x);
      newCenterX = (localCurrent.x + localAnchor.x) / 2;
    }

    // Enforce minimum width
    const minWidth = 20;
    newWidth = Math.max(newWidth, minWidth);

    // Transform new center back to world space
    const worldCenter = new Vec2(newCenterX, 0).rotate(original.rotation);

    return {
      x: original.x + worldCenter.x,
      width: newWidth,
    };
  }

  /**
   * Calculate library shape resize (same logic as rectangle).
   */
  private calculateLibraryShapeResize(
    original: Shape,
    handleType: HandleType,
    currentPoint: Vec2,
    anchor: Vec2,
    maintainAspectRatio: boolean
  ): Partial<Shape> {
    if (!isLibraryShape(original)) return {};

    // Transform current point to local space (un-rotate around original center)
    const toLocal = (p: Vec2): Vec2 => {
      const translated = Vec2.subtract(p, new Vec2(original.x, original.y));
      return translated.rotate(-original.rotation);
    };

    const localAnchor = toLocal(anchor);
    const localCurrent = toLocal(currentPoint);

    // Calculate new dimensions based on handle type
    let newWidth = original.width;
    let newHeight = original.height;
    let newCenterX = 0;
    let newCenterY = 0;

    const isCorner = ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(handleType);
    const isHorizontal = ['left', 'right'].includes(handleType);
    const isVertical = ['top', 'bottom'].includes(handleType);

    if (isCorner) {
      // Corner resize: both dimensions change
      newWidth = Math.abs(localCurrent.x - localAnchor.x);
      newHeight = Math.abs(localCurrent.y - localAnchor.y);
      newCenterX = (localCurrent.x + localAnchor.x) / 2;
      newCenterY = (localCurrent.y + localAnchor.y) / 2;

      if (maintainAspectRatio && original.width > 0 && original.height > 0) {
        const aspectRatio = original.width / original.height;
        const currentRatio = newWidth / newHeight;

        if (currentRatio > aspectRatio) {
          newWidth = newHeight * aspectRatio;
        } else {
          newHeight = newWidth / aspectRatio;
        }

        // Adjust center based on which corner
        if (handleType === 'top-left') {
          newCenterX = localAnchor.x - newWidth / 2;
          newCenterY = localAnchor.y - newHeight / 2;
        } else if (handleType === 'top-right') {
          newCenterX = localAnchor.x + newWidth / 2;
          newCenterY = localAnchor.y - newHeight / 2;
        } else if (handleType === 'bottom-left') {
          newCenterX = localAnchor.x - newWidth / 2;
          newCenterY = localAnchor.y + newHeight / 2;
        } else {
          newCenterX = localAnchor.x + newWidth / 2;
          newCenterY = localAnchor.y + newHeight / 2;
        }
      }
    } else if (isHorizontal) {
      // Horizontal resize: only width changes
      newWidth = Math.abs(localCurrent.x - localAnchor.x);
      newCenterX = (localCurrent.x + localAnchor.x) / 2;
      newCenterY = 0;

      if (maintainAspectRatio && original.width > 0) {
        const aspectRatio = original.width / original.height;
        newHeight = newWidth / aspectRatio;
      }
    } else if (isVertical) {
      // Vertical resize: only height changes
      newHeight = Math.abs(localCurrent.y - localAnchor.y);
      newCenterX = 0;
      newCenterY = (localCurrent.y + localAnchor.y) / 2;

      if (maintainAspectRatio && original.height > 0) {
        const aspectRatio = original.width / original.height;
        newWidth = newHeight * aspectRatio;
      }
    }

    // Enforce minimum size
    const minSize = 10;
    newWidth = Math.max(newWidth, minSize);
    newHeight = Math.max(newHeight, minSize);

    // Transform new center back to world space
    const worldCenter = new Vec2(newCenterX, newCenterY).rotate(original.rotation);

    return {
      x: original.x + worldCenter.x,
      y: original.y + worldCenter.y,
      width: newWidth,
      height: newHeight,
    };
  }
}
