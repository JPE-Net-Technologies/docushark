/**
 * Where a colleague's selection box lands (DSK-231). It has to agree with the
 * canvas: the camera is the centre of the viewport.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import '../shapes/Rectangle';
import { useCollaborationStore } from '../collaboration';
import { Camera } from '../engine/Camera';
import { Vec2 } from '../math/Vec2';
import { useDocumentStore } from '../store/documentStore';
import { usePresenceStore, type RemotePresence } from '../store/presenceStore';
import { useSessionStore } from '../store/sessionStore';
import { shapeRegistry } from '../shapes/ShapeRegistry';
import type { Shape } from '../shapes/Shape';
import { SelectionHighlight } from './SelectionHighlight';

const WIDTH = 800;
const HEIGHT = 600;
const PADDING = 4;

const shape = {
  id: 's',
  type: 'rectangle',
  x: 100,
  y: 50,
  width: 80,
  height: 40,
  rotation: 0,
  opacity: 1,
  locked: false,
  visible: true,
  fill: '#123456',
  stroke: null,
  strokeWidth: 0,
  cornerRadius: 0,
} as unknown as Shape;

function box() {
  const element = document.querySelector('.collab-selection-box') as HTMLElement;
  return {
    left: parseFloat(element.style.left),
    top: parseFloat(element.style.top),
    width: parseFloat(element.style.width),
    height: parseFloat(element.style.height),
  };
}

beforeEach(() => {
  useDocumentStore.getState().clear();
  useDocumentStore.getState().addShape(shape);
  useCollaborationStore.setState({ isActive: true });
  usePresenceStore.setState({
    enabled: true,
    remoteUsers: new Map([
      [1, { clientId: 1, userId: 'u', name: 'A colleague', color: '#ff0000', selection: ['s'] } as unknown as RemotePresence],
    ]),
  } as never);
});

afterEach(() => {
  cleanup();
  useCollaborationStore.setState({ isActive: false });
  usePresenceStore.setState({ remoteUsers: new Map() } as never);
  act(() => useSessionStore.getState().setCamera({ x: 0, y: 0, zoom: 1 }));
});

describe('a colleague\'s selection box', () => {
  it('sits on the shape with the camera at rest', () => {
    act(() => useSessionStore.getState().setCamera({ x: 0, y: 0, zoom: 1 }));
    render(<SelectionHighlight width={WIDTH} height={HEIGHT} />);
    // The shape's centre is (100, 50), so its top left is (60, 30), from the middle of the viewport.
    expect(box()).toEqual({
      left: WIDTH / 2 + 60 - PADDING,
      top: HEIGHT / 2 + 30 - PADDING,
      width: 80 + PADDING * 2,
      height: 40 + PADDING * 2,
    });
  });

  it('agrees with the canvas\'s own camera, at any pan and zoom', () => {
    const view = { x: 37, y: -120, zoom: 1.75 };
    act(() => useSessionStore.getState().setCamera(view));
    render(<SelectionHighlight width={WIDTH} height={HEIGHT} />);

    const camera = new Camera();
    camera.setViewport(WIDTH, HEIGHT);
    camera.setState(view);
    const bounds = shapeRegistry.getHandlerForShape(shape).getBounds(shape);
    const corner = camera.worldToScreen(new Vec2(bounds.minX, bounds.minY));

    expect(box().left).toBeCloseTo(corner.x - PADDING);
    expect(box().top).toBeCloseTo(corner.y - PADDING);
    expect(box().width).toBeCloseTo(bounds.width * view.zoom + PADDING * 2);
  });
});
