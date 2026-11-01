/**
 * The canvas's own zoom controls (DSK-211).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { useDocumentStore } from '../store/documentStore';
import { CanvasZoomPill, PEEK_HOLD_MS } from './CanvasZoomPill';

const camera = () => {
  const { x, y, zoom } = useSessionStore.getState().camera;
  return { x, y, zoom };
};
const percent = () => screen.getByLabelText(/^Zoom \d+%/);

beforeEach(() => {
  useSessionStore.getState().setCamera({ x: 300, y: -40, zoom: 3 });
  useDocumentStore.setState({ shapes: {}, shapeOrder: [] });
  useSettingsStore.getState().setShowMinimap(false);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('CanvasZoomPill (DSK-211)', () => {
  it('steps in and out, and a click on the percentage resets to 100% and stays there', () => {
    vi.useFakeTimers();
    render(<CanvasZoomPill />);
    expect(percent().textContent).toBe('300%');
    fireEvent.click(screen.getByLabelText('Zoom out'));
    expect(camera().zoom).toBe(2);
    fireEvent.click(screen.getByLabelText('Zoom in'));
    expect(camera().zoom).toBe(3);

    fireEvent.pointerDown(percent(), { button: 0, pointerId: 1 });
    fireEvent.pointerUp(percent(), { pointerId: 1 });
    fireEvent.click(percent());
    expect(camera()).toEqual({ x: 300, y: -40, zoom: 1 });
    // A short press is only a click: no peek fires once the hold time passes.
    vi.advanceTimersByTime(PEEK_HOLD_MS * 2);
    expect(camera()).toEqual({ x: 300, y: -40, zoom: 1 });
  });

  it('peeks while the percentage is held, then puts the view back without resetting it', () => {
    vi.useFakeTimers();
    render(<CanvasZoomPill />);
    fireEvent.pointerDown(percent(), { button: 0, pointerId: 1 });
    vi.advanceTimersByTime(PEEK_HOLD_MS);
    expect(camera()).toEqual({ x: 0, y: 0, zoom: 1 });

    fireEvent.pointerUp(percent(), { pointerId: 1 });
    fireEvent.click(percent());
    expect(camera()).toEqual({ x: 300, y: -40, zoom: 3 });
  });

  it.each([
    ['released over the canvas', () => fireEvent.pointerUp(document.body)],
    ['interrupted by the window losing focus', () => fireEvent.blur(window)],
  ])('puts the view back when a hold is %s', (_label, end) => {
    vi.useFakeTimers();
    render(<CanvasZoomPill />);
    fireEvent.pointerDown(percent(), { button: 0, pointerId: 1 });
    vi.advanceTimersByTime(PEEK_HOLD_MS);
    expect(camera().zoom).toBe(1);
    end();
    expect(camera()).toEqual({ x: 300, y: -40, zoom: 3 });
  });

  it('puts the view back if the pill goes away mid-hold', () => {
    vi.useFakeTimers();
    const { unmount } = render(<CanvasZoomPill />);
    fireEvent.pointerDown(percent(), { button: 0, pointerId: 1 });
    vi.advanceTimersByTime(PEEK_HOLD_MS);
    unmount();
    expect(camera()).toEqual({ x: 300, y: -40, zoom: 3 });
  });

  it('fits, and shows or hides the minimap', () => {
    render(<CanvasZoomPill />);
    fireEvent.click(screen.getByLabelText('Zoom to fit'));
    expect(camera()).toEqual({ x: 0, y: 0, zoom: 1 });

    const map = screen.getByLabelText('Minimap');
    expect(map.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(map);
    expect(useSettingsStore.getState().showMinimap).toBe(true);
    expect(screen.getByLabelText('Minimap').getAttribute('aria-pressed')).toBe('true');
  });
});
