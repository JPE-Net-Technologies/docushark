/**
 * File-viewer host mode resolution. The floating panel is a desktop affordance
 * — on mobile-adapted viewports the viewer always renders as the full-screen
 * modal regardless of the session's requested mode.
 */

export type FileViewerMode = 'modal' | 'floating';

export function resolveViewerMode(
  requested: FileViewerMode,
  mobileActive: boolean,
): FileViewerMode {
  return mobileActive ? 'modal' : requested;
}
