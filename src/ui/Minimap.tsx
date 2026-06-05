/**
 * Minimap component for navigating large canvases.
 *
 * Displays a scaled-down overview of all shapes with a viewport indicator.
 * Clicking/dragging on the minimap pans the main canvas.
 */

import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { useDocumentStore } from '../store/documentStore';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { shapeRegistry } from '../shapes/ShapeRegistry';
import { Box } from '../math/Box';
import { Shape, isGroup } from '../shapes/Shape';
import './Minimap.css';

interface MinimapProps {
  /** Canvas width in pixels */
  canvasWidth: number;
  /** Canvas height in pixels */
  canvasHeight: number;
}

/** Minimap dimensions */
const MINIMAP_WIDTH = 180;
const MINIMAP_HEIGHT = 120;
const MINIMAP_PADDING = 10;

/**
 * Calculate the bounding box of all shapes.
 */
function getAllShapesBounds(
  shapes: Record<string, Shape>,
  shapeOrder: string[]
): Box | null {
  let bounds: Box | null = null;

  for (const id of shapeOrder) {
    const shape = shapes[id];
    if (!shape || shape.visible === false) continue;

    // Skip children of groups (they're rendered within their group)
    const parentGroup = Object.values(shapes).find(
      (s) => isGroup(s) && s.childIds.includes(id)
    );
    if (parentGroup) continue;

    try {
      const handler = shapeRegistry.getHandler(shape.type);
      const shapeBounds = handler.getBounds(shape);

      if (!bounds) {
        bounds = shapeBounds;
      } else {
        bounds = bounds.union(shapeBounds);
      }
    } catch {
      // Skip unregistered shape types
    }
  }

  return bounds;
}

export function Minimap({ canvasWidth, canvasHeight }: MinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const shapes = useDocumentStore((state) => state.shapes);
  const shapeOrder = useDocumentStore((state) => state.shapeOrder);
  const camera = useSessionStore((state) => state.camera);
  const setCamera = useSessionStore((state) => state.setCamera);
  const showMinimap = useSettingsStore((state) => state.showMinimap);

  // Calculate world bounds of all shapes
  const worldBounds = useMemo(() => {
    return getAllShapesBounds(shapes, shapeOrder);
  }, [shapes, shapeOrder]);

  // Calculate the visible area in world coordinates
  const viewportBounds = useMemo(() => {
    const worldWidth = canvasWidth / camera.zoom;
    const worldHeight = canvasHeight / camera.zoom;
    return new Box(camera.x, camera.y, camera.x + worldWidth, camera.y + worldHeight);
  }, [camera, canvasWidth, canvasHeight]);

  // Calculate minimap scale and offsets
  const minimapTransform = useMemo(() => {
    if (!worldBounds) {
      // No shapes - center on viewport
      return {
        scale: 0.1,
        offsetX: MINIMAP_WIDTH / 2,
        offsetY: MINIMAP_HEIGHT / 2,
        worldBounds: viewportBounds,
      };
    }

    // Expand world bounds to include viewport
    const totalBounds = worldBounds.union(viewportBounds);

    // Add padding to the bounds
    const paddedBounds = totalBounds.expand(Math.max(totalBounds.width, totalBounds.height) * 0.1);

    // Calculate scale to fit in minimap
    const scaleX = (MINIMAP_WIDTH - MINIMAP_PADDING * 2) / paddedBounds.width;
    const scaleY = (MINIMAP_HEIGHT - MINIMAP_PADDING * 2) / paddedBounds.height;
    const scale = Math.min(scaleX, scaleY);

    // Calculate offsets to center the content
    const contentWidth = paddedBounds.width * scale;
    const contentHeight = paddedBounds.height * scale;
    const offsetX = (MINIMAP_WIDTH - contentWidth) / 2 - paddedBounds.minX * scale;
    const offsetY = (MINIMAP_HEIGHT - contentHeight) / 2 - paddedBounds.minY * scale;

    return {
      scale,
      offsetX,
      offsetY,
      worldBounds: paddedBounds,
    };
  }, [worldBounds, viewportBounds]);

  // Convert minimap coordinates to world coordinates
  const minimapToWorld = useCallback(
    (minimapX: number, minimapY: number) => {
      const { scale, offsetX, offsetY } = minimapTransform;
      const worldX = (minimapX - offsetX) / scale;
      const worldY = (minimapY - offsetY) / scale;
      return { x: worldX, y: worldY };
    },
    [minimapTransform]
  );

  // Handle click/drag on minimap to pan camera
  const handlePan = useCallback(
    (e: React.MouseEvent | MouseEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const minimapX = e.clientX - rect.left;
      const minimapY = e.clientY - rect.top;

      const worldPos = minimapToWorld(minimapX, minimapY);

      // Center the viewport on the clicked position
      const worldWidth = canvasWidth / camera.zoom;
      const worldHeight = canvasHeight / camera.zoom;

      setCamera({
        x: worldPos.x - worldWidth / 2,
        y: worldPos.y - worldHeight / 2,
      });
    },
    [minimapToWorld, camera.zoom, canvasWidth, canvasHeight, setCamera]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);
      handlePan(e);
    },
    [handlePan]
  );

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (isDragging) {
        handlePan(e);
      }
    },
    [isDragging, handlePan]
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Add global mouse event listeners for dragging
  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
    return undefined;
  }, [isDragging, handleMouseMove, handleMouseUp]);

  // Render minimap
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = MINIMAP_WIDTH * dpr;
    canvas.height = MINIMAP_HEIGHT * dpr;
    ctx.scale(dpr, dpr);

    // Clear canvas. CSS variables don't resolve in a canvas context, so read
    // the brand surface token off the document element (fall back to the brand
    // light surface literal).
    ctx.fillStyle =
      getComputedStyle(document.documentElement)
        .getPropertyValue('--bg-primary')
        .trim() || '#f9f6ee';
    ctx.fillRect(0, 0, MINIMAP_WIDTH, MINIMAP_HEIGHT);

    const { scale, offsetX, offsetY } = minimapTransform;

    // Draw shapes as simple colored rectangles
    ctx.save();

    for (const id of shapeOrder) {
      const shape = shapes[id];
      if (!shape || shape.visible === false) continue;

      // Skip children of groups
      const parentGroup = Object.values(shapes).find(
        (s) => isGroup(s) && s.childIds.includes(id)
      );
      if (parentGroup) continue;

      try {
        const handler = shapeRegistry.getHandler(shape.type);
        const bounds = handler.getBounds(shape);

        // Transform to minimap coordinates
        const x = bounds.minX * scale + offsetX;
        const y = bounds.minY * scale + offsetY;
        const w = bounds.width * scale;
        const h = bounds.height * scale;

        // Skip shapes smaller than 1 pixel
        if (w < 1 && h < 1) continue;

        // Draw shape as a simple rectangle
        const fill = 'fill' in shape ? (shape as { fill: string }).fill : '#94a3b8';
        ctx.fillStyle = fill || '#94a3b8';
        ctx.fillRect(x, y, Math.max(w, 1), Math.max(h, 1));

        const stroke = 'stroke' in shape ? (shape as { stroke: string }).stroke : null;
        if (stroke && w > 2 && h > 2) {
          ctx.strokeStyle = stroke;
          ctx.lineWidth = 0.5;
          ctx.strokeRect(x, y, w, h);
        }
      } catch {
        // Skip unregistered shape types
      }
    }

    ctx.restore();

    // Draw viewport indicator
    const vpX = viewportBounds.minX * scale + offsetX;
    const vpY = viewportBounds.minY * scale + offsetY;
    const vpW = viewportBounds.width * scale;
    const vpH = viewportBounds.height * scale;

    ctx.strokeStyle = 'rgba(59, 130, 246, 0.8)';
    ctx.lineWidth = 2;
    ctx.strokeRect(vpX, vpY, vpW, vpH);

    ctx.fillStyle = 'rgba(59, 130, 246, 0.1)';
    ctx.fillRect(vpX, vpY, vpW, vpH);
  }, [shapes, shapeOrder, minimapTransform, viewportBounds]);

  if (!showMinimap) return null;

  return (
    <div ref={containerRef} className="minimap-container">
      <canvas
        ref={canvasRef}
        className="minimap-canvas"
        style={{ width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT }}
        onMouseDown={handleMouseDown}
      />
    </div>
  );
}
