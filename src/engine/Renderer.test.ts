import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Renderer, RendererOptions, scaleHandleSize } from './Renderer';
import { Camera } from './Camera';
import { device } from '../platform/device';
import { refreshAdaptiveBudget } from '../platform/adaptiveBudget';
import { Vec2 } from '../math/Vec2';
import type { ConnectorShape, Shape } from '../shapes/Shape';
// Register the connector handler (self-registers on import) for the JP-353 test.
import { connectorHandler } from '../shapes/Connector';

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

  describe('handle sizing (JP-332)', () => {
    afterEach(() => {
      // Restore the device mock, then re-derive so the global budget snapshot
      // returns to the real (jsdom = fine-pointer) value for other tests.
      vi.restoreAllMocks();
      refreshAdaptiveBudget();
    });

    it('scaleHandleSize enlarges the handle on coarse pointers (grab-zone parity)', () => {
      expect(scaleHandleSize(8, 1.6)).toBe(13);
    });

    it('scaleHandleSize leaves the handle unchanged on a fine pointer', () => {
      expect(scaleHandleSize(8, 1)).toBe(8);
    });

    it('defaults the drawn handle to the touch-scaled size on a coarse pointer', () => {
      vi.spyOn(device, 'isTouch').mockReturnValue(true);
      refreshAdaptiveBudget();
      const renderer = new Renderer(createMockCanvas(), new Camera());
      const opts = (renderer as unknown as { options: Required<RendererOptions> }).options;
      expect(opts.handleSize).toBe(13);
    });

    it('keeps the 8px handle on a fine pointer', () => {
      vi.spyOn(device, 'isTouch').mockReturnValue(false);
      refreshAdaptiveBudget();
      const renderer = new Renderer(createMockCanvas(), new Camera());
      const opts = (renderer as unknown as { options: Required<RendererOptions> }).options;
      expect(opts.handleSize).toBe(8);
    });

    it('still honors an explicit handleSize override on touch', () => {
      vi.spyOn(device, 'isTouch').mockReturnValue(true);
      refreshAdaptiveBudget();
      const renderer = new Renderer(createMockCanvas(), new Camera(), { handleSize: 6 });
      const opts = (renderer as unknown as { options: Required<RendererOptions> }).options;
      expect(opts.handleSize).toBe(6);
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

  describe('deferred connector-label overlay (JP-353)', () => {
    /** A canvas whose 2D context records every drawing call (for call-order). */
    function createRecordingCanvas(): {
      canvas: HTMLCanvasElement;
      ctx: { stroke: ReturnType<typeof vi.fn>; fillText: ReturnType<typeof vi.fn> };
    } {
      const ctx = {
        save: vi.fn(),
        restore: vi.fn(),
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        stroke: vi.fn(),
        fill: vi.fn(),
        closePath: vi.fn(),
        arc: vi.fn(),
        setLineDash: vi.fn(),
        clearRect: vi.fn(),
        fillRect: vi.fn(),
        strokeRect: vi.fn(),
        fillText: vi.fn(),
        strokeText: vi.fn(),
        measureText: vi.fn().mockReturnValue({ width: 40 }),
        translate: vi.fn(),
        rotate: vi.fn(),
        setTransform: vi.fn(),
        transform: vi.fn(),
        canvas: { width: 800, height: 600 },
        globalAlpha: 1,
        strokeStyle: '',
        fillStyle: '',
        lineWidth: 1,
        lineCap: 'butt',
        lineJoin: 'miter',
        font: '',
        textAlign: 'left',
        textBaseline: 'alphabetic',
      };
      const canvas = {
        width: 800,
        height: 600,
        getContext: vi.fn().mockReturnValue(ctx),
        getBoundingClientRect: vi.fn().mockReturnValue({ left: 0, top: 0, width: 800, height: 600 }),
      } as unknown as HTMLCanvasElement;
      return { canvas, ctx: ctx as unknown as { stroke: ReturnType<typeof vi.fn>; fillText: ReturnType<typeof vi.fn> } };
    }

    function connector(id: string, label: string, pts: [number, number, number, number]): ConnectorShape {
      const [x, y, x2, y2] = pts;
      return {
        id, type: 'connector', x, y, x2, y2,
        rotation: 0, opacity: 1, locked: false, visible: true,
        fill: null, stroke: '#000000', strokeWidth: 2,
        startShapeId: null, startAnchor: 'center', endShapeId: null, endAnchor: 'center',
        startArrow: false, endArrow: false,
        label,
      } as ConnectorShape;
    }

    it('draws both connector lines before either label, so labels are never buried', () => {
      const { canvas, ctx } = createRecordingCanvas();
      const camera = new Camera();
      camera.setViewport(800, 600);
      const renderer = new Renderer(canvas, camera, { showGrid: false });

      // Two crossing connectors through the origin, each with a label — without
      // the deferred pass, the second connector's line would paint over the
      // first connector's label.
      const a = connector('a', 'AAA', [-100, 0, 100, 0]);
      const b = connector('b', 'BBB', [0, -100, 0, 100]);
      const shapes: Record<string, Shape> = { a, b };
      renderer.setShapes(shapes, ['a', 'b']);
      renderer.renderNow();

      const strokeOrders = ctx.stroke.mock.invocationCallOrder;
      const labelOrders = ctx.fillText.mock.invocationCallOrder;

      // Both labels were drawn (deferred overlay ran for both connectors).
      expect(ctx.fillText).toHaveBeenCalledWith('AAA', expect.any(Number), expect.any(Number));
      expect(ctx.fillText).toHaveBeenCalledWith('BBB', expect.any(Number), expect.any(Number));

      // Every body line stroke happened before the first label fillText: labels
      // ride on top of all connector lines (JP-353).
      expect(strokeOrders.length).toBeGreaterThan(0);
      expect(labelOrders.length).toBeGreaterThan(0);
      expect(Math.max(...strokeOrders)).toBeLessThan(Math.min(...labelOrders));
    });

    it('render() no longer draws the label inline (it is deferred)', () => {
      const { canvas, ctx } = createRecordingCanvas();
      const camera = new Camera();
      camera.setViewport(800, 600);
      const renderer = new Renderer(canvas, camera, { showGrid: false });

      // Sanity: connectorHandler exposes the deferred hook.
      expect(typeof connectorHandler.renderOverlay).toBe('function');

      renderer.setShapes({ a: connector('a', 'ONLY', [-50, 0, 50, 0]) }, ['a']);
      renderer.renderNow();

      // The label is still drawn (in the overlay pass) exactly once.
      const onlyCalls = ctx.fillText.mock.calls.filter((c) => c[0] === 'ONLY');
      expect(onlyCalls).toHaveLength(1);
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
