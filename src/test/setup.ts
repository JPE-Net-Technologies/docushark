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

// jsdom does not implement `matchMedia`. Stores read it at module load
// (theme `prefers-color-scheme`, device adaptive hints), so provide a minimal
// always-"no-match" stub with the full MediaQueryList event surface.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// jsdom does not implement `ResizeObserver`; Radix primitives (e.g. Slider)
// observe their elements. A no-op stub is sufficient for the test environment.
if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
}

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
