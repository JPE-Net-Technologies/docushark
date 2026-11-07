/**
 * Noting the surface an event lands in (DSK-211).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SyntheticEvent } from 'react';
import { useSessionStore } from '../../store/sessionStore';
import { noteSurface } from './useActiveSurface';

function eventIn(className: string | null): SyntheticEvent {
  const outer = document.createElement('div');
  if (className) outer.className = className;
  const target = document.createElement('button');
  outer.appendChild(target);
  return { target } as unknown as SyntheticEvent;
}

describe('noteSurface (DSK-211)', () => {
  beforeEach(() => useSessionStore.setState({ lastSurface: null }));

  it('notes the canvas and the prose panel from anywhere inside them', () => {
    noteSurface(eventIn('canvas-area-wrapper'));
    expect(useSessionStore.getState().lastSurface).toBe('canvas');
    noteSurface(eventIn('document-editor-panel'));
    expect(useSessionStore.getState().lastSurface).toBe('prose');
  });

  it('leaves the last surface alone for the shared chrome', () => {
    noteSurface(eventIn('canvas-area-wrapper'));
    noteSurface(eventIn('unified-toolbar'));
    expect(useSessionStore.getState().lastSurface).toBe('canvas');
  });

  it("doesn't wake the session store's subscribers while the surface stays the same", () => {
    noteSurface(eventIn('canvas-area-wrapper'));
    const listener = vi.fn();
    const unsubscribe = useSessionStore.subscribe(listener);
    noteSurface(eventIn('canvas-area-wrapper'));
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
