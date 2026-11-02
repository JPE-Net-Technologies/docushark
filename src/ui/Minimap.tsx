/**
 * Minimap (DSK-212): an overview of the canvas page with the visible area
 * marked, for getting around a large diagram.
 *
 * Drag the viewport box to pan, or press elsewhere to glide there (and keep
 * dragging from there). The wheel over the map zooms the canvas around that
 * point, and the arrow keys pan while the map has focus.
 *
 * The map keeps a steady frame (`nextMapWorld`): it changes only when the view
 * or the content leaves it, never while you drag, so nothing moves under the
 * pointer. The camera's x and y are the screen's centre (`minimapGeometry`).
 * Shown from the zoom pill's map button, or Settings → Canvas.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useDocumentStore } from '../store/documentStore';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { shapeRegistry } from '../shapes/ShapeRegistry';
import { resolveConnectorPoints } from '../shapes/Connector';
import type { ConnectorShape, LineShape, Shape } from '../shapes/Shape';
import { Vec2 } from '../math/Vec2';
import { MAX_ZOOM, MIN_ZOOM } from '../engine/Camera';
import { glideCamera } from '../engine/canvasZoom';
import {
  contains,
  fitFrame,
  mapToWorld,
  nextMapWorld,
  viewportRect,
  worldToMap,
  zoomAround,
  type MapFrame,
  type Point,
  type Rect,
} from './minimapGeometry';
import './Minimap.css';

interface MinimapProps {
  /** Canvas width in pixels */
  canvasWidth: number;
  /** Canvas height in pixels */
  canvasHeight: number;
}

export const MAP_WIDTH = 180;
export const MAP_HEIGHT = 120;
/** Arrow keys pan this share of the visible area. */
const KEY_PAN_RATIO = 0.1;
const WHEEL_ZOOM_STEP = 1.15;

function boundsOf(shape: Shape): Rect | null {
  try {
    const box = shapeRegistry.getHandler(shape.type).getBounds(shape);
    return { minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY };
  } catch {
    return null; // an unregistered shape type
  }
}

/** The visible shapes' world bounds, in one pass. */
function contentBounds(shapes: Record<string, Shape>, order: readonly string[]): Rect | null {
  let area: Rect | null = null;
  for (const id of order) {
    const shape = shapes[id];
    if (!shape || shape.visible === false) continue;
    const box = boundsOf(shape);
    if (!box) continue;
    area = area
      ? {
          minX: Math.min(area.minX, box.minX),
          minY: Math.min(area.minY, box.minY),
          maxX: Math.max(area.maxX, box.maxX),
          maxY: Math.max(area.maxY, box.maxY),
        }
      : box;
  }
  return area;
}

interface Palette {
  shape: string;
  faint: string;
  accent: string;
}

/** Theme colours, read from the tokens: CSS variables don't resolve inside a canvas. */
function readPalette(): Palette {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    shape: token('--text-muted', '#6a7a93'),
    faint: token('--text-faint', '#8d9bb1'),
    accent: token('--color-primary', '#3b82f6'),
  };
}

/** A visible fill colour, or null for none. */
function fillOf(shape: Shape): string | null {
  const fill = 'fill' in shape ? (shape as { fill?: string }).fill : undefined;
  return fill && fill !== 'transparent' && fill !== 'none' ? fill : null;
}

/** A line's ends, turned about its midpoint as the canvas draws it. */
function lineEnds(line: LineShape): Point[] {
  const centre = new Vec2((line.x + line.x2) / 2, (line.y + line.y2) / 2);
  return [new Vec2(line.x, line.y), new Vec2(line.x2, line.y2)].map((end) => end.rotateAround(centre, line.rotation));
}

/**
 * Draw one shape as a silhouette of its kind, at least a pixel across so
 * nothing vanishes from the map. Lines and connectors follow the paths the
 * canvas draws; groups are outlines, and their members draw themselves.
 */
function drawShape(ctx: CanvasRenderingContext2D, shape: Shape, frame: MapFrame, palette: Palette, selected: boolean) {
  const box = boundsOf(shape);
  if (!box) return;
  const topLeft = worldToMap(frame, { x: box.minX, y: box.minY });
  const width = (box.maxX - box.minX) * frame.scale;
  const height = (box.maxY - box.minY) * frame.scale;

  if (shape.type === 'line' || shape.type === 'connector') {
    const points =
      shape.type === 'connector' ? resolveConnectorPoints(shape as ConnectorShape) : lineEnds(shape as LineShape);
    ctx.strokeStyle = selected ? palette.accent : palette.shape;
    ctx.lineWidth = 1;
    ctx.beginPath();
    points.forEach((point, i) => {
      const p = worldToMap(frame, point);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
    return;
  }
  if (shape.type === 'group') {
    ctx.strokeStyle = selected ? palette.accent : palette.faint;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.strokeRect(topLeft.x, topLeft.y, width, height);
    ctx.setLineDash([]);
    return;
  }
  if (shape.type === 'text') {
    ctx.fillStyle = selected ? palette.accent : palette.faint;
    ctx.fillRect(topLeft.x, topLeft.y + height * 0.35, Math.max(width, 1), Math.max(height * 0.3, 1));
    return;
  }

  ctx.fillStyle = fillOf(shape) ?? palette.shape;
  ctx.beginPath();
  if (shape.type === 'ellipse') {
    ctx.ellipse(topLeft.x + width / 2, topLeft.y + height / 2, Math.max(width / 2, 0.5), Math.max(height / 2, 0.5), 0, 0, Math.PI * 2);
  } else {
    ctx.rect(topLeft.x, topLeft.y, Math.max(width, 1), Math.max(height, 1));
  }
  ctx.fill();
  if (selected) {
    ctx.strokeStyle = palette.accent;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

const pointRect = (point: Point): Rect => ({ minX: point.x, minY: point.y, maxX: point.x, maxY: point.y });

/** The shapes, drawn once and reused while nothing they're drawn from changes. */
interface ShapeLayer {
  canvas: HTMLCanvasElement;
  key: readonly unknown[];
}

const sameKey = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && a.every((part, i) => part === b[i]);

/** Off by default; while off, nothing here follows the camera or the shapes. */
export function Minimap(props: MinimapProps) {
  const showMinimap = useSettingsStore((state) => state.showMinimap);
  return showMinimap ? <MinimapView {...props} /> : null;
}

function MinimapView({ canvasWidth, canvasHeight }: MinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shapes = useDocumentStore((state) => state.shapes);
  const shapeOrder = useDocumentStore((state) => state.shapeOrder);
  const selectedIds = useSessionStore((state) => state.selectedIds);
  const camera = useSessionStore((state) => state.camera);
  const content = useMemo(() => contentBounds(shapes, shapeOrder), [shapes, shapeOrder]);

  // The world area the map shows. Held in a ref so a drag can freeze it; bumped
  // into state only to redraw.
  const worldRef = useRef<Rect | null>(null);
  const dragRef = useRef<{ dx: number; dy: number; frame: MapFrame; end: () => void } | null>(null);
  const layerRef = useRef<ShapeLayer | null>(null);
  const [, setRedraws] = useState(0);

  const viewport = viewportRect(camera, canvasWidth, canvasHeight);
  // Held while the box is dragged, so nothing moves under the pointer.
  const world = dragRef.current && worldRef.current ? worldRef.current : nextMapWorld(worldRef.current, content, viewport);
  worldRef.current = world;
  const frame = fitFrame(world, MAP_WIDTH, MAP_HEIGHT);

  // Draw on every change, as it's committed. The shapes come from a layer that's
  // redrawn only when they, the selection, the frame or the theme change, so a
  // pan costs one copy and the viewport box. (Deferring the draw to an animation
  // frame starved it: each change in a glide or a drag cancelled the frame
  // before it ran, freezing the map until the view stopped moving.)
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const width = MAP_WIDTH * dpr;
    const height = MAP_HEIGHT * dpr;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const palette = readPalette();
    const key = [shapes, shapeOrder, selectedIds, frame.scale, frame.offsetX, frame.offsetY, dpr, palette.shape, palette.faint, palette.accent];
    let layer = layerRef.current;
    if (!layer || !sameKey(layer.key, key)) {
      const layerCanvas = layer?.canvas ?? document.createElement('canvas');
      layerCanvas.width = width; // (setting the size clears it)
      layerCanvas.height = height;
      const layerCtx = layerCanvas.getContext('2d');
      if (!layerCtx) return;
      layerCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const id of shapeOrder) {
        const shape = shapes[id];
        if (shape && shape.visible !== false) drawShape(layerCtx, shape, frame, palette, selectedIds.has(id));
      }
      layer = { canvas: layerCanvas, key };
      layerRef.current = layer;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(layer.canvas, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const corner = worldToMap(frame, { x: viewport.minX, y: viewport.minY });
    const boxWidth = (viewport.maxX - viewport.minX) * frame.scale;
    const boxHeight = (viewport.maxY - viewport.minY) * frame.scale;
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = palette.accent;
    ctx.fillRect(corner.x, corner.y, boxWidth, boxHeight);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = palette.accent;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(corner.x, corner.y, boxWidth, boxHeight);
  });

  const toMap = useCallback((clientX: number, clientY: number): Point => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  }, []);

  const endDrag = useCallback(() => {
    dragRef.current?.end();
    dragRef.current = null;
    // The box followed the pointer, so it's under the pointer still.
    if (canvasRef.current) canvasRef.current.style.cursor = 'grab';
    setRedraws((n) => n + 1); // let the frame settle again
  }, []);

  // Pressing inside the box grabs it. Pressing elsewhere glides the view there,
  // and a drag carries on from there (the glide gives way to it). A drag ends
  // wherever the pointer is released, or if the window loses focus.
  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const world = mapToWorld(frame, toMap(e.clientX, e.clientY));
    const inside = contains(viewport, pointRect(world));
    if (!inside) glideCamera({ x: world.x, y: world.y });
    const { camera: start } = useSessionStore.getState();
    e.currentTarget.style.cursor = 'grabbing';
    const onMove = (move: globalThis.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const at = mapToWorld(drag.frame, toMap(move.clientX, move.clientY));
      useSessionStore.getState().setCamera({ x: at.x + drag.dx, y: at.y + drag.dy });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    window.addEventListener('blur', endDrag);
    dragRef.current = {
      dx: inside ? start.x - world.x : 0,
      dy: inside ? start.y - world.y : 0,
      frame,
      end: () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', endDrag);
        window.removeEventListener('pointercancel', endDrag);
        window.removeEventListener('blur', endDrag);
      },
    };
  };

  // The box looks grabbable under the pointer.
  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current) return;
    const world = mapToWorld(frame, toMap(e.clientX, e.clientY));
    e.currentTarget.style.cursor = contains(viewport, pointRect(world)) ? 'grab' : '';
  };

  // A drag in progress when the map goes away still lets go of the window.
  useEffect(() => () => dragRef.current?.end(), []);

  // The wheel zooms the canvas around the point under the pointer. A native,
  // non-passive listener so the page doesn't scroll too.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const shown = worldRef.current;
      if (!shown) return;
      const { camera: current, setCamera } = useSessionStore.getState();
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current.zoom * (e.deltaY < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP)));
      const rect = canvas.getBoundingClientRect();
      const fitted = fitFrame(shown, MAP_WIDTH, MAP_HEIGHT);
      setCamera(zoomAround(current, mapToWorld(fitted, { x: e.clientX - rect.left, y: e.clientY - rect.top }), zoom));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLCanvasElement>) => {
    const stepX = (viewport.maxX - viewport.minX) * KEY_PAN_RATIO;
    const stepY = (viewport.maxY - viewport.minY) * KEY_PAN_RATIO;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-stepX, 0],
      ArrowRight: [stepX, 0],
      ArrowUp: [0, -stepY],
      ArrowDown: [0, stepY],
    };
    const delta = moves[e.key];
    if (!delta) return;
    e.preventDefault();
    useSessionStore.getState().setCamera({ x: camera.x + delta[0], y: camera.y + delta[1] });
  };

  return (
    <div className="minimap-container">
      <canvas
        ref={canvasRef}
        className="minimap-canvas"
        style={{ width: MAP_WIDTH, height: MAP_HEIGHT }}
        tabIndex={0}
        role="application"
        aria-label="Minimap. Drag the box to pan, click to go there, arrow keys pan."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
