import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Renderer, RendererOptions } from './Renderer';
import { Camera } from './Camera';
import { Vec2 } from '../math/Vec2';

/**
 * Create a mock canvas element with a mock 2D context.
 */
function createMockCanvas(width = 800, height = 600): HTMLCanvasElement {
  const ctx = {
    canvas: { width, height },
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textBaseline: '',
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    setTransform: vi.fn(),
    transform: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fillText: vi.fn(),
  };

  const canvas = {
    width,
    height,
    getContext: vi.fn().mockReturnValue(ctx),
    getBoundingClientRect: vi.fn().mockReturnValue({
      left: 0,
      top: 0,
      width,
      height,
    }),
  } as unknown as HTMLCanvasElement;

  return canvas;
}

/**
 * Get the mock context from a mock canvas.
 */
function getMockContext(canvas: HTMLCanvasElement) {
  return canvas.getContext('2d') as unknown as {
    fillStyle: string;
    strokeStyle: string;
    lineWidth: number;
    font: string;
    textBaseline: string;
    fillRect: ReturnType<typeof vi.fn>;
    clearRect: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
    restore: ReturnType<typeof vi.fn>;
    setTransform: ReturnType<typeof vi.fn>;
    transform: ReturnType<typeof vi.fn>;
    beginPath: ReturnType<typeof vi.fn>;
    moveTo: ReturnType<typeof vi.fn>;
    lineTo: ReturnType<typeof vi.fn>;
    stroke: ReturnType<typeof vi.fn>;
    fillText: ReturnType<typeof vi.fn>;
  };
}

describe('Renderer', () => {
  let originalRaf: typeof globalThis.requestAnimationFrame;
  let originalCaf: typeof globalThis.cancelAnimationFrame;
  let rafCallbacks: Map<number, FrameRequestCallback>;
  let rafId: number;

  beforeEach(() => {
    // Mock requestAnimationFrame and cancelAnimationFrame
    rafCallbacks = new Map();
    rafId = 0;
    originalRaf = globalThis.requestAnimationFrame;
    originalCaf = globalThis.cancelAnimationFrame;

    globalThis.requestAnimationFrame = vi.fn((callback) => {
      const id = ++rafId;
      rafCallbacks.set(id, callback);
      return id;
    });

    globalThis.cancelAnimationFrame = vi.fn((id) => {
      rafCallbacks.delete(id);
    });
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCaf;
  });

  /**
   * Execute all pending animation frame callbacks.
   */
  function flushRaf(timestamp = 16.67): void {
    const callbacks = Array.from(rafCallbacks.values());
    rafCallbacks.clear();
    for (const cb of callbacks) {
      cb(timestamp);
    }
  }

  describe('constructor', () => {
    it('creates renderer with canvas and camera', () => {
      const canvas = createMockCanvas();
      const camera = new Camera();

      const renderer = new Renderer(canvas, camera);

      expect(renderer).toBeInstanceOf(Renderer);
      expect(renderer.isDestroyed).toBe(false);
      expect(renderer.isPending).toBe(false);
    });

    it('throws if canvas has no 2D context', () => {
      const canvas = {
        getContext: vi.fn().mockReturnValue(null),
      } as unknown as HTMLCanvasElement;
      const camera = new Camera();

      expect(() => new Renderer(canvas, camera)).toThrow(
        'Failed to get 2D rendering context'
      );
    });

    it('accepts custom options', () => {
      const canvas = createMockCanvas();
      const camera = new Camera();
      const options: RendererOptions = {
        showGrid: false,
        gridSpacing: 100,
        backgroundColor: '#f0f0f0',
        showFps: true,
      };

      const renderer = new Renderer(canvas, camera, options);

      expect(renderer).toBeInstanceOf(Renderer);
    });
  });

  describe('requestRender', () => {
    it('schedules a render on next animation frame', () => {
      const canvas = createMockCanvas();
      const camera = new Camera();
      const renderer = new Renderer(canvas, camera);

      renderer.requestRender();

      expect(renderer.isPending).toBe(true);
      expect(globalThis.requestAnimationFrame).toHaveBeenCalledTimes(1);
    });

    it('coalesces multiple render requests', () => {
      const canvas = createMockCanvas();
      const camera = new Camera();
      const renderer = new Renderer(canvas, camera);

      renderer.requestRender();
      renderer.requestRender();
      renderer.requestRender();

      expect(globalThis.requestAnimationFrame).toHaveBeenCalledTimes(1);
    });

    it('does not request render if destroyed', () => {
      const canvas = createMockCanvas();
      const camera = new Camera();
      const renderer = new Renderer(canvas, camera);

      renderer.destroy();
      renderer.requestRender();

      expect(globalThis.requestAnimationFrame).not.toHaveBeenCalled();
    });

    it('clears pending state after render executes', () => {
      const canvas = createMockCanvas();
      const camera = new Camera();
      camera.setViewport(800, 600);
      const renderer = new Renderer(canvas, camera);

      renderer.requestRender();
      expect(renderer.isPending).toBe(true);

      flushRaf();

      expect(renderer.isPending).toBe(false);
    });
  });

  describe('renderNow', () => {
    it('renders immediately without waiting for animation frame', () => {
      const canvas = createMockCanvas();
      const camera = new Camera();
      camera.setViewport(800, 600);
      const renderer = new Renderer(canvas, camera);
      const ctx = getMockContext(canvas);

      renderer.renderNow();

      expect(ctx.fillRect).toHaveBeenCalled();
    });

    it('cancels pending animation frame', () => {
      const canvas = createMockCanvas();
      const camera = new Camera();
      camera.setViewport(800, 600);
      const renderer = new Renderer(canvas, camera);

      renderer.requestRender();
      expect(renderer.isPending).toBe(true);

      renderer.renderNow();

      expect(globalThis.cancelAnimationFrame).toHaveBeenCalled();
      expect(renderer.isPending).toBe(false);
    });

    it('does not render if destroyed', () => {
      const canvas = createMockCanvas();
      const camera = new Camera();
      const renderer = new Renderer(canvas, camera);
      const ctx = getMockContext(canvas);

      renderer.destroy();
      renderer.renderNow();

      expect(ctx.fillRect).not.toHaveBeenCalled();
    });
  });

  describe('render loop', () => {
    it('clears canvas with background color', () => {
      const canvas = createMockCanvas(800, 600);
      const camera = new Camera();
      camera.setViewport(800, 600);
      const renderer = new Renderer(canvas, camera, {
        backgroundColor: '#ff0000',
        showGrid: false,
      });
      const ctx = getMockContext(canvas);

      renderer.renderNow();

      expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 800, 600);
    });

    it('applies camera transform', () => {
      const canvas = createMockCanvas();
      const camera = new Camera();
      camera.setViewport(800, 600);
      const renderer = new Renderer(canvas, camera, { showGrid: false });
      const ctx = getMockContext(canvas);

      renderer.renderNow();

      expect(ctx.setTransform).toHaveBeenCalled();
    });

    it('saves and restores context around world-space drawing', () => {
      const canvas = createMockCanvas();
      const camera = new Camera();
      camera.setViewport(800, 600);
      const renderer = new Renderer(canvas, camera, { showGrid: false });
      const ctx = getMockContext(canvas);

      renderer.renderNow();

      expect(ctx.save).toHaveBeenCalled();
      expect(ctx.restore).toHaveBeenCalled();
    });

    it('skips rendering if canvas has zero size', () => {
      const canvas = createMockCanvas(0, 0);
      const camera = new Camera();
      camera.setViewport(0, 0);
      const renderer = new Renderer(canvas, camera);
      const ctx = getMockContext(canvas);

      renderer.renderNow();

      expect(ctx.fillRect).not.toHaveBeenCalled();
    });
  });

  describe('drawGrid', () => {
    it('draws grid when showGrid is true', () => {
      const canvas = createMockCanvas();
      const camera = new Camera();
      camera.setViewport(800, 600);
      const renderer = new Renderer(canvas, camera, { showGrid: true });
      const ctx = getMockContext(canvas);

      renderer.renderNow();

      // Grid drawing uses beginPath, moveTo, lineTo, stroke
      expect(ctx.beginPath).toHaveBeenCalled();
      expect(ctx.moveTo).toHaveBeenCalled();
      expect(ctx.lineTo).toHaveBeenCalled();
      expect(ctx.stroke).toHaveBeenCalled();
    });

    it('does not draw grid when showGrid is false', () => {
      const canvas = createMockCanvas();
      const camera = new Camera();
      camera.setViewport(800, 600);
      const renderer = new Renderer(canvas, camera, { showGrid: false });
      const ctx = getMockContext(canvas);

      renderer.renderNow();

      // Only save/restore for main loop, no grid-specific drawing
      expect(ctx.beginPath).not.toHaveBeenCalled();
    });
  });

  describe('contrast cache lifecycle', () => {
    function makeRenderer() {
      const canvas = createMockCanvas();
      const camera = new Camera();
      camera.setViewport(800, 600);
      const renderer = new Renderer(canvas, camera, { showGrid: false });
      const cache = (
        renderer as unknown as { contrastCache: { clear: () => void } }
      ).contrastCache;
      const clearSpy = vi.spyOn(cache, 'clear');
      return { renderer, camera, clearSpy };
    }

    it('does not clear the contrast cache on camera-only frames', () => {
      const { renderer, camera, clearSpy } = makeRenderer();
      // Stable shape-data + z-order references across the frames below.
      renderer.setShapes({}, []);

      renderer.renderNow();
      const afterFirstFrame = clearSpy.mock.calls.length;

      // Pan only — shape data and z-order references are unchanged, so the
      // resolved AUTO colours must survive (the per-frame-cost regression fix).
      camera.pan(new Vec2(40, 25));
      renderer.renderNow();
      camera.pan(new Vec2(-10, 5));
      renderer.renderNow();

      expect(clearSpy.mock.calls.length).toBe(afterFirstFrame);
    });

    it('clears the contrast cache when shape data changes', () => {
      const { renderer, clearSpy } = makeRenderer();
      renderer.setShapes({}, []);
      renderer.renderNow();
      const afterFirstFrame = clearSpy.mock.calls.length;

      // A new shapes reference (a document mutation) must invalidate the cache.
      renderer.setShapes({}, []);
      renderer.renderNow();

      expect(clearSpy.mock.calls.length).toBe(afterFirstFrame + 1);
    });

    it('clears the contrast cache when only the z-order changes', () => {
      const { renderer, clearSpy } = makeRenderer();
      const shapes = {};
      renderer.setShapes(shapes, ['a', 'b']);
      renderer.renderNow();
      const afterFirstFrame = clearSpy.mock.calls.length;

      // Same shapes object, new shapeOrder array — a z-order edit changes which
      // background is topmost, so AUTO colours must be re-resolved.
      renderer.setShapes(shapes, ['b', 'a']);
      renderer.renderNow();

      expect(clearSpy.mock.calls.length).toBe(afterFirstFrame + 1);
    });
  });

  describe('tool overlay callback', () => {
    it('calls tool overlay callback during render', () => {
      const canvas = createMockCanvas();
      const camera = new Camera();
      camera.setViewport(800, 600);
      const renderer = new Renderer(canvas, camera, { showGrid: false });
      const overlayCallback = vi.fn();

      renderer.setToolOverlayCallback(overlayCallback);
      renderer.renderNow();

      expect(overlayCallback).toHaveBeenCalled();
      // Callback receives the 2D context
      expect(overlayCallback.mock.calls[0][0]).toBeDefined();
    });

    it('saves and restores context around tool overlay', () => {
      const canvas = createMockCanvas();
      const camera = new Camera();
      camera.setViewport(800, 600);
      const renderer = new Renderer(canvas, camera, { showGrid: false });
      const ctx = getMockContext(canvas);

      renderer.setToolOverlayCallback(() => {});
      renderer.renderNow();

      // save/restore is called multiple times: once for world-space, once for overlay
      expect(ctx.save.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(ctx.restore.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('can clear tool overlay callback', () => {
      const canvas = createMockCanvas();
      const camera = new Camera();
      camera.setViewport(800, 600);
      const renderer = new Renderer(canvas, camera, { showGrid: false });
      const overlayCallback = vi.fn();

      renderer.setToolOverlayCallback(overlayCallback);
      renderer.setToolOverlayCallback(null);
      renderer.renderNow();

      expect(overlayCallback).not.toHaveBeenCalled();
    });
  });

  describe('FPS counter', () => {
    it('draws FPS counter when showFps is true', () => {
      const canvas = createMockCanvas();
      const camera = new Camera();
      camera.setViewport(800, 600);
      const renderer = new Renderer(canvas, camera, {
        showGrid: false,
        showFps: true,
      });
      const ctx = getMockContext(canvas);

      renderer.renderNow();

      expect(ctx.fillText).toHaveBeenCalled();
    });

    it('does not draw FPS counter when showFps is false', () => {
      const canvas = createMockCanvas();
      const camera = new Camera();
      camera.setViewport(800, 600);
      const renderer = new Renderer(canvas, camera, {
        showGrid: false,
        showFps: false,
      });
      const ctx = getMockContext(canvas);

      renderer.renderNow();

      expect(ctx.fillText).not.toHaveBeenCalled();
    });
  });

  describe('performance metrics', () => {
    it('returns initial metrics', () => {
      const canvas = createMockCanvas();
      const camera = new Camera();
      const renderer = new Renderer(canvas, camera);

      const metrics = renderer.getMetrics();

      expect(metrics.frameCount).toBe(0);
      expect(metrics.fps).toBe(0);
      expect(metrics.frameTime).toBe(0);
    });

    it('updates frame count after render', () => {
      const canvas = createMockCanvas();
      const camera = new Camera();
      camera.setViewport(800, 600);
      const renderer = new Renderer(canvas, camera, { showGrid: false });

      renderer.renderNow();
      renderer.renderNow();
      renderer.renderNow();

      const metrics = renderer.getMetrics();
      expect(metrics.frameCount).toBe(3);
    });

    it('updates frame time after render', () => {
      const canvas = createMockCanvas();
      const camera = new Camera();
      camera.setViewport(800, 600);
      const renderer = new Renderer(canvas, camera, { showGrid: false });

      // First render establishes baseline
      renderer.requestRender();
      flushRaf(1000);

      // Second render has measurable frame time
      renderer.requestRender();
      flushRaf(1016.67); // ~60fps frame

      const metrics = renderer.getMetrics();
      expect(metrics.frameTime).toBeCloseTo(16.67, 0);
    });

    it('resets metrics', () => {
      const canvas = createMockCanvas();
      const camera = new Camera();
      camera.setViewport(800, 600);
      const renderer = new Renderer(canvas, camera, { showGrid: false });

      renderer.renderNow();
      renderer.renderNow();
      renderer.resetMetrics();

      const metrics = renderer.getMetrics();
      expect(metrics.frameCount).toBe(0);
      expect(metrics.fps).toBe(0);
    });
  });

  describe('setOptions', () => {
    it('updates renderer options', () => {
      const canvas = createMockCanvas();
      const camera = new Camera();
      camera.setViewport(800, 600);
      const renderer = new Renderer(canvas, camera, { showGrid: false });
      const ctx = getMockContext(canvas);

      renderer.setOptions({ showGrid: true });
      renderer.renderNow();

      // Grid drawing should now occur
      expect(ctx.beginPath).toHaveBeenCalled();
    });
  });

  describe('setCamera', () => {
    it('updates camera reference', () => {
      const canvas = createMockCanvas();
      const camera1 = new Camera();
      const camera2 = new Camera({ x: 100, y: 100 });
      camera1.setViewport(800, 600);
      camera2.setViewport(800, 600);

      const renderer = new Renderer(canvas, camera1);
      renderer.setCamera(camera2);
      renderer.renderNow();

      // Render completes without error using new camera
      expect(renderer.isDestroyed).toBe(false);
    });
  });

  describe('destroy', () => {
    it('marks renderer as destroyed', () => {
      const canvas = createMockCanvas();
      const camera = new Camera();
      const renderer = new Renderer(canvas, camera);

      renderer.destroy();

      expect(renderer.isDestroyed).toBe(true);
    });

    it('cancels pending animation frame on destroy', () => {
      const canvas = createMockCanvas();
      const camera = new Camera();
      const renderer = new Renderer(canvas, camera);

      renderer.requestRender();
      renderer.destroy();

      expect(globalThis.cancelAnimationFrame).toHaveBeenCalled();
      expect(renderer.isPending).toBe(false);
    });

    it('is idempotent', () => {
      const canvas = createMockCanvas();
      const camera = new Camera();
      const renderer = new Renderer(canvas, camera);

      renderer.destroy();
      renderer.destroy();
      renderer.destroy();

      expect(renderer.isDestroyed).toBe(true);
    });

    it('clears tool overlay callback', () => {
      const canvas = createMockCanvas();
      const camera = new Camera();
      camera.setViewport(800, 600);
      const renderer = new Renderer(canvas, camera, { showGrid: false });
      const overlayCallback = vi.fn();

      renderer.setToolOverlayCallback(overlayCallback);
      renderer.destroy();

      // Try to trigger render (should not happen)
      renderer.renderNow();

      expect(overlayCallback).not.toHaveBeenCalled();
    });
  });

  describe('camera transform integration', () => {
    it('applies correct transform for zoomed camera', () => {
      const canvas = createMockCanvas();
      const camera = new Camera({ zoom: 2 });
      camera.setViewport(800, 600);
      const renderer = new Renderer(canvas, camera, { showGrid: false });
      const ctx = getMockContext(canvas);

      renderer.renderNow();

      // transform (not setTransform) is used for camera to multiply with DPI
      expect(ctx.transform).toHaveBeenCalled();
      const call = ctx.transform.mock.calls[0] as number[] | undefined;
      expect(call).toBeDefined();
      // a (horizontal scale) should be 2
      expect(call![0]).toBe(2);
      // d (vertical scale) should be 2
      expect(call![3]).toBe(2);
    });

    it('applies correct transform for panned camera', () => {
      const canvas = createMockCanvas();
      const camera = new Camera({ x: 100, y: 50 });
      camera.setViewport(800, 600);
      const renderer = new Renderer(canvas, camera, { showGrid: false });
      const ctx = getMockContext(canvas);

      renderer.renderNow();

      // transform (not setTransform) is used for camera to multiply with DPI
      expect(ctx.transform).toHaveBeenCalled();
      const call = ctx.transform.mock.calls[0] as number[] | undefined;
      expect(call).toBeDefined();
      // e (horizontal translation) = centerX + (-camX) * zoom = 400 - 100 = 300
      expect(call![4]).toBe(300);
      // f (vertical translation) = centerY + (-camY) * zoom = 300 - 50 = 250
      expect(call![5]).toBe(250);
    });
  });
});
