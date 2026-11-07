/**
 * StatusBar: the document's status line (DSK-211), and its responsive
 * behaviour (JP-486).
 *
 * The line describes whichever editing surface you're working in: the open
 * page's words while you write, the canvas's counts and cursor while you draw.
 * The canvas's zoom lives on the canvas (CanvasZoomPill), never here. On a
 * compact viewport the readouts go, and a bar with nothing left to say removes
 * itself instead of holding an empty strip.
 *
 * `useBreakpoint` and the layout hooks are mocked because jsdom reports no
 * meaningful viewport band or pointer type, and to keep this isolated from the
 * persisted uiPreferences store.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { LayoutMode } from './layout/types';
import type { BreakpointState } from './layout/useBreakpoint';

let breakpoint: BreakpointState = { band: 'wide', isTouch: false, standalone: false };
let layoutMode: LayoutMode = 'relaxed';
let documentVisible = true;
let offline = false;

vi.mock('./layout/useBreakpoint', () => ({
  useBreakpoint: () => breakpoint,
}));
vi.mock('./layout/useLayout', () => ({
  useActiveLayoutMode: () => layoutMode,
  useActivePanelState: () => ({ dock: 'left', visible: documentVisible, order: 0 }),
}));
vi.mock('../collaboration/sharedDocOffline', () => ({
  useSharedDocOffline: () => offline,
}));

import { StatusBar } from './StatusBar';
import { useSessionStore } from '../store/sessionStore';
import { useConnectionStore } from '../store/connectionStore';
import { useProseStatsStore } from '../services/proseStats';

const coordinates = () => screen.queryByText('X:');
const shapeCount = () => screen.queryByText(/\d+ shapes?$/);
const wordCount = () => screen.queryByText(/\bwords?$/);
/** Any trace of the old zoom cluster or tool readout. */
const zoomOrTool = () =>
  screen.queryByTitle('Fit to center') ?? screen.queryByLabelText('Zoom in') ?? screen.queryByText('Select');

describe('StatusBar (DSK-211, JP-486)', () => {
  beforeEach(() => {
    cleanup();
    useConnectionStore.getState().reset();
    useSessionStore.getState().setRelaxedFocus('write');
    useSessionStore.getState().setEditingGroupId(null);
    useSessionStore.setState({ lastSurface: null });
    useProseStatsStore.setState({ stats: { words: 12, characters: 60, paragraphs: 2, selectionWords: 0 } });
    breakpoint = { band: 'wide', isTouch: false, standalone: false };
    layoutMode = 'relaxed';
    documentVisible = true;
    offline = false;
  });

  describe('regular viewport', () => {
    it('describes the writing in write focus: words, no canvas readouts, no zoom', () => {
      render(<StatusBar />);
      expect(wordCount()?.textContent).toBe('12 words');
      expect(coordinates()).toBeNull();
      expect(shapeCount()).toBeNull();
      expect(zoomOrTool()).toBeNull();
    });

    it('counts the selection against the page', () => {
      useProseStatsStore.setState({ stats: { words: 1204, characters: 6000, paragraphs: 40, selectionWords: 12 } });
      render(<StatusBar />);
      expect(screen.getByText('12 of 1,204 words')).toBeTruthy();
    });

    it('describes the canvas in diagram focus: cursor and shapes, no words, no zoom', () => {
      useSessionStore.getState().setRelaxedFocus('diagram');
      render(<StatusBar />);
      expect(coordinates()).toBeTruthy();
      expect(shapeCount()).toBeTruthy();
      expect(wordCount()).toBeNull();
      expect(zoomOrTool()).toBeNull();
    });

    it('follows the surface last worked in while both are on screen', () => {
      useSessionStore.getState().setRelaxedFocus('split');
      useSessionStore.getState().setLastSurface('canvas');
      const { unmount } = render(<StatusBar />);
      expect(shapeCount()).toBeTruthy();
      expect(wordCount()).toBeNull();
      unmount();

      useSessionStore.getState().setLastSurface('prose');
      render(<StatusBar />);
      expect(wordCount()).toBeTruthy();
      expect(shapeCount()).toBeNull();
    });
  });

  describe('compact viewport', () => {
    it('removes itself with nothing ambient, even with a canvas on screen', () => {
      breakpoint = { band: 'narrow', isTouch: false, standalone: false };
      useSessionStore.getState().setRelaxedFocus('diagram');
      const { container } = render(<StatusBar />);
      expect(container.querySelector('.status-bar')).toBeNull();
    });

    it('keeps the connection chip, the one readout that matters more on mobile', () => {
      breakpoint = { band: 'narrow', isTouch: false, standalone: false };
      offline = true;
      useConnectionStore.getState().setStatus('disconnected');
      render(<StatusBar />);
      expect(screen.getByText('Offline')).toBeTruthy();
      expect(wordCount()).toBeNull();
    });

    it('reappears for ambient state', () => {
      breakpoint = { band: 'narrow', isTouch: false, standalone: false };
      useSessionStore.getState().setEditingGroupId('group-1');
      const { container } = render(<StatusBar />);
      expect(container.querySelector('.status-bar')).toBeTruthy();
      expect(screen.getByText('In group')).toBeTruthy();
      expect(coordinates()).toBeNull();
    });

    it('treats a touch device as compact even at a medium band', () => {
      // A tablet in landscape clears 640px but still has no hover and needs
      // finger-sized targets, so it must not fall back to the desktop bar.
      breakpoint = { band: 'medium', isTouch: true, standalone: false };
      useSessionStore.getState().setRelaxedFocus('diagram');
      useSessionStore.getState().setEditingGroupId('group-1');
      render(<StatusBar />);
      expect(coordinates()).toBeNull();
      expect(shapeCount()).toBeNull();
    });
  });

  describe('non-Relaxed layouts', () => {
    it('describes the canvas when the document panel is hidden', () => {
      layoutMode = 'designer';
      documentVisible = false;
      // Focus is a Relaxed-only concept; a stale value must not hide the canvas.
      useSessionStore.getState().setRelaxedFocus('write');
      render(<StatusBar />);
      expect(shapeCount()).toBeTruthy();
      expect(wordCount()).toBeNull();
    });
  });
});
