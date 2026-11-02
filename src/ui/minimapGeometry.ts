/**
 * Geometry for the minimap (DSK-212), kept pure so it can be tested on its own.
 *
 * World rectangles are in canvas coordinates. The camera's x and y are the
 * centre of the screen (`engine/Camera.ts`), so the viewport reaches half the
 * visible width and height either side of them. The map draws a world area
 * into a fixed-size box with one scale for both axes, centred.
 */

export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Map coordinates are `world * scale + offset`. */
export interface MapFrame {
  scale: number;
  offsetX: number;
  offsetY: number;
}

interface CameraLike {
  x: number;
  y: number;
  zoom: number;
}

/** The world area on screen. */
export function viewportRect(camera: CameraLike, screenWidth: number, screenHeight: number): Rect {
  const halfWidth = screenWidth / camera.zoom / 2;
  const halfHeight = screenHeight / camera.zoom / 2;
  return {
    minX: camera.x - halfWidth,
    minY: camera.y - halfHeight,
    maxX: camera.x + halfWidth,
    maxY: camera.y + halfHeight,
  };
}

export function union(a: Rect, b: Rect): Rect {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

export function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.minX >= outer.minX && inner.minY >= outer.minY && inner.maxX <= outer.maxX && inner.maxY <= outer.maxY
  );
}

/** The world area the map shows: the content and the viewport, with a margin around both. */
export function mapWorld(content: Rect | null, viewport: Rect, marginRatio = 0.1): Rect {
  const area = content ? union(content, viewport) : viewport;
  const margin = Math.max(area.maxX - area.minX, area.maxY - area.minY) * marginRatio;
  return { minX: area.minX - margin, minY: area.minY - margin, maxX: area.maxX + margin, maxY: area.maxY + margin };
}

/**
 * The map's next world area, kept steady: it changes only when the viewport or
 * the content leaves it, never on every pan. (While the viewport box is being
 * dragged, the caller keeps the frame it started with.)
 */
export function nextMapWorld(previous: Rect | null, content: Rect | null, viewport: Rect): Rect {
  if (previous && contains(previous, viewport) && (!content || contains(previous, content))) return previous;
  return mapWorld(content, viewport);
}

/** The frame that fits `world` into a `width` × `height` map, centred. */
export function fitFrame(world: Rect, width: number, height: number): MapFrame {
  const worldWidth = Math.max(world.maxX - world.minX, Number.EPSILON);
  const worldHeight = Math.max(world.maxY - world.minY, Number.EPSILON);
  const scale = Math.min(width / worldWidth, height / worldHeight);
  return {
    scale,
    offsetX: (width - worldWidth * scale) / 2 - world.minX * scale,
    offsetY: (height - worldHeight * scale) / 2 - world.minY * scale,
  };
}

export function worldToMap(frame: MapFrame, point: Point): Point {
  return { x: point.x * frame.scale + frame.offsetX, y: point.y * frame.scale + frame.offsetY };
}

export function mapToWorld(frame: MapFrame, point: Point): Point {
  return { x: (point.x - frame.offsetX) / frame.scale, y: (point.y - frame.offsetY) / frame.scale };
}

/** The camera after zooming to `zoom` around `point`, which stays where it is on screen. */
export function zoomAround(camera: CameraLike, point: Point, zoom: number): CameraLike {
  const ratio = camera.zoom / zoom;
  return {
    x: point.x + (camera.x - point.x) * ratio,
    y: point.y + (camera.y - point.y) * ratio,
    zoom,
  };
}
