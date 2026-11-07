/**
 * Picking a canvas tool with the pointer gives keyboard focus back to the
 * canvas (DSK-214). The canvas hears its shortcuts (V, Delete, the arrows)
 * only while it has focus, and a click left focus on the toolbar button.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { CanvasToolbar } from './CanvasToolbar';
import { registerCanvasFocus } from './layout/focusRegions';
import { useSessionStore } from '../store/sessionStore';

let unregister = () => {};

afterEach(() => {
  cleanup();
  unregister();
  useSessionStore.getState().setActiveTool('select');
});

function renderToolbar() {
  const focusCanvas = vi.fn();
  unregister = registerCanvasFocus(focusCanvas);
  render(<CanvasToolbar />);
  return focusCanvas;
}

describe('canvas toolbar focus (DSK-214)', () => {
  it('a pointer click on a tool picks it and gives focus back to the canvas', () => {
    const focusCanvas = renderToolbar();
    fireEvent.click(screen.getByRole('button', { name: /^Rectangle/ }), { detail: 1 });
    expect(useSessionStore.getState().activeTool).toBe('rectangle');
    expect(focusCanvas).toHaveBeenCalledTimes(1);
  });

  it('keyboard activation picks the tool and keeps focus on the button', () => {
    const focusCanvas = renderToolbar();
    fireEvent.click(screen.getByRole('button', { name: /^Ellipse/ }), { detail: 0 });
    expect(useSessionStore.getState().activeTool).toBe('ellipse');
    expect(focusCanvas).not.toHaveBeenCalled();
  });

  it('a button that opens a menu keeps focus for the menu', () => {
    const focusCanvas = renderToolbar();
    const opener = document.querySelector<HTMLButtonElement>('.canvas-toolbar button[aria-haspopup]');
    expect(opener).not.toBeNull();
    fireEvent.click(opener!, { detail: 1 });
    expect(focusCanvas).not.toHaveBeenCalled();
  });
});
