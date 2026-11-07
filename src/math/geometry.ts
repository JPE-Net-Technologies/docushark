import { Vec2 } from './Vec2';
import { Box } from './Box';

/**
 * Result of a line-line intersection test.
 */
export interface LineIntersection {
  /** Whether the lines intersect */
  intersects: boolean;
  /** The intersection point (if intersects is true) */
  point: Vec2 | null;
  /** Parameter t for the first line segment (0-1 means on segment) */
  t: number;
  /** Parameter u for the second line segment (0-1 means on segment) */
  u: number;
}

/**
 * Check if a point is inside an axis-aligned rectangle.
 * @param point The point to test
 * @param rectX X coordinate of rectangle center
 * @param rectY Y coordinate of rectangle center
 * @param width Width of rectangle
 * @param height Height of rectangle
 */
export function pointInRect(
  point: Vec2,
  rectX: number,
  rectY: number,
  width: number,
  height: number
): boolean {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  return (
    point.x >= rectX - halfWidth &&
    point.x <= rectX + halfWidth &&
    point.y >= rectY - halfHeight &&
    point.y <= rectY + halfHeight
  );
}

/**
 * Check if a point is inside a rotated rectangle.
 * @param point The point to test (in world coordinates)
 * @param rectX X coordinate of rectangle center
 * @param rectY Y coordinate of rectangle center
 * @param width Width of rectangle
 * @param height Height of rectangle
 * @param rotation Rotation angle in radians
 */
export function pointInRotatedRect(
  point: Vec2,
  rectX: number,
  rectY: number,
  width: number,
  height: number,
  rotation: number
): boolean {
  // Transform point to rectangle's local coordinate space
  const center = new Vec2(rectX, rectY);
  const localPoint = point.rotateAround(center, -rotation);

  // Now test against axis-aligned rect
  return pointInRect(localPoint, rectX, rectY, width, height);
}

/**
 * Check if a point is inside a circle.
 * @param point The point to test
 * @param centerX X coordinate of circle center
 * @param centerY Y coordinate of circle center
 * @param radius Radius of the circle
 */
export function pointInCircle(
  point: Vec2,
  centerX: number,
  centerY: number,
  radius: number
): boolean {
  const dx = point.x - centerX;
  const dy = point.y - centerY;
  return dx * dx + dy * dy <= radius * radius;
}

/**
 * Check if a point is inside an ellipse.
 * @param point The point to test
 * @param centerX X coordinate of ellipse center
 * @param centerY Y coordinate of ellipse center
 * @param radiusX Horizontal radius
 * @param radiusY Vertical radius
 */
export function pointInEllipse(
  point: Vec2,
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number
): boolean {
  if (radiusX === 0 || radiusY === 0) return false;

  const dx = point.x - centerX;
  const dy = point.y - centerY;
  // Ellipse equation: (x/a)^2 + (y/b)^2 <= 1
  return (dx * dx) / (radiusX * radiusX) + (dy * dy) / (radiusY * radiusY) <= 1;
}

/**
 * Check if a point is inside a rotated ellipse.
 * @param point The point to test (in world coordinates)
 * @param centerX X coordinate of ellipse center
 * @param centerY Y coordinate of ellipse center
 * @param radiusX Horizontal radius
 * @param radiusY Vertical radius
 * @param rotation Rotation angle in radians
 */
export function pointInRotatedEllipse(
  point: Vec2,
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number,
  rotation: number
): boolean {
  // Transform point to ellipse's local coordinate space
  const center = new Vec2(centerX, centerY);
  const localPoint = point.rotateAround(center, -rotation);

  return pointInEllipse(localPoint, centerX, centerY, radiusX, radiusY);
}

/**
 * Calculate the intersection point of two infinite lines.
 * Lines are defined by points: line1 from p1 to p2, line2 from p3 to p4.
 * @param p1 First point of line 1
 * @param p2 Second point of line 1
 * @param p3 First point of line 2
 * @param p4 Second point of line 2
 * @returns Intersection result with point and parameters
 */
export function lineIntersection(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): LineIntersection {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;

  const denominator = d1x * d2y - d1y * d2x;

  // Lines are parallel
  if (Math.abs(denominator) < 1e-10) {
    return { intersects: false, point: null, t: NaN, u: NaN };
  }

  const dx = p3.x - p1.x;
  const dy = p3.y - p1.y;

  const t = (dx * d2y - dy * d2x) / denominator;
  const u = (dx * d1y - dy * d1x) / denominator;

  const point = new Vec2(p1.x + t * d1x, p1.y + t * d1y);

  return { intersects: true, point, t, u };
}

/**
 * Calculate the intersection point of two line segments.
 * Returns null if segments don't intersect.
 * @param p1 Start of segment 1
 * @param p2 End of segment 1
 * @param p3 Start of segment 2
 * @param p4 End of segment 2
 */
export function segmentIntersection(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): Vec2 | null {
  const result = lineIntersection(p1, p2, p3, p4);

  if (!result.intersects) return null;

  // Check if intersection is within both segments
  if (result.t >= 0 && result.t <= 1 && result.u >= 0 && result.u <= 1) {
    return result.point;
  }

  return null;
}

/**
 * Calculate the shortest distance from a point to an infinite line.
 * @param point The point
 * @param lineStart First point on the line
 * @param lineEnd Second point on the line
 */
export function distanceToLine(point: Vec2, lineStart: Vec2, lineEnd: Vec2): number {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;

  const lengthSquared = dx * dx + dy * dy;

  // Line is a point
  if (lengthSquared < 1e-10) {
    return point.distanceTo(lineStart);
  }

  // Calculate perpendicular distance using cross product
  const cross = Math.abs((point.x - lineStart.x) * dy - (point.y - lineStart.y) * dx);
  return cross / Math.sqrt(lengthSquared);
}

/**
 * Calculate the shortest distance from a point to a line segment.
 * @param point The point
 * @param segmentStart Start of the segment
 * @param segmentEnd End of the segment
 */
export function distanceToSegment(point: Vec2, segmentStart: Vec2, segmentEnd: Vec2): number {
  const dx = segmentEnd.x - segmentStart.x;
  const dy = segmentEnd.y - segmentStart.y;

  const lengthSquared = dx * dx + dy * dy;

  // Segment is a point
  if (lengthSquared < 1e-10) {
    return point.distanceTo(segmentStart);
  }

  // Project point onto line and clamp to segment
  const t = Math.max(
    0,
    Math.min(1, ((point.x - segmentStart.x) * dx + (point.y - segmentStart.y) * dy) / lengthSquared)
  );

  const projection = new Vec2(segmentStart.x + t * dx, segmentStart.y + t * dy);

  return point.distanceTo(projection);
}

/**
 * Find the closest point on a line segment to a given point.
 * @param point The point
 * @param segmentStart Start of the segment
 * @param segmentEnd End of the segment
 */
export function closestPointOnSegment(point: Vec2, segmentStart: Vec2, segmentEnd: Vec2): Vec2 {
  const dx = segmentEnd.x - segmentStart.x;
  const dy = segmentEnd.y - segmentStart.y;

  const lengthSquared = dx * dx + dy * dy;

  // Segment is a point
  if (lengthSquared < 1e-10) {
    return segmentStart.clone();
  }

  // Project point onto line and clamp to segment
  const t = Math.max(
    0,
    Math.min(1, ((point.x - segmentStart.x) * dx + (point.y - segmentStart.y) * dy) / lengthSquared)
  );

  return new Vec2(segmentStart.x + t * dx, segmentStart.y + t * dy);
}

/**
 * Check if a point is on a line segment within a tolerance.
 * @param point The point to test
 * @param segmentStart Start of the segment
 * @param segmentEnd End of the segment
 * @param tolerance Distance tolerance
 */
export function pointOnSegment(
  point: Vec2,
  segmentStart: Vec2,
  segmentEnd: Vec2,
  tolerance: number = 1e-10
): boolean {
  return distanceToSegment(point, segmentStart, segmentEnd) <= tolerance;
}

/**
 * Calculate the angle between two vectors (in radians).
 * @param v1 First vector
 * @param v2 Second vector
 * @returns Angle in radians [0, PI]
 */
export function angleBetween(v1: Vec2, v2: Vec2): number {
  const dot = v1.dot(v2);
  const len1 = v1.length();
  const len2 = v2.length();

  if (len1 < 1e-10 || len2 < 1e-10) return 0;

  // Clamp to avoid NaN from acos due to floating point errors
  const cos = Math.max(-1, Math.min(1, dot / (len1 * len2)));
  return Math.acos(cos);
}

/**
 * Calculate the signed angle from v1 to v2 (in radians).
 * Positive is counter-clockwise.
 * @param v1 First vector
 * @param v2 Second vector
 * @returns Signed angle in radians [-PI, PI]
 */
export function signedAngleBetween(v1: Vec2, v2: Vec2): number {
  return Math.atan2(v1.cross(v2), v1.dot(v2));
}

/**
 * Check if a box intersects with a line segment.
 * @param box The bounding box
 * @param p1 Start of segment
 * @param p2 End of segment
 */
export function boxIntersectsSegment(box: Box, p1: Vec2, p2: Vec2): boolean {
  // Quick check: if both endpoints are on same side of box, no intersection
  const c1 = getOutcode(p1, box);
  const c2 = getOutcode(p2, box);

  // Both points outside on same side
  if ((c1 & c2) !== 0) return false;

  // At least one point inside
  if (c1 === 0 || c2 === 0) return true;

  // Cohen-Sutherland style clipping
  // Check intersection with each edge
  const corners = box.getCorners();
  const edges: [Vec2, Vec2][] = [
    [corners[0], corners[1]], // top
    [corners[1], corners[2]], // right
    [corners[2], corners[3]], // bottom
    [corners[3], corners[0]], // left
  ];

  for (const edge of edges) {
    if (segmentIntersection(p1, p2, edge[0], edge[1])) {
      return true;
    }
  }

  return false;
}

/**
 * Get the outcode for Cohen-Sutherland clipping.
 */
function getOutcode(p: Vec2, box: Box): number {
  let code = 0;
  if (p.x < box.minX) code |= 1; // left
  if (p.x > box.maxX) code |= 2; // right
  if (p.y < box.minY) code |= 4; // top
  if (p.y > box.maxY) code |= 8; // bottom
  return code;
}

/**
 * Clip a segment a→b against an axis-aligned box (Liang–Barsky). Returns the
 * parameter range `[tEnter, tExit]` (within [0,1]) over which the segment lies
 * inside the box, or null if it never enters. Breaks a connector line behind
 * its label, and finds where a line crosses a shape's bounds.
 */
export function segmentBoxOverlap(a: Vec2, b: Vec2, box: Box): [number, number] | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const edges: Array<[number, number]> = [
    [-dx, a.x - box.minX],
    [dx, box.maxX - a.x],
    [-dy, a.y - box.minY],
    [dy, box.maxY - a.y],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null; // parallel to this edge and fully outside it
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  return t0 <= t1 ? [t0, t1] : null;
}

/**
 * Calculate the bounding box of a rotated rectangle.
 * @param centerX Center X coordinate
 * @param centerY Center Y coordinate
 * @param width Width of rectangle
 * @param height Height of rectangle
 * @param rotation Rotation angle in radians
 */
export function rotatedRectBounds(
  centerX: number,
  centerY: number,
  width: number,
  height: number,
  rotation: number
): Box {
  const cos = Math.abs(Math.cos(rotation));
  const sin = Math.abs(Math.sin(rotation));

  const boundWidth = width * cos + height * sin;
  const boundHeight = width * sin + height * cos;

  return Box.fromCenter(new Vec2(centerX, centerY), boundWidth, boundHeight);
}

/**
 * Normalize an angle to the range [-PI, PI].
 */
export function normalizeAngle(angle: number): number {
  while (angle > Math.PI) angle -= 2 * Math.PI;
  while (angle < -Math.PI) angle += 2 * Math.PI;
  return angle;
}

/**
 * Convert degrees to radians.
 */
export function degToRad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Convert radians to degrees.
 */
export function radToDeg(radians: number): number {
  return (radians * 180) / Math.PI;
}

/**
 * Linearly interpolate between two values.
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Ease-in-out cubic easing function.
 * Returns a value in [0, 1] for input t in [0, 1].
 */
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Clamp a value to a range.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Check if two numbers are approximately equal.
 */
export function approxEqual(a: number, b: number, epsilon: number = 1e-10): boolean {
  return Math.abs(a - b) < epsilon;
}
