/**
 * Mounts the file viewer for whatever is currently open (JP-495).
 *
 * Lives at app level, NOT inside the canvas. A collapsed canvas region gets
 * `display: none` (`.app-main > .is-collapsed`, App.css), so a host mounted
 * inside it would render the modal into a hidden subtree — invisible. That is
 * exactly the state a prose chip is usually clicked from: Relaxed → Write focus
 * hides the canvas. (`FloatingFileViewer` would have survived on its own since
 * it portals to `document.body`; the modal renders in place and would not.)
 *
 * Resolving the descriptor here also keeps the hook rules simple: the
 * shape-lookup hook runs unconditionally, and only the render branches.
 */

import { useSessionStore } from '../store/sessionStore';
import { useMobileAdaptation } from './layout/useMobileAdaptation';
import { resolveViewerMode } from './fileViewerMode';
import { useFileShapeDescriptor } from './useFileShapeDescriptor';
import { FileViewerModal } from './FileViewerModal';
import { FloatingFileViewer } from './FloatingFileViewer';

export function FileViewerHost() {
  const viewingFile = useSessionStore((s) => s.viewingFile);
  const closeFileViewer = useSessionStore((s) => s.closeFileViewer);
  const fileViewerMode = useSessionStore((s) => s.fileViewerMode);
  const { mobileActive } = useMobileAdaptation();

  // Unconditional — hooks can't be called inside a branch. An empty id resolves
  // to null, which is also the right answer when nothing is open.
  const shapeDescriptor = useFileShapeDescriptor(
    viewingFile?.source === 'shape' ? viewingFile.shapeId : '',
  );

  if (!viewingFile) return null;

  const descriptor =
    viewingFile.source === 'shape' ? shapeDescriptor : viewingFile.descriptor;

  // The shape was deleted while its viewer was open — close rather than render
  // an empty frame.
  if (!descriptor) return null;

  return resolveViewerMode(fileViewerMode, mobileActive) === 'floating' ? (
    <FloatingFileViewer descriptor={descriptor} onClose={closeFileViewer} />
  ) : (
    <FileViewerModal descriptor={descriptor} onClose={closeFileViewer} />
  );
}
