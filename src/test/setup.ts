/**
 * Vitest global setup.
 *
 * jsdom does not implement `Path2D` (it's part of the canvas API, which jsdom
 * stubs out). Shape path builders construct `Path2D` instances in production,
 * so provide a minimal no-op stub for the test environment. Tests assert on the
 * canvas context's `fill(path)`/`stroke(path)` calls (mocked), not on the path
 * geometry itself, so a behaviorless stub is sufficient.
 */

type PathMethods = Record<string, (...args: number[]) => void>;

if (typeof (globalThis as { Path2D?: unknown }).Path2D === 'undefined') {
  class Path2DStub implements PathMethods {
    [method: string]: (...args: number[]) => void;
    addPath() {}
    closePath() {}
    moveTo() {}
    lineTo() {}
    bezierCurveTo() {}
    quadraticCurveTo() {}
    arc() {}
    arcTo() {}
    ellipse() {}
    rect() {}
    roundRect() {}
  }
  (globalThis as { Path2D?: unknown }).Path2D = Path2DStub;
}
