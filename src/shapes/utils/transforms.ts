import { Vec2 } from '../../math/Vec2';
import {
  Shape,
  isRectangle,
  isEllipse,
  isLine,
  isText,
} from '../Shape';

/**
 * Translate a shape by a delta vector, returning a new shape: its position and,
 * on lines and connectors, the second endpoint (`x2`, `y2`) and any waypoints,
 * which are absolute too. Moving only `x` and `y` would stretch them.
 *
 * @param shape - The shape to translate
 * @param delta - Translation vector
 * @returns New shape with updated position
 */
export function translateShape<T extends Shape>(shape: T, delta: Vec2): T {
  const moved = { ...shape, x: shape.x + delta.x, y: shape.y + delta.y } as T & EndpointGeometry;
  const geometry = shape as T & EndpointGeometry;
  if (typeof geometry.x2 === 'number') moved.x2 = geometry.x2 + delta.x;
  if (typeof geometry.y2 === 'number') moved.y2 = geometry.y2 + delta.y;
  if (geometry.waypoints) {
    moved.waypoints = geometry.waypoints.map((point) => ({ x: point.x + delta.x, y: point.y + delta.y }));
  }
  return moved;
}

/** The absolute geometry lines and connectors carry beyond `x` and `y`. */
interface EndpointGeometry {
  x2?: number;
  y2?: number;
  waypoints?: Array<{ x: number; y: number }>;
}

/**
 * Translate multiple shapes by a delta vector.
 *
 * @param shapes - Array of shapes to translate
 * @param delta - Translation vector
 * @returns Array of new shapes with updated positions
 */
export function translateShapes<T extends Shape>(shapes: T[], delta: Vec2): T[] {
  return shapes.map((shape) => translateShape(shape, delta));
}

/**
 * Set a shape's rotation angle.
 * Returns a new shape with updated rotation.
 *
 * @param shape - The shape to rotate
 * @param rotation - New rotation angle in radians
 * @returns New shape with updated rotation
 */
export function rotateShape<T extends Shape>(shape: T, rotation: number): T {
  return {
    ...shape,
    rotation,
  };
}

/**
 * Add to a shape's rotation angle.
 * Returns a new shape with updated rotation.
 *
 * @param shape - The shape to rotate
 * @param deltaRotation - Rotation delta in radians
 * @returns New shape with updated rotation
 */
export function rotateShapeBy<T extends Shape>(shape: T, deltaRotation: number): T {
  return {
    ...shape,
    rotation: shape.rotation + deltaRotation,
  };
}

/**
 * Rotate a shape around a pivot point.
 * Updates both position and rotation.
 *
 * @param shape - The shape to rotate
 * @param deltaRotation - Rotation delta in radians
 * @param pivot - Pivot point in world coordinates
 * @returns New shape with updated position and rotation
 */
export function rotateShapeAround<T extends Shape>(
  shape: T,
  deltaRotation: number,
  pivot: Vec2
): T {
  // Rotate the shape's position around the pivot
  const position = new Vec2(shape.x, shape.y);
  const relative = position.subtract(pivot);
  const rotated = relative.rotate(deltaRotation);
  const newPosition = rotated.add(pivot);

  if (isLine(shape)) {
    // Also rotate the line end point
    const end = new Vec2(shape.x2, shape.y2);
    const relativeEnd = end.subtract(pivot);
    const rotatedEnd = relativeEnd.rotate(deltaRotation);
    const newEnd = rotatedEnd.add(pivot);

    return {
      ...shape,
      x: newPosition.x,
      y: newPosition.y,
      x2: newEnd.x,
      y2: newEnd.y,
      rotation: shape.rotation + deltaRotation,
    } as T;
  }

  return {
    ...shape,
    x: newPosition.x,
    y: newPosition.y,
    rotation: shape.rotation + deltaRotation,
  };
}

/**
 * Resize options for shape resizing.
 */
export interface ResizeOptions {
  /** Scale factor for width (1.0 = no change) */
  scaleX: number;
  /** Scale factor for height (1.0 = no change) */
  scaleY: number;
  /** Anchor point for scaling (default: shape center) */
  anchor?: Vec2;
  /** Whether to maintain aspect ratio */
  maintainAspectRatio?: boolean;
}

/**
 * Resize a shape by scale factors.
 * Returns a new shape with updated dimensions.
 *
 * @param shape - The shape to resize
 * @param options - Resize options
 * @returns New shape with updated dimensions
 */
export function resizeShape<T extends Shape>(shape: T, options: ResizeOptions): T {
  let { scaleX, scaleY } = options;
  const { anchor, maintainAspectRatio } = options;

  // Maintain aspect ratio if requested
  if (maintainAspectRatio) {
    const uniformScale = Math.max(Math.abs(scaleX), Math.abs(scaleY));
    scaleX = Math.sign(scaleX) * uniformScale || uniformScale;
    scaleY = Math.sign(scaleY) * uniformScale || uniformScale;
  }

  // Calculate new position if anchor is provided
  let newX = shape.x;
  let newY = shape.y;

  if (anchor) {
    // Scale the position relative to the anchor
    const dx = shape.x - anchor.x;
    const dy = shape.y - anchor.y;
    newX = anchor.x + dx * scaleX;
    newY = anchor.y + dy * scaleY;
  }

  if (isRectangle(shape)) {
    return {
      ...shape,
      x: newX,
      y: newY,
      width: Math.abs(shape.width * scaleX),
      height: Math.abs(shape.height * scaleY),
    } as T;
  }

  if (isEllipse(shape)) {
    return {
      ...shape,
      x: newX,
      y: newY,
      radiusX: Math.abs(shape.radiusX * scaleX),
      radiusY: Math.abs(shape.radiusY * scaleY),
    } as T;
  }

  if (isLine(shape)) {
    let newX2 = shape.x2;
    let newY2 = shape.y2;

    if (anchor) {
      const dx2 = shape.x2 - anchor.x;
      const dy2 = shape.y2 - anchor.y;
      newX2 = anchor.x + dx2 * scaleX;
      newY2 = anchor.y + dy2 * scaleY;
    } else {
      // Scale relative to start point
      const dx = shape.x2 - shape.x;
      const dy = shape.y2 - shape.y;
      newX2 = newX + dx * scaleX;
      newY2 = newY + dy * scaleY;
    }

    return {
      ...shape,
      x: newX,
      y: newY,
      x2: newX2,
      y2: newY2,
    } as T;
  }

  if (isText(shape)) {
    return {
      ...shape,
      x: newX,
      y: newY,
      width: Math.abs(shape.width * scaleX),
      fontSize: Math.abs(shape.fontSize * Math.max(scaleX, scaleY)),
    } as T;
  }

  // Fallback for unknown shapes
  return {
    ...shape,
    x: newX,
    y: newY,
  };
}

/**
 * Set the absolute dimensions of a shape.
 * For rectangles: sets width and height.
 * For ellipses: sets radiusX and radiusY.
 * For lines: sets the end point relative to start.
 * For text: sets the width (height is font-based).
 *
 * @param shape - The shape to resize
 * @param width - New width/radiusX
 * @param height - New height/radiusY
 * @returns New shape with updated dimensions
 */
export function setShapeSize<T extends Shape>(
  shape: T,
  width: number,
  height: number
): T {
  if (isRectangle(shape)) {
    return {
      ...shape,
      width: Math.abs(width),
      height: Math.abs(height),
    } as T;
  }

  if (isEllipse(shape)) {
    return {
      ...shape,
      radiusX: Math.abs(width),
      radiusY: Math.abs(height),
    } as T;
  }

  if (isLine(shape)) {
    // Set end point relative to start
    return {
      ...shape,
      x2: shape.x + width,
      y2: shape.y + height,
    } as T;
  }

  if (isText(shape)) {
    return {
      ...shape,
      width: Math.abs(width),
    } as T;
  }

  return shape;
}

/**
 * Move a shape to an absolute position.
 *
 * @param shape - The shape to move
 * @param position - New position in world coordinates
 * @returns New shape at the specified position
 */
export function setShapePosition<T extends Shape>(shape: T, position: Vec2): T {
  if (isLine(shape)) {
    // Maintain the relative offset of the end point
    const dx = shape.x2 - shape.x;
    const dy = shape.y2 - shape.y;
    return {
      ...shape,
      x: position.x,
      y: position.y,
      x2: position.x + dx,
      y2: position.y + dy,
    } as T;
  }

  return {
    ...shape,
    x: position.x,
    y: position.y,
  };
}

/**
 * Clone a shape with a new ID.
 *
 * @param shape - The shape to clone
 * @param newId - New unique identifier
 * @returns Cloned shape with new ID
 */
export function cloneShape<T extends Shape>(shape: T, newId: string): T {
  return {
    ...shape,
    id: newId,
  };
}

/**
 * Clone a shape with an offset.
 *
 * @param shape - The shape to clone
 * @param newId - New unique identifier
 * @param offset - Offset from original position
 * @returns Cloned shape with new ID and position
 */
export function cloneShapeWithOffset<T extends Shape>(
  shape: T,
  newId: string,
  offset: Vec2
): T {
  const cloned = cloneShape(shape, newId);
  return translateShape(cloned, offset);
}
