/**
 * The minimap's interactions (DSK-212). jsdom has no 2D canvas context, so a
 * fake one records the drawing. The geometry it draws with is tested in
 * minimapGeometry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

vi.mock('../engine/canvasZoom', () => ({ glideCamera: vi.fn() }));

import { glideCamera } from '../engine/canvasZoom';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { useDocumentStore } from '../store/documentStore';
import { useThemeStore } from '../store/themeStore';
import { shapeRegistry } from '../shapes/ShapeRegistry';
import type { ConnectorShape, LineShape, RectangleShape } from '../shapes/Shape';
import { Vec2 } from '../math/Vec2';
import { Minimap, MAP_HEIGHT, MAP_WIDTH } from './Minimap';
import { fitFrame, mapWorld, viewportRect, worldToMap, type MapFrame, type Point } from './minimapGeometry';
import '../shapes/Rectangle';
import '../shapes/Line';

const SCREEN = { width: 800, height: 600 };
const camera = () => {
  const { x, y, zoom } = useSessionStore.getState().camera;
  return { x, y, zoom };
};

// A rectangle well to the right of the view, so the map frames both.
const rect: RectangleShape = {
  id: 'r1', type: 'rectangle', x: 1000, y: 0, width: 200, height: 200, cornerRadius: 0,
  rotation: 0, opacity: 1, locked: false, visible: true, fill: '#ffffff', stroke: '#000000', strokeWidth: 0,
};

/** The frame the map starts with, built the way the component builds it. */
function initialFrame(): MapFrame {
  const box = shapeRegistry.getHandler('rectangle').getBounds(rect);
  const content = { minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY };
  return fitFrame(mapWorld(content, viewportRect(camera(), SCREEN.width, SCREEN.height)), MAP_WIDTH, MAP_HEIGHT);
}

function renderMap() {
  render(<Minimap canvasWidth={SCREEN.width} canvasHeight={SCREEN.height} />);
  const map = screen.getByRole('application', { name: /Minimap/ });
  map.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: MAP_WIDTH, bottom: MAP_HEIGHT, width: MAP_WIDTH, height: MAP_HEIGHT, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  return map;
}

const at = (p: Point) => ({ clientX: p.x, clientY: p.y, button: 0, pointerId: 1 });

function fakeContext() {
  return {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    rect: vi.fn(),
    fill: vi.fn(),
    ellipse: vi.fn(),
    setLineDash: vi.fn(),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
  };
}
let ctx: ReturnType<typeof fakeContext>;

beforeEach(() => {
  useSettingsStore.getState().setShowMinimap(true);
  useSessionStore.getState().setCamera({ x: 0, y: 0, zoom: 1 });
  useSessionStore.setState({ selectedIds: new Set<string>() });
  useDocumentStore.setState({ shapes: { r1: rect }, shapeOrder: ['r1'] });
  vi.mocked(glideCamera).mockClear();
  ctx = fakeContext();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as RenderingContext);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Minimap (DSK-212)', () => {
  it('pans while the viewport box is dragged by its grip, with the map holding still', () => {
    const map = renderMap();
    const frame = initialFrame();
    // Off the box's centre, so the grip offset counts.
    const grip = worldToMap(frame, { x: 0, y: 0 });
    grip.x += 5;
    grip.y += 3;

    // Handled, so the press doesn't start a text selection or a native drag.
    expect(fireEvent.pointerDown(map, at(grip))).toBe(false);
    fireEvent.pointerMove(window, at({ x: grip.x + 10, y: grip.y }));
    expect(camera().x).toBeCloseTo(10 / frame.scale);
    expect(camera().y).toBeCloseTo(0);
    // Far enough to leave the frame the map started with; still measured
    // against it, and drawn in it, so the box stays under the pointer.
    fireEvent.pointerMove(window, at({ x: grip.x + 150, y: grip.y }));
    expect(camera().x).toBeCloseTo(150 / frame.scale);
    const [boxX, , boxWidth] = ctx.strokeRect.mock.lastCall as number[];
    expect(boxX! + boxWidth! / 2).toBeCloseTo(grip.x - 5 + 150);

    fireEvent.pointerUp(window, at({ x: grip.x + 150, y: grip.y }));
    fireEvent.pointerMove(window, at({ x: grip.x + 160, y: grip.y }));
    expect(camera().x).toBeCloseTo(150 / frame.scale);
    expect(glideCamera).not.toHaveBeenCalled();
  });

  it('glides to a point pressed outside the box, and a drag carries on from there', () => {
    const map = renderMap();
    const frame = initialFrame();
    const point = worldToMap(frame, { x: 1000, y: 0 });
    fireEvent.pointerDown(map, at(point));
    const [target] = vi.mocked(glideCamera).mock.calls[0]!;
    expect(target.x).toBeCloseTo(1000);
    expect(target.y).toBeCloseTo(0);

    // The view's centre follows the pointer from the new spot.
    fireEvent.pointerMove(window, at({ x: point.x + 10, y: point.y }));
    expect(camera().x).toBeCloseTo(1000 + 10 / frame.scale);
    expect(camera().y).toBeCloseTo(0);
  });

  it('shows the box as something to grab', () => {
    const map = renderMap();
    const frame = initialFrame();
    const centre = worldToMap(frame, { x: 0, y: 0 });
    fireEvent.pointerMove(map, at(centre));
    expect(map.style.cursor).toBe('grab');
    fireEvent.pointerDown(map, at(centre));
    expect(map.style.cursor).toBe('grabbing');
    fireEvent.pointerMove(map, at({ x: centre.x + 2, y: centre.y }));
    expect(map.style.cursor).toBe('grabbing');
    fireEvent.pointerUp(window, at({ x: centre.x + 2, y: centre.y }));
    expect(map.style.cursor).toBe('grab');
    fireEvent.pointerMove(map, at(worldToMap(frame, { x: 1000, y: 0 })));
    expect(map.style.cursor).toBe('');
  });

  it('draws connectors and lines along the paths the canvas draws', () => {
    const connector = shapeRegistry.getHandler('connector').create(new Vec2(0, 0), 'c1') as ConnectorShape;
    const straight: ConnectorShape = {
      ...connector,
      x: -200,
      y: 0,
      x2: 200,
      y2: 0,
      routingMode: 'straight',
      waypoints: [{ x: 0, y: -300 }],
    };
    const bent: ConnectorShape = { ...straight, id: 'c2', routingMode: 'orthogonal' };
    const line = shapeRegistry.getHandler('line').create(new Vec2(0, 0), 'l1') as LineShape;
    const turned: LineShape = { ...line, x: 300, y: 0, x2: 500, y2: 0, rotation: Math.PI / 2 };
    useDocumentStore.setState({ shapes: { c1: straight, c2: bent, l1: turned }, shapeOrder: ['c1', 'c2', 'l1'] });
    renderMap();

    // Straight ignores a leftover bend, as the canvas does; Orthogonal follows it.
    expect(ctx.moveTo).toHaveBeenCalledTimes(3);
    expect(ctx.lineTo).toHaveBeenCalledTimes(4);
    // The line is turned a quarter about its middle, so it runs up and down.
    const [startX, startY] = ctx.moveTo.mock.calls[2] as [number, number];
    const [endX, endY] = ctx.lineTo.mock.calls[3] as [number, number];
    expect(endX).toBeCloseTo(startX);
    expect(Math.abs(endY - startY)).toBeGreaterThan(1);
  });

  it('redraws when the theme changes, for its colours', () => {
    const preference = useThemeStore.getState().preference;
    renderMap();
    const draws = ctx.drawImage.mock.calls.length;
    act(() => useThemeStore.getState().setPreference(useThemeStore.getState().resolvedTheme === 'dark' ? 'light' : 'dark'));
    expect(ctx.drawImage.mock.calls.length).toBeGreaterThan(draws);
    act(() => useThemeStore.getState().setPreference(preference));
  });

  it('refits to frame new content that lands outside the map', () => {
    renderMap();
    const boxWidth = () => ctx.strokeRect.mock.lastCall?.[2] as number;
    const before = boxWidth();
    act(() =>
      useDocumentStore.setState({ shapes: { r1: rect, r2: { ...rect, id: 'r2', x: 6000 } }, shapeOrder: ['r1', 'r2'] })
    );
    expect(boxWidth()).toBeLessThan(before / 2);
  });

  it('keeps the box moving while the view moves every frame, as in a glide', () => {
    // Frames run their callbacks in order, skipping any cancelled before its turn,
    // and React settles after each callback, as it does after a real one.
    const queue = new Map<number, FrameRequestCallback>();
    let nextId = 1;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      queue.set(nextId, callback);
      return nextId++;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => queue.delete(id));
    const runFrame = (time: number) => {
      for (const id of [...queue.keys()]) {
        const callback = queue.get(id);
        if (!callback) continue;
        queue.delete(id);
        act(() => callback(time));
      }
    };

    renderMap();
    // Like glideCamera: each step moves the view, then asks for the next frame.
    let steps = 0;
    const step = () => {
      useSessionStore.getState().setCamera({ x: camera().x + 20 });
      if (++steps < 8) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    const boxLefts: number[] = [];
    for (let frame = 1; frame <= 8; frame++) {
      runFrame(frame * 16);
      boxLefts.push((ctx.strokeRect.mock.lastCall as number[])[0]!);
    }
    expect(new Set(boxLefts).size).toBe(8);
  });

  it('redraws the shapes when they, the selection or the frame change, but not on a pan', () => {
    renderMap();
    expect(ctx.rect).toHaveBeenCalledTimes(1);

    act(() => useSessionStore.getState().setCamera({ x: 10 }));
    expect(ctx.drawImage).toHaveBeenCalledTimes(2);
    expect(ctx.rect).toHaveBeenCalledTimes(1);

    act(() => useDocumentStore.setState({ shapes: { r1: { ...rect, fill: '#ff0000' } } }));
    expect(ctx.rect).toHaveBeenCalledTimes(2);

    act(() => useSessionStore.setState({ selectedIds: new Set(['r1']) }));
    expect(ctx.rect).toHaveBeenCalledTimes(3);

    // Zoomed far out, the view leaves the map's frame, which grows to hold it.
    act(() => useSessionStore.getState().setCamera({ zoom: 0.2 }));
    expect(ctx.rect).toHaveBeenCalledTimes(4);
  });

  it('zooms the canvas around the point under the pointer, without scrolling the page', () => {
    const map = renderMap();
    const point = worldToMap(initialFrame(), { x: 1000, y: 0 });
    expect(fireEvent.wheel(map, { deltaY: -100, clientX: point.x, clientY: point.y })).toBe(false);
    const next = camera();
    expect(next.zoom).toBeCloseTo(1.15);
    // The point keeps its place on screen.
    expect((1000 - next.x) * next.zoom).toBeCloseTo(1000);
  });

  it('pans a tenth of the view with the arrow keys, and leaves other keys alone', () => {
    const map = renderMap();
    // Handled, so the page doesn't scroll as well.
    expect(fireEvent.keyDown(map, { key: 'ArrowRight' })).toBe(false);
    expect(camera().x).toBeCloseTo(80);
    fireEvent.keyDown(map, { key: 'ArrowUp' });
    expect(camera().y).toBeCloseTo(-60);
    expect(fireEvent.keyDown(map, { key: 'a' })).toBe(true);
    expect(camera()).toEqual({ x: 80, y: -60, zoom: 1 });
  });

  it.each(['blur', 'pointercancel'])('lets go of a drag on %s', (type) => {
    const map = renderMap();
    const centre = worldToMap(initialFrame(), { x: 0, y: 0 });
    fireEvent.pointerDown(map, at(centre));
    fireEvent(window, new Event(type));
    fireEvent.pointerMove(window, at({ x: centre.x + 10, y: centre.y }));
    expect(camera().x).toBe(0);
  });

  it('lets go of the window when it goes away mid-drag', () => {
    const map = renderMap();
    const centre = worldToMap(initialFrame(), { x: 0, y: 0 });
    fireEvent.pointerDown(map, at(centre));
    cleanup();
    fireEvent.pointerMove(window, at({ x: centre.x + 10, y: centre.y }));
    expect(camera().x).toBe(0);
  });

  it('ignores presses with other buttons', () => {
    const map = renderMap();
    const centre = worldToMap(initialFrame(), { x: 0, y: 0 });
    fireEvent.pointerDown(map, { ...at(worldToMap(initialFrame(), { x: 1000, y: 0 })), button: 2 });
    fireEvent.pointerDown(map, { ...at(centre), button: 2 });
    fireEvent.pointerMove(window, at({ x: centre.x + 10, y: centre.y }));
    expect(glideCamera).not.toHaveBeenCalled();
    expect(camera().x).toBe(0);
  });

  it('is hidden while the setting is off', () => {
    useSettingsStore.getState().setShowMinimap(false);
    render(<Minimap canvasWidth={SCREEN.width} canvasHeight={SCREEN.height} />);
    expect(screen.queryByRole('application')).toBeNull();
  });
});
