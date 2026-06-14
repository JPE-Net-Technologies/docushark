import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InputHandler, NormalizedPointerEvent } from './InputHandler';
import { Camera } from './Camera';
import { Vec2 } from '../math/Vec2';

/** Extended mock canvas type with test helpers */
interface MockCanvas extends HTMLCanvasElement {
  _dispatch: (type: string, event: Event) => void;
  _getListeners: () => Record<string, EventListener[]>;
}

// Mock canvas element
function createMockCanvas(): MockCanvas {
  const listeners: Record<string, EventListener[]> = {};

  const canvas = {
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      if (!listeners[type]) listeners[type] = [];
      listeners[type]!.push(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener) => {
      const typeListeners = listeners[type];
      if (typeListeners) {
        const index = typeListeners.indexOf(listener);
        if (index !== -1) typeListeners.splice(index, 1);
      }
    }),
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    focus: vi.fn(),
    getBoundingClientRect: vi.fn(() => ({
      left: 0,
      top: 0,
      width: 800,
      height: 600,
      right: 800,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => {},
    })),
    // Helper to dispatch events
    _dispatch: (type: string, event: Event) => {
      const typeListeners = listeners[type];
      if (typeListeners) {
        for (const listener of typeListeners) {
          listener(event);
        }
      }
    },
    _getListeners: () => listeners,
  } as unknown as MockCanvas;

  return canvas;
}

// Create a mock pointer event
function createPointerEvent(
  type: string,
  options: Partial<PointerEventInit> & {
    clientX?: number;
    clientY?: number;
  } = {}
): PointerEvent {
  const defaults: PointerEventInit = {
    pointerId: 1,
    isPrimary: true,
    button: 0,
    buttons: type === 'pointermove' ? 1 : 0,
    pressure: 0.5,
    pointerType: 'mouse',
    clientX: 100,
    clientY: 100,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    bubbles: true,
    cancelable: true,
  };

  return new PointerEvent(type, { ...defaults, ...options });
}

// Create a mock wheel event
function createWheelEvent(options: Partial<WheelEventInit> = {}): WheelEvent {
  const defaults: WheelEventInit = {
    deltaX: 0,
    deltaY: -100,
    deltaMode: 0, // DOM_DELTA_PIXEL
    clientX: 400,
    clientY: 300,
    bubbles: true,
    cancelable: true,
  };

  return new WheelEvent('wheel', { ...defaults, ...options });
}

// Create a mock keyboard event
function createKeyboardEvent(
  type: string,
  options: Partial<KeyboardEventInit> = {}
): KeyboardEvent {
  const defaults: KeyboardEventInit = {
    key: 'a',
    code: 'KeyA',
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    bubbles: true,
    cancelable: true,
  };

  return new KeyboardEvent(type, { ...defaults, ...options });
}

/** Helper to get the first argument from the first call of a mock function */
function getFirstCallArg<T>(mockFn: ReturnType<typeof vi.fn>): T {
  const calls = mockFn.mock.calls;
  if (calls.length === 0) throw new Error('Mock was not called');
  const firstCall = calls[0];
  if (!firstCall || firstCall.length === 0) throw new Error('First call has no arguments');
  return firstCall[0] as T;
}

/** Helper to get all arguments from the first call of a mock function */
function getFirstCallArgs(mockFn: ReturnType<typeof vi.fn>): unknown[] {
  const calls = mockFn.mock.calls;
  if (calls.length === 0) throw new Error('Mock was not called');
  const firstCall = calls[0];
  if (!firstCall) throw new Error('First call is undefined');
  return firstCall;
}

describe('InputHandler', () => {
  let canvas: MockCanvas;
  let camera: Camera;
  let pointerCallback: ReturnType<typeof vi.fn>;
  let keyCallback: ReturnType<typeof vi.fn>;
  let wheelCallback: ReturnType<typeof vi.fn>;
  let handler: InputHandler;

  beforeEach(() => {
    canvas = createMockCanvas();
    camera = new Camera();
    camera.setViewport(800, 600);

    pointerCallback = vi.fn();
    keyCallback = vi.fn();
    wheelCallback = vi.fn();

    handler = new InputHandler(
      canvas,
      camera,
      pointerCallback,
      keyCallback,
      wheelCallback
    );
  });

  afterEach(() => {
    handler.destroy();
  });

  describe('constructor', () => {
    it('attaches all event listeners', () => {
      expect(canvas.addEventListener).toHaveBeenCalledWith(
        'pointerdown',
        expect.any(Function)
      );
      expect(canvas.addEventListener).toHaveBeenCalledWith(
        'pointermove',
        expect.any(Function)
      );
      expect(canvas.addEventListener).toHaveBeenCalledWith(
        'pointerup',
        expect.any(Function)
      );
      expect(canvas.addEventListener).toHaveBeenCalledWith(
        'pointercancel',
        expect.any(Function)
      );
      expect(canvas.addEventListener).toHaveBeenCalledWith(
        'wheel',
        expect.any(Function),
        { passive: false }
      );
      expect(canvas.addEventListener).toHaveBeenCalledWith(
        'keydown',
        expect.any(Function)
      );
      expect(canvas.addEventListener).toHaveBeenCalledWith(
        'keyup',
        expect.any(Function)
      );
      expect(canvas.addEventListener).toHaveBeenCalledWith(
        'contextmenu',
        expect.any(Function)
      );
    });
  });

  describe('destroy', () => {
    it('removes all event listeners', () => {
      handler.destroy();

      expect(canvas.removeEventListener).toHaveBeenCalledWith(
        'pointerdown',
        expect.any(Function)
      );
      expect(canvas.removeEventListener).toHaveBeenCalledWith(
        'pointermove',
        expect.any(Function)
      );
      expect(canvas.removeEventListener).toHaveBeenCalledWith(
        'pointerup',
        expect.any(Function)
      );
      expect(canvas.removeEventListener).toHaveBeenCalledWith(
        'pointercancel',
        expect.any(Function)
      );
      expect(canvas.removeEventListener).toHaveBeenCalledWith(
        'wheel',
        expect.any(Function)
      );
      expect(canvas.removeEventListener).toHaveBeenCalledWith(
        'keydown',
        expect.any(Function)
      );
      expect(canvas.removeEventListener).toHaveBeenCalledWith(
        'keyup',
        expect.any(Function)
      );
      expect(canvas.removeEventListener).toHaveBeenCalledWith(
        'contextmenu',
        expect.any(Function)
      );
    });

    it('releases captured pointers', () => {
      // Trigger pointer down to capture
      const downEvent = createPointerEvent('pointerdown', { pointerId: 42 });
      canvas._dispatch('pointerdown', downEvent);

      expect(canvas.setPointerCapture).toHaveBeenCalledWith(42);

      handler.destroy();

      expect(canvas.releasePointerCapture).toHaveBeenCalledWith(42);
    });

    it('does nothing on second destroy call', () => {
      handler.destroy();
      const removeCallCount = (canvas.removeEventListener as ReturnType<typeof vi.fn>).mock.calls.length;

      handler.destroy();

      expect((canvas.removeEventListener as ReturnType<typeof vi.fn>).mock.calls.length).toBe(removeCallCount);
    });

    it('stops handling events after destroy', () => {
      handler.destroy();

      const downEvent = createPointerEvent('pointerdown');
      canvas._dispatch('pointerdown', downEvent);

      expect(pointerCallback).not.toHaveBeenCalled();
    });
  });

  describe('pointer events', () => {
    it('normalizes pointer down event', () => {
      const event = createPointerEvent('pointerdown', {
        clientX: 100,
        clientY: 50,
        pointerId: 1,
        isPrimary: true,
        button: 0,
        pressure: 0.8,
      });

      canvas._dispatch('pointerdown', event);

      expect(pointerCallback).toHaveBeenCalledTimes(1);
      const normalized = getFirstCallArg<NormalizedPointerEvent>(pointerCallback);

      expect(normalized.type).toBe('down');
      expect(normalized.screenPoint.x).toBe(100);
      expect(normalized.screenPoint.y).toBe(50);
      expect(normalized.button).toBe('left');
      expect(normalized.pointerId).toBe(1);
      expect(normalized.isPrimary).toBe(true);
      expect(normalized.pressure).toBeCloseTo(0.8);
    });

    it('normalizes pointer move event', () => {
      const event = createPointerEvent('pointermove', {
        clientX: 200,
        clientY: 150,
        buttons: 1, // Left button held
      });

      canvas._dispatch('pointermove', event);

      expect(pointerCallback).toHaveBeenCalledTimes(1);
      const normalized = getFirstCallArg<NormalizedPointerEvent>(pointerCallback);

      expect(normalized.type).toBe('move');
      expect(normalized.screenPoint.x).toBe(200);
      expect(normalized.screenPoint.y).toBe(150);
      expect(normalized.button).toBe('left');
    });

    it('normalizes pointer up event', () => {
      const event = createPointerEvent('pointerup', {
        clientX: 300,
        clientY: 250,
      });

      canvas._dispatch('pointerup', event);

      expect(pointerCallback).toHaveBeenCalledTimes(1);
      const normalized = getFirstCallArg<NormalizedPointerEvent>(pointerCallback);

      expect(normalized.type).toBe('up');
      expect(normalized.screenPoint.x).toBe(300);
      expect(normalized.screenPoint.y).toBe(250);
    });

    it('converts screen to world coordinates', () => {
      // Camera at (100, 50) with zoom 2
      camera.setState({ x: 100, y: 50, zoom: 2 });

      const event = createPointerEvent('pointerdown', {
        clientX: 400, // screen center
        clientY: 300,
      });

      canvas._dispatch('pointerdown', event);

      const normalized = getFirstCallArg<NormalizedPointerEvent>(pointerCallback);

      // Screen center (400, 300) should map to camera position (100, 50)
      expect(normalized.worldPoint.x).toBeCloseTo(100);
      expect(normalized.worldPoint.y).toBeCloseTo(50);
    });

    it('captures pointer on down', () => {
      const event = createPointerEvent('pointerdown', { pointerId: 5 });
      canvas._dispatch('pointerdown', event);

      expect(canvas.setPointerCapture).toHaveBeenCalledWith(5);
    });

    it('releases pointer on up', () => {
      // First capture
      const downEvent = createPointerEvent('pointerdown', { pointerId: 5 });
      canvas._dispatch('pointerdown', downEvent);

      // Then release
      const upEvent = createPointerEvent('pointerup', { pointerId: 5 });
      canvas._dispatch('pointerup', upEvent);

      expect(canvas.releasePointerCapture).toHaveBeenCalledWith(5);
    });

    it('releases pointer on cancel', () => {
      const downEvent = createPointerEvent('pointerdown', { pointerId: 7 });
      canvas._dispatch('pointerdown', downEvent);

      const cancelEvent = createPointerEvent('pointercancel', { pointerId: 7 });
      canvas._dispatch('pointercancel', cancelEvent);

      expect(canvas.releasePointerCapture).toHaveBeenCalledWith(7);
    });

    it('focuses canvas on pointer down', () => {
      const event = createPointerEvent('pointerdown');
      canvas._dispatch('pointerdown', event);

      expect(canvas.focus).toHaveBeenCalled();
    });

    describe('button detection', () => {
      it('detects left button', () => {
        const event = createPointerEvent('pointerdown', { button: 0 });
        canvas._dispatch('pointerdown', event);

        const normalized = getFirstCallArg<NormalizedPointerEvent>(pointerCallback);
        expect(normalized.button).toBe('left');
      });

      it('detects middle button', () => {
        const event = createPointerEvent('pointerdown', { button: 1 });
        canvas._dispatch('pointerdown', event);

        const normalized = getFirstCallArg<NormalizedPointerEvent>(pointerCallback);
        expect(normalized.button).toBe('middle');
      });

      it('detects right button', () => {
        const event = createPointerEvent('pointerdown', { button: 2 });
        canvas._dispatch('pointerdown', event);

        const normalized = getFirstCallArg<NormalizedPointerEvent>(pointerCallback);
        expect(normalized.button).toBe('right');
      });

      it('detects button from buttons bitmask on move', () => {
        // Middle button held during move
        const event = createPointerEvent('pointermove', { buttons: 4 });
        canvas._dispatch('pointermove', event);

        const normalized = getFirstCallArg<NormalizedPointerEvent>(pointerCallback);
        expect(normalized.button).toBe('middle');
      });

      it('returns none when no button pressed on move', () => {
        const event = createPointerEvent('pointermove', { buttons: 0 });
        canvas._dispatch('pointermove', event);

        const normalized = getFirstCallArg<NormalizedPointerEvent>(pointerCallback);
        expect(normalized.button).toBe('none');
      });

      it('left button takes priority when multiple buttons pressed on move', () => {
        // Left (1) + Right (2) = 3
        const event = createPointerEvent('pointermove', { buttons: 3 });
        canvas._dispatch('pointermove', event);

        const normalized = getFirstCallArg<NormalizedPointerEvent>(pointerCallback);
        expect(normalized.button).toBe('left');
      });

      it('right button detected on move when only right is pressed', () => {
        const event = createPointerEvent('pointermove', { buttons: 2 });
        canvas._dispatch('pointermove', event);

        const normalized = getFirstCallArg<NormalizedPointerEvent>(pointerCallback);
        expect(normalized.button).toBe('right');
      });
    });

    describe('modifier keys', () => {
      it('detects shift key', () => {
        const event = createPointerEvent('pointerdown', { shiftKey: true });
        canvas._dispatch('pointerdown', event);

        const normalized = getFirstCallArg<NormalizedPointerEvent>(pointerCallback);
        expect(normalized.modifiers.shift).toBe(true);
        expect(normalized.modifiers.ctrl).toBe(false);
      });

      it('detects ctrl key', () => {
        const event = createPointerEvent('pointerdown', { ctrlKey: true });
        canvas._dispatch('pointerdown', event);

        const normalized = getFirstCallArg<NormalizedPointerEvent>(pointerCallback);
        expect(normalized.modifiers.ctrl).toBe(true);
      });

      it('detects alt key', () => {
        const event = createPointerEvent('pointerdown', { altKey: true });
        canvas._dispatch('pointerdown', event);

        const normalized = getFirstCallArg<NormalizedPointerEvent>(pointerCallback);
        expect(normalized.modifiers.alt).toBe(true);
      });

      it('detects meta key', () => {
        const event = createPointerEvent('pointerdown', { metaKey: true });
        canvas._dispatch('pointerdown', event);

        const normalized = getFirstCallArg<NormalizedPointerEvent>(pointerCallback);
        expect(normalized.modifiers.meta).toBe(true);
      });

      it('detects multiple modifiers', () => {
        const event = createPointerEvent('pointerdown', {
          shiftKey: true,
          ctrlKey: true,
        });
        canvas._dispatch('pointerdown', event);

        const normalized = getFirstCallArg<NormalizedPointerEvent>(pointerCallback);
        expect(normalized.modifiers.shift).toBe(true);
        expect(normalized.modifiers.ctrl).toBe(true);
        expect(normalized.modifiers.alt).toBe(false);
        expect(normalized.modifiers.meta).toBe(false);
      });
    });

    describe('pressure', () => {
      it('passes through pen pressure', () => {
        const event = createPointerEvent('pointerdown', {
          pressure: 0.7,
          pointerType: 'pen',
        });
        canvas._dispatch('pointerdown', event);

        const normalized = getFirstCallArg<NormalizedPointerEvent>(pointerCallback);
        expect(normalized.pressure).toBeCloseTo(0.7);
      });

      it('uses 0.5 for mouse with button pressed', () => {
        const event = createPointerEvent('pointerdown', {
          pressure: 0,
          pointerType: 'mouse',
          buttons: 1,
        });
        canvas._dispatch('pointerdown', event);

        const normalized = getFirstCallArg<NormalizedPointerEvent>(pointerCallback);
        expect(normalized.pressure).toBe(0.5);
      });

      it('uses 0 for mouse with no button pressed', () => {
        const event = createPointerEvent('pointermove', {
          pressure: 0,
          pointerType: 'mouse',
          buttons: 0,
        });
        canvas._dispatch('pointermove', event);

        const normalized = getFirstCallArg<NormalizedPointerEvent>(pointerCallback);
        expect(normalized.pressure).toBe(0);
      });
    });

    it('includes original event', () => {
      const event = createPointerEvent('pointerdown');
      canvas._dispatch('pointerdown', event);

      const normalized = getFirstCallArg<NormalizedPointerEvent>(pointerCallback);
      expect(normalized.originalEvent).toBe(event);
    });

    it('includes timestamp', () => {
      const event = createPointerEvent('pointerdown');
      canvas._dispatch('pointerdown', event);

      const normalized = getFirstCallArg<NormalizedPointerEvent>(pointerCallback);
      expect(typeof normalized.timestamp).toBe('number');
    });
  });

  describe('wheel events', () => {
    it('calls wheel callback with screen and world points', () => {
      const event = createWheelEvent({
        clientX: 400,
        clientY: 300,
        deltaY: -100,
      });

      canvas._dispatch('wheel', event);

      expect(wheelCallback).toHaveBeenCalledTimes(1);
      const [_wheelEvent, screenPoint, worldPoint] = getFirstCallArgs(wheelCallback) as [WheelEvent, Vec2, Vec2];

      expect(screenPoint).toBeInstanceOf(Vec2);
      expect(worldPoint).toBeInstanceOf(Vec2);
      // Screen point should be canvas-relative (400 - 0, 300 - 0)
      expect(screenPoint.x).toBeCloseTo(400);
      expect(screenPoint.y).toBeCloseTo(300);
      // Screen center should map to camera position (0, 0)
      expect(worldPoint.x).toBeCloseTo(0);
      expect(worldPoint.y).toBeCloseTo(0);
    });

    it('prevents default on wheel', () => {
      const event = createWheelEvent();
      const preventDefault = vi.spyOn(event, 'preventDefault');

      canvas._dispatch('wheel', event);

      expect(preventDefault).toHaveBeenCalled();
    });

    it('normalizes line-based delta (Firefox)', () => {
      const event = createWheelEvent({
        deltaY: 3, // 3 lines
        deltaMode: 1, // DOM_DELTA_LINE
      });

      canvas._dispatch('wheel', event);

      const [normalizedEvent] = getFirstCallArgs(wheelCallback) as [WheelEvent];
      // 3 lines * 20 pixels/line = 60 pixels
      expect(normalizedEvent.deltaY).toBe(60);
      expect(normalizedEvent.deltaMode).toBe(0); // DOM_DELTA_PIXEL
    });

    it('normalizes page-based delta', () => {
      const event = createWheelEvent({
        deltaY: 1, // 1 page
        deltaMode: 2, // DOM_DELTA_PAGE
      });

      canvas._dispatch('wheel', event);

      const [normalizedEvent] = getFirstCallArgs(wheelCallback) as [WheelEvent];
      // 1 page * 800 pixels/page = 800 pixels
      expect(normalizedEvent.deltaY).toBe(800);
    });

    it('passes through pixel-based delta unchanged', () => {
      const event = createWheelEvent({
        deltaY: -120,
        deltaMode: 0, // DOM_DELTA_PIXEL
      });

      canvas._dispatch('wheel', event);

      const [normalizedEvent] = getFirstCallArgs(wheelCallback) as [WheelEvent];
      expect(normalizedEvent.deltaY).toBe(-120);
    });
  });

  describe('keyboard events', () => {
    it('forwards keydown events', () => {
      const event = createKeyboardEvent('keydown', { key: 'Delete' });
      canvas._dispatch('keydown', event);

      expect(keyCallback).toHaveBeenCalledTimes(1);
      expect(keyCallback).toHaveBeenCalledWith(event);
    });

    it('forwards keyup events', () => {
      const event = createKeyboardEvent('keyup', { key: 'Shift' });
      canvas._dispatch('keyup', event);

      expect(keyCallback).toHaveBeenCalledTimes(1);
      expect(keyCallback).toHaveBeenCalledWith(event);
    });

    it('includes modifier keys in keyboard events', () => {
      const event = createKeyboardEvent('keydown', {
        key: 'z',
        ctrlKey: true,
      });
      canvas._dispatch('keydown', event);

      const receivedEvent = getFirstCallArg<KeyboardEvent>(keyCallback);
      expect(receivedEvent.ctrlKey).toBe(true);
      expect(receivedEvent.key).toBe('z');
    });
  });

  describe('context menu', () => {
    it('prevents default on context menu', () => {
      const event = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
      });
      const preventDefault = vi.spyOn(event, 'preventDefault');

      canvas._dispatch('contextmenu', event);

      expect(preventDefault).toHaveBeenCalled();
    });
  });

  describe('setCamera', () => {
    it('updates camera reference', () => {
      const newCamera = new Camera({ x: 500, y: 500, zoom: 0.5 });
      newCamera.setViewport(800, 600);

      handler.setCamera(newCamera);

      const event = createPointerEvent('pointerdown', {
        clientX: 400,
        clientY: 300,
      });
      canvas._dispatch('pointerdown', event);

      const normalized = getFirstCallArg<NormalizedPointerEvent>(pointerCallback);

      // Screen center should now map to new camera position
      expect(normalized.worldPoint.x).toBeCloseTo(500);
      expect(normalized.worldPoint.y).toBeCloseTo(500);
    });
  });

  describe('canvas offset handling', () => {
    it('accounts for canvas position in viewport', () => {
      // Canvas positioned at (50, 100) from viewport
      (canvas.getBoundingClientRect as ReturnType<typeof vi.fn>).mockReturnValue({
        left: 50,
        top: 100,
        width: 800,
        height: 600,
        right: 850,
        bottom: 700,
        x: 50,
        y: 100,
        toJSON: () => {},
      });

      const event = createPointerEvent('pointerdown', {
        clientX: 450, // 400 relative to canvas
        clientY: 400, // 300 relative to canvas
      });
      canvas._dispatch('pointerdown', event);

      const normalized = getFirstCallArg<NormalizedPointerEvent>(pointerCallback);

      // Should be (400, 300) in canvas space
      expect(normalized.screenPoint.x).toBe(400);
      expect(normalized.screenPoint.y).toBe(300);
    });
  });

  describe('two-finger pan (JP-307 Slice 4)', () => {
    it('pans the camera on a two-finger translation (zoom unchanged)', () => {
      // camera starts at (0,0) zoom 1, viewport 800x600 (beforeEach).
      // Two fingers down 200px apart → starts the pinch/pan gesture.
      canvas._dispatch('pointerdown', createPointerEvent('pointerdown', { pointerId: 1, clientX: 200, clientY: 300 }));
      canvas._dispatch('pointerdown', createPointerEvent('pointerdown', { pointerId: 2, clientX: 400, clientY: 300 }));
      // Translate both fingers +50px in x (one at a time) so their final
      // distance is unchanged (net zoom ~1) but the midpoint moved right.
      canvas._dispatch('pointermove', createPointerEvent('pointermove', { pointerId: 1, clientX: 250, clientY: 300 }));
      canvas._dispatch('pointermove', createPointerEvent('pointermove', { pointerId: 2, clientX: 450, clientY: 300 }));

      // Net: zoom returns to 1, camera panned by the 50px midpoint shift
      // (camera.x decreases for a rightward content shift). Pre-Slice-4 this
      // gesture only zoomed and would have left the camera at x≈0.
      expect(camera.zoom).toBeCloseTo(1, 5);
      expect(camera.x).toBeCloseTo(-50, 1);
      expect(camera.y).toBeCloseTo(0, 5);
    });

    it('does not pan the camera on a single-finger move (stays a select drag)', () => {
      const startX = camera.x;
      const startY = camera.y;
      canvas._dispatch('pointerdown', createPointerEvent('pointerdown', { pointerId: 1, clientX: 200, clientY: 300 }));
      canvas._dispatch('pointermove', createPointerEvent('pointermove', { pointerId: 1, clientX: 260, clientY: 360 }));
      // One finger never enters the pinch/pan branch — forwarded to the tool as
      // a normal pointer move; the camera is untouched.
      expect(camera.x).toBe(startX);
      expect(camera.y).toBe(startY);
    });
  });
});
