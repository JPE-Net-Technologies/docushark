/**
 * StatusBar responsive + focus-aware behaviour (JP-486).
 *
 * The bar used to render every readout unconditionally at a fixed 24px, which
 * on a 375px viewport overflowed its own width by ~57px — the active tool name
 * ended up off-screen entirely. These tests pin the two decisions that fixed it:
 * *what* renders at each viewport, and that a bar with nothing left to say
 * removes itself instead of holding an empty strip.
 *
 * `useBreakpoint` and `useActiveLayoutMode` are mocked because jsdom reports no
 * meaningful viewport band or pointer type; the layout mode is mocked to keep
 * this isolated from the persisted uiPreferences store.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { LayoutMode } from './layout/types';
import type { BreakpointState } from './layout/useBreakpoint';

let breakpoint: BreakpointState = { band: 'wide', isTouch: false, standalone: false };
let layoutMode: LayoutMode = 'relaxed';
let offline = false;

vi.mock('./layout/useBreakpoint', () => ({
  useBreakpoint: () => breakpoint,
}));
vi.mock('./layout/useLayout', () => ({
  useActiveLayoutMode: () => layoutMode,
}));
vi.mock('../collaboration/sharedDocOffline', () => ({
  useSharedDocOffline: () => offline,
}));

import { StatusBar } from './StatusBar';
import { useSessionStore } from '../store/sessionStore';
import { useConnectionStore } from '../store/connectionStore';

/** The zoom cluster's presence tell — `Fit` is unambiguous, unlike "100%". */
const zoomCluster = () => screen.queryByTitle('Fit to center');
const coordinates = () => screen.queryByText('X:');
const shapeCount = () => screen.queryByText('Shapes:');

describe('StatusBar responsive behaviour (JP-486)', () => {
  beforeEach(() => {
    cleanup();
    useConnectionStore.getState().reset();
    useSessionStore.getState().setRelaxedFocus('write');
    useSessionStore.getState().setEditingGroupId(null);
    breakpoint = { band: 'wide', isTouch: false, standalone: false };
    layoutMode = 'relaxed';
    offline = false;
  });

  describe('regular viewport — unchanged', () => {
    it('renders every readout, including in write focus', () => {
      render(<StatusBar />);
      expect(coordinates()).toBeTruthy();
      expect(shapeCount()).toBeTruthy();
      expect(zoomCluster()).toBeTruthy();
    });
  });

  describe('compact viewport', () => {
    it('drops coordinates and shape count when a canvas IS visible', () => {
      breakpoint = { band: 'narrow', isTouch: false, standalone: false };
      useSessionStore.getState().setRelaxedFocus('diagram');
      render(<StatusBar />);

      // The zoom cluster steers a canvas that is on screen, so it stays.
      expect(zoomCluster()).toBeTruthy();
      // These are what the old fixed layout pushed off the right edge.
      expect(coordinates()).toBeNull();
      expect(shapeCount()).toBeNull();
    });

    it('drops the zoom cluster in write focus — there is no canvas to steer', () => {
      breakpoint = { band: 'narrow', isTouch: false, standalone: false };
      offline = true;
      useConnectionStore.getState().setStatus('disconnected');
      render(<StatusBar />);

      expect(zoomCluster()).toBeNull();
      // The connection chip is the one readout that matters *more* on mobile.
      expect(screen.getByText('Offline')).toBeTruthy();
    });

    it('removes itself entirely when nothing is left to report', () => {
      breakpoint = { band: 'narrow', isTouch: false, standalone: false };
      // write focus (no canvas) + online + no drill-down + no blob sync
      const { container } = render(<StatusBar />);
      expect(container.querySelector('.status-bar')).toBeNull();
    });

    it('reappears for ambient state even with no canvas', () => {
      breakpoint = { band: 'narrow', isTouch: false, standalone: false };
      useSessionStore.getState().setEditingGroupId('group-1');
      const { container } = render(<StatusBar />);

      expect(container.querySelector('.status-bar')).toBeTruthy();
      expect(screen.getByText('In group')).toBeTruthy();
      expect(zoomCluster()).toBeNull();
    });

    it('treats a touch device as compact even at a medium band', () => {
      // A tablet in landscape clears 640px but still has no hover and needs
      // finger-sized targets, so it must not fall back to the desktop bar.
      breakpoint = { band: 'medium', isTouch: true, standalone: false };
      useSessionStore.getState().setRelaxedFocus('diagram');
      render(<StatusBar />);

      expect(coordinates()).toBeNull();
      expect(zoomCluster()).toBeTruthy();
    });
  });

  describe('non-Relaxed layouts', () => {
    it('keeps the zoom cluster on a compact viewport — the canvas is always present', () => {
      breakpoint = { band: 'narrow', isTouch: true, standalone: false };
      layoutMode = 'designer';
      // Focus is a Relaxed-only concept; a stale value must not hide the canvas.
      useSessionStore.getState().setRelaxedFocus('write');
      render(<StatusBar />);

      expect(zoomCluster()).toBeTruthy();
      expect(coordinates()).toBeNull();
    });
  });
});
