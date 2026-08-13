/**
 * FileViewerModal — full-screen modal host for FileViewerContent. Owns the
 * overlay, Escape handling (exit immersive before closing), immersive state,
 * and the pop-out-to-floating-panel affordance (desktop only).
 */

import { useState, useEffect, useCallback } from 'react';
import { PictureInPicture2 } from 'lucide-react';
import { Icon } from './icons';
import { useSessionStore } from '../store/sessionStore';
import { useMobileAdaptation } from './layout/useMobileAdaptation';
import { FileViewerContent } from './FileViewerContent';
import type { FileDescriptor } from './fileDescriptor';
import './FileViewerModal.css';

export interface FileViewerModalProps {
  descriptor: FileDescriptor;
  onClose: () => void;
}

export function FileViewerModal({ descriptor, onClose }: FileViewerModalProps) {
  // Immersive reading (PDF): the modal owns it because it's the modal's own
  // chrome (header, rounded frame) that collapses alongside the viewer's.
  const [immersive, setImmersive] = useState(false);
  const { mobileActive } = useMobileAdaptation();
  const setFileViewerMode = useSessionStore((s) => s.setFileViewerMode);


  // Escape: exit immersive first, close second. (The PDF reader's find bar
  // handles its own Escape and stops propagation before this window listener.)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (immersive) setImmersive(false);
        else onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, immersive]);

  // Close when clicking the overlay background
  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  if (!descriptor) {
    return null;
  }

  const overlayClass = immersive
    ? 'file-viewer-overlay file-viewer-overlay--immersive'
    : 'file-viewer-overlay';

  return (
    <div className={overlayClass} onClick={handleOverlayClick}>
      <div className="file-viewer-modal">
        <FileViewerContent
          descriptor={descriptor}
          onClose={onClose}
          immersive={immersive}
          onImmersiveChange={setImmersive}
          hideHeader={immersive}
          headerExtras={
            !mobileActive ? (
              <button
                className="file-viewer-action-btn"
                onClick={() => setFileViewerMode('floating')}
                title="Pop out to a floating panel"
              >
                <Icon icon={PictureInPicture2} size={14} />
              </button>
            ) : undefined
          }
        />
      </div>
    </div>
  );
}

export default FileViewerModal;
