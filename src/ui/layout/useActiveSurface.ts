/**
 * The editing surface the shared chrome describes (DSK-211): prose or canvas.
 *
 * Read from the same inputs App renders with, so the status line can't describe
 * a surface that isn't on screen. When both are, it follows the one last
 * focused or pointed at (`sessionStore.lastSurface`), falling back to the
 * layout's primary region before the first interaction.
 */
import type { SyntheticEvent } from 'react';
import { useSessionStore } from '../../store/sessionStore';
import { useBreakpoint } from './useBreakpoint';
import { useActiveLayoutMode, useActivePanelState } from './useLayout';
import { resolveActiveSurface, resolveRegions, surfacesOnScreen } from './modes';
import type { EditingSurface } from './types';

export function useActiveSurface(): EditingSurface {
  const mode = useActiveLayoutMode();
  const focus = useSessionStore((s) => s.relaxedFocus);
  const last = useSessionStore((s) => s.lastSurface);
  const { band } = useBreakpoint();
  const documentVisible = useActivePanelState('document').visible;

  const onScreen = surfacesOnScreen(mode, focus, band, documentVisible);
  const primary = resolveRegions(mode, focus, band).primary === 'document' ? 'prose' : 'canvas';
  return resolveActiveSurface(onScreen, last, primary);
}

/**
 * Note the surface an event landed in, as the last one worked in. App listens
 * with this at its root for pointer-downs and focus moves, so one listener
 * covers every place the document panel renders.
 */
export function noteSurface(event: SyntheticEvent): void {
  const target = event.target as Element | null;
  if (!target?.closest) return;
  if (target.closest('.canvas-area-wrapper')) useSessionStore.getState().setLastSurface('canvas');
  else if (target.closest('.document-editor-panel')) useSessionStore.getState().setLastSurface('prose');
}
