/**
 * The session store follows the engine's camera (DSK-212). The wheel, the Pan
 * tool, the keys and an import's zoom to fit move the engine's camera directly;
 * the next drawn frame tells the store, so the zoom pill, the minimap and
 * collaborators' cursors keep up with what's on screen.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Engine } from './Engine';
import { useSessionStore } from '../store/sessionStore';
import { Vec2 } from '../math/Vec2';

/** A 2D context that takes any call and draws nothing: jsdom has none. */
function stubContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const target = () => undefined;
  const stub: unknown = new Proxy(target, {
    get: (_target, prop) => {
      if (prop === 'canvas') return canvas;
      if (prop === 'measureText') return () => ({ width: 0, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0 });
      if (prop === 'valueOf') return () => 0;
      if (prop === 'toString') return () => '';
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return stub;
    },
    set: () => true,
    apply: () => stub,
  });
  return stub as CanvasRenderingContext2D;
}

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
const runFrame = () => {
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach((callback) => callback(performance.now()));
};

let engine: Engine;
const storeCamera = () => {
  const { x, y, zoom } = useSessionStore.getState().camera;
  return { x, y, zoom };
};

beforeEach(() => {
  frames = new Map();
  nextFrame = 1;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(nextFrame, callback);
    return nextFrame++;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  useSessionStore.getState().setCamera({ x: 0, y: 0, zoom: 1 });
  const canvas = document.createElement('canvas');
  vi.spyOn(canvas, 'getContext').mockReturnValue(stubContext(canvas) as unknown as RenderingContext);
  engine = new Engine(canvas);
  runFrame();
});

afterEach(() => {
  engine.destroy();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the session store follows the engine camera (DSK-212)', () => {
  it('learns where the camera is on the next frame, however it moved', () => {
    // As the wheel and the Pan tool do: move the camera, ask the renderer for a frame.
    engine.camera.pan(new Vec2(-120, -40));
    engine.renderer.requestRender();
    expect(storeCamera()).toEqual({ x: 0, y: 0, zoom: 1 });

    runFrame();
    expect(storeCamera()).toEqual({ x: engine.camera.x, y: engine.camera.y, zoom: 1 });
    expect(storeCamera().x).not.toBe(0);
  });

  it('leaves an eased zoom heading for its target', () => {
    const focus = new Vec2(100, 100);
    engine.camera.setTargetZoom(focus, 2);
    engine.camera.updateZoom(focus, 0.2); // one step of the ease
    engine.renderer.requestRender();
    runFrame();

    expect(storeCamera().zoom).toBe(engine.camera.zoom);
    expect(engine.camera.targetZoom).toBe(2);
  });

  it('still follows the store when something else sets the camera', () => {
    useSessionStore.getState().setCamera({ x: 300, y: -20, zoom: 1.5 });
    expect({ x: engine.camera.x, y: engine.camera.y, zoom: engine.camera.zoom }).toEqual({ x: 300, y: -20, zoom: 1.5 });
  });

  it("doesn't take back a move the store hasn't caught up with when something unrelated changes", () => {
    engine.camera.pan(new Vec2(-120, -40));
    const moved = { x: engine.camera.x, y: engine.camera.y };
    useSessionStore.getState().setCursor('crosshair');
    expect({ x: engine.camera.x, y: engine.camera.y }).toEqual(moved);
  });
});
