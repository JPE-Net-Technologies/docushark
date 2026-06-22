import { BaseTool, ToolContext } from './Tool';
import { NormalizedPointerEvent } from '../InputHandler';
import { Vec2 } from '../../math/Vec2';
import { ToolType } from '../../store/sessionStore';
import { ConnectorShape, DEFAULT_CONNECTOR, Anchor, AnchorPosition, isConnector, isGroup } from '../../shapes/Shape';
import { shapeRegistry } from '../../shapes/ShapeRegistry';
import { nanoid } from 'nanoid';
import { calculateConnectorWaypoints } from '../OrthogonalRouter';
import { useSettingsStore } from '../../store/settingsStore';

/**
 * State machine states for the ConnectorTool.
 */
type ConnectorState = 'idle' | 'drawing';

/**
 * Distance threshold for snapping to anchors (in screen pixels).
 */
const ANCHOR_SNAP_DISTANCE = 15;

/**
 * Connector tool for creating connectors between shapes.
 *
 * Features:
 * - Shows anchor points when hovering over shapes
 * - Click on anchor to start drawing a connector
 * - Drag to another anchor to connect shapes
 * - Click on empty space for floating endpoints
 */
export class ConnectorTool extends BaseTool {
  readonly type: ToolType = 'connector';
  readonly name = 'Connector';
  readonly shortcut = 'c';

  private state: ConnectorState = 'idle';

  // Start point of the connector being drawn
  private startPoint: Vec2 | null = null;
  private startShapeId: string | null = null;
  private startAnchor: AnchorPosition = 'center';

  // Current end point (during drawing)
  private endPoint: Vec2 | null = null;
  private hoveredShapeId: string | null = null;
  private hoveredAnchor: Anchor | null = null;

  onActivate(ctx: ToolContext): void {
    ctx.setCursor('crosshair');
  }

  onDeactivate(ctx: ToolContext): void {
    this.resetState();
    ctx.setCursor('default');
    ctx.setIsInteracting(false);
  }

  onPointerDown(event: NormalizedPointerEvent, ctx: ToolContext): void {
    if (event.button !== 'left') return;

    if (this.state === 'idle') {
      // Start drawing a connector
      this.startDrawing(event.worldPoint, ctx);
    }
  }

  onPointerMove(event: NormalizedPointerEvent, ctx: ToolContext): void {
    if (this.state === 'drawing') {
      // Update end point
      this.endPoint = event.worldPoint;

      // Find hovered anchor
      const anchorResult = this.findNearestAnchor(event.worldPoint, event.screenPoint, ctx);
      if (anchorResult) {
        this.hoveredShapeId = anchorResult.shapeId;
        this.hoveredAnchor = anchorResult.anchor;
        this.endPoint = new Vec2(anchorResult.anchor.x, anchorResult.anchor.y);
      } else {
        this.hoveredShapeId = null;
        this.hoveredAnchor = null;
      }

      ctx.requestRender();
    } else {
      // In idle mode, show anchor highlights on hover
      const anchorResult = this.findNearestAnchor(event.worldPoint, event.screenPoint, ctx);
      const prevHovered = this.hoveredAnchor;

      if (anchorResult) {
        this.hoveredShapeId = anchorResult.shapeId;
        this.hoveredAnchor = anchorResult.anchor;
      } else {
        this.hoveredShapeId = null;
        this.hoveredAnchor = null;
      }

      // Only re-render if hover state changed
      if (prevHovered !== this.hoveredAnchor) {
        ctx.requestRender();
      }
    }
  }

  onPointerUp(event: NormalizedPointerEvent, ctx: ToolContext): void {
    if (event.button !== 'left') return;

    if (this.state === 'drawing') {
      this.finishDrawing(event.worldPoint, ctx);
    }
  }

  onKeyDown(event: KeyboardEvent, ctx: ToolContext): boolean {
    // Escape to cancel drawing
    if (event.key === 'Escape' && this.state === 'drawing') {
      this.resetState();
      ctx.setIsInteracting(false);
      ctx.requestRender();
      return true;
    }
    return false;
  }

  renderOverlay(ctx2d: CanvasRenderingContext2D, toolCtx: ToolContext): void {
    const camera = toolCtx.camera;

    // Draw anchor points on shapes
    this.drawAnchorPoints(ctx2d, toolCtx);

    // Draw the connector being created
    if (this.state === 'drawing' && this.startPoint && this.endPoint) {
      const startScreen = camera.worldToScreen(this.startPoint);
      const endScreen = camera.worldToScreen(this.endPoint);

      ctx2d.save();

      // Draw line
      ctx2d.strokeStyle = '#2196f3';
      ctx2d.lineWidth = 2;
      ctx2d.setLineDash([5, 5]);
      ctx2d.beginPath();
      ctx2d.moveTo(startScreen.x, startScreen.y);
      ctx2d.lineTo(endScreen.x, endScreen.y);
      ctx2d.stroke();

      // Draw end point indicator
      ctx2d.fillStyle = this.hoveredAnchor ? '#2196f3' : '#ffffff';
      ctx2d.strokeStyle = '#2196f3';
      ctx2d.lineWidth = 2;
      ctx2d.setLineDash([]);
      ctx2d.beginPath();
      ctx2d.arc(endScreen.x, endScreen.y, 6, 0, Math.PI * 2);
      ctx2d.fill();
      ctx2d.stroke();

      ctx2d.restore();
    }
  }

  private startDrawing(worldPoint: Vec2, ctx: ToolContext): void {
    // Find if we're clicking on an anchor
    const shapes = ctx.getShapes();
    let bestAnchor: { shapeId: string; anchor: Anchor } | null = null;
    let bestDistance = ANCHOR_SNAP_DISTANCE / ctx.camera.zoom;

    for (const shapeId of ctx.getShapeOrder()) {
      const shape = shapes[shapeId];
      if (!shape || isConnector(shape)) continue;

      const handler = shapeRegistry.getHandler(shape.type);
      if (!handler.getAnchors) continue;

      const anchors = handler.getAnchors(shape);
      for (const anchor of anchors) {
        const distance = Vec2.distance(new Vec2(anchor.x, anchor.y), worldPoint);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestAnchor = { shapeId, anchor };
        }
      }
    }

    if (bestAnchor) {
      this.startShapeId = bestAnchor.shapeId;
      this.startAnchor = bestAnchor.anchor.position;
      this.startPoint = new Vec2(bestAnchor.anchor.x, bestAnchor.anchor.y);
    } else {
      this.startShapeId = null;
      this.startAnchor = 'center';
      this.startPoint = worldPoint;
    }

    this.endPoint = worldPoint;
    this.state = 'drawing';
    ctx.setIsInteracting(true);
    ctx.requestRender();
  }

  private finishDrawing(worldPoint: Vec2, ctx: ToolContext): void {
    if (!this.startPoint) {
      this.resetState();
      return;
    }

    // Check minimum distance
    const distance = Vec2.distance(this.startPoint, this.endPoint || worldPoint);
    if (distance < 10) {
      this.resetState();
      ctx.setIsInteracting(false);
      ctx.requestRender();
      return;
    }

    // Apply the last-used connector style (routing + semantic type + ERD
    // cardinality). This is remembered memory, updated by the toolbar connector
    // dropdown — there is no configured default.
    const lastConnector = useSettingsStore.getState().lastConnector;

    // Create the connector
    const connector: ConnectorShape = {
      id: nanoid(),
      type: 'connector',
      x: this.startPoint.x,
      y: this.startPoint.y,
      x2: this.endPoint ? this.endPoint.x : worldPoint.x,
      y2: this.endPoint ? this.endPoint.y : worldPoint.y,
      rotation: 0,
      opacity: DEFAULT_CONNECTOR.opacity,
      locked: false,
      visible: true,
      fill: DEFAULT_CONNECTOR.fill,
      stroke: DEFAULT_CONNECTOR.stroke,
      strokeWidth: DEFAULT_CONNECTOR.strokeWidth,
      startShapeId: this.startShapeId,
      startAnchor: this.startAnchor,
      endShapeId: this.hoveredShapeId,
      endAnchor: this.hoveredAnchor?.position || 'center',
      startArrow: DEFAULT_CONNECTOR.startArrow,
      endArrow: DEFAULT_CONNECTOR.endArrow,
      routingMode: lastConnector.routingMode,
      connectorType: lastConnector.connectorType,
      startCardinality: lastConnector.startCardinality,
      endCardinality: lastConnector.endCardinality,
    };

    // Calculate initial waypoints for orthogonal routing
    if (connector.routingMode === 'orthogonal') {
      const shapes = ctx.getShapes();
      connector.waypoints = calculateConnectorWaypoints(connector, shapes) ?? [];
    }

    ctx.pushHistory('Create connector');
    ctx.addShape(connector);
    ctx.select([connector.id]);

    this.resetState();
    ctx.setIsInteracting(false);
    ctx.requestRender();
  }

  private findNearestAnchor(
    _worldPoint: Vec2,
    screenPoint: Vec2,
    ctx: ToolContext
  ): { shapeId: string; anchor: Anchor } | null {
    const shapes = ctx.getShapes();
    let bestResult: { shapeId: string; anchor: Anchor } | null = null;
    let bestDistance = ANCHOR_SNAP_DISTANCE;

    // Helper to recursively find anchors, including inside groups
    const findAnchorsInShape = (shapeId: string) => {
      // Don't connect to the shape we're starting from (for end point)
      if (this.state === 'drawing' && shapeId === this.startShapeId) return;

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

  private drawAnchorPoints(ctx2d: CanvasRenderingContext2D, toolCtx: ToolContext): void {
    const camera = toolCtx.camera;
    const shapes = toolCtx.getShapes();

    ctx2d.save();

    // Helper to recursively draw anchors, including inside groups
    const drawAnchorsForShape = (shapeId: string) => {
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
          this.hoveredShapeId === shapeId &&
          this.hoveredAnchor?.position === anchor.position;

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

  private resetState(): void {
    this.state = 'idle';
    this.startPoint = null;
    this.startShapeId = null;
    this.startAnchor = 'center';
    this.endPoint = null;
    this.hoveredShapeId = null;
    this.hoveredAnchor = null;
  }
}
