/**
 * Zoom for the canvas's own controls (DSK-211).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionStore } from '../store/sessionStore';
import { useDocumentStore } from '../store/documentStore';
import type { RectangleShape } from '../shapes/Shape';
import { fitCamera, peekOverview, zoomIn, zoomOut, zoomTo100, zoomToFit } from './canvasZoom';
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
