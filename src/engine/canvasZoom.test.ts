/**
 * Zoom for the canvas's own controls (DSK-211).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useSessionStore } from '../store/sessionStore';
import { useDocumentStore } from '../store/documentStore';
import { setMotionPreference } from '../platform/adaptiveBudget';
import type { RectangleShape } from '../shapes/Shape';
import { GLIDE_MS, fitCamera, glideCamera, peekOverview, zoomIn, zoomOut, zoomTo100, zoomToFit } from './canvasZoom';
import '../shapes/Rectangle';

const camera = () => {
  const { x, y, zoom } = useSessionStore.getState().camera;
  return { x, y, zoom };
};

const rect: RectangleShape = {
  id: 'r1',
  type: 'rectangle',
  x: 100,
  y: 100,
  width: 50,
  height: 50,
  cornerRadius: 0,
  rotation: 0,
  opacity: 1,
  locked: false,
  visible: true,
  fill: '#ffffff',
  stroke: '#000000',
  strokeWidth: 0,
};

beforeEach(() => {
  useSessionStore.getState().setCamera({ x: 0, y: 0, zoom: 1 });
  useDocumentStore.setState({ shapes: {}, shapeOrder: [] });
});

describe('canvas zoom (DSK-211)', () => {
  it('steps through the presets, and resets to 100%', () => {
    zoomIn();
    expect(camera().zoom).toBe(1.5);
    zoomOut();
    zoomOut();
    expect(camera().zoom).toBe(0.75);
    zoomTo100();
    expect(camera().zoom).toBe(1);
  });

  it('frames an empty canvas at the origin, at 100%', () => {
    useSessionStore.getState().setCamera({ x: 50, y: 50, zoom: 3 });
    zoomToFit();
    expect(camera()).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it('frames every shape around its centre, never closer than 2x', () => {
    useDocumentStore.setState({ shapes: { r1: rect }, shapeOrder: ['r1'] });
    expect(fitCamera()).toEqual({ x: 100, y: 100, zoom: 2 });
  });

  it('peeks at everything, then puts the camera back exactly', () => {
    useDocumentStore.setState({ shapes: { r1: rect }, shapeOrder: ['r1'] });
    useSessionStore.getState().setCamera({ x: 300, y: -40, zoom: 1.5 });

    const restore = peekOverview();
    expect(camera()).toEqual({ x: 100, y: 100, zoom: 2 });
    restore();
    expect(camera()).toEqual({ x: 300, y: -40, zoom: 1.5 });
  });
});

describe('glideCamera (DSK-212)', () => {
  // Frames run when the test says, at the time it says.
  let frames: Map<number, FrameRequestCallback>;
  let nextId: number;
  const runFrame = (time: number) => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(time));
  };

  beforeEach(() => {
    frames = new Map();
    nextId = 1;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(nextId, callback);
      return nextId++;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    // Pinned, so a low-power test machine doesn't reduce motion on its own.
    setMotionPreference('full');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setMotionPreference('system');
  });

  it('eases to the point over a moment, and stops there however late the last frame is', () => {
    glideCamera({ x: 100, y: -50 });
    runFrame(1000);
    expect(camera()).toEqual({ x: 0, y: 0, zoom: 1 });
    runFrame(1000 + GLIDE_MS / 2);
    // Ease out: past halfway at half time.
    expect(camera().x).toBeCloseTo(87.5);
    expect(camera().y).toBeCloseTo(-43.75);
    runFrame(1000 + GLIDE_MS + 30);
    expect(camera()).toEqual({ x: 100, y: -50, zoom: 1 });
    expect(frames.size).toBe(0);
  });

  it('goes straight there with reduced motion', () => {
    setMotionPreference('reduced');
    glideCamera({ x: 100, y: -50 });
    expect(camera()).toEqual({ x: 100, y: -50, zoom: 1 });
    expect(frames.size).toBe(0);
  });

  it('lets a new glide replace one in progress', () => {
    glideCamera({ x: 100, y: 0 });
    runFrame(1000);
    runFrame(1000 + GLIDE_MS / 2);
    glideCamera({ x: 0, y: 200 });
    runFrame(2000);
    runFrame(2000 + GLIDE_MS);
    expect(camera().x).toBeCloseTo(0);
    expect(camera().y).toBeCloseTo(200);
  });

  it.each(['x', 'y'] as const)('gives way when something else moves the view mid-glide (%s)', (axis) => {
    glideCamera({ x: 100, y: 100 });
    runFrame(1000);
    runFrame(1000 + GLIDE_MS / 2);
    useSessionStore.getState().setCamera({ [axis]: 500 });
    const taken = camera();
    runFrame(1000 + GLIDE_MS);
    expect(camera()).toEqual(taken);
    expect(frames.size).toBe(0);
  });

  it('carries on through a zoom, which leaves the centre alone', () => {
    glideCamera({ x: 100, y: 0 });
    runFrame(1000);
    useSessionStore.getState().setCamera({ zoom: 2 });
    runFrame(1000 + GLIDE_MS);
    expect(camera()).toEqual({ x: 100, y: 0, zoom: 2 });
  });
});
