/**
 * TitleBar — custom in-app title bar rendered when the user opts in to custom
 * window chrome. Drag region uses `data-tauri-drag-region` so Tauri intercepts
 * mousedown for window dragging; window controls live on the right.
 *
 * In a PWA build (no Tauri), the bar still renders if the user opted in, but
 * WindowControls renders nothing — the bar is then just a decorative strip
 * with the doc title and save-status dot.
 */

import { useEffect, useState } from 'react';
import { usePersistenceStore } from '../../store/persistenceStore';
import { useAutoSave } from '../../hooks/useAutoSave';
import { WindowControls } from './WindowControls';
import './TitleBar.css';

export function TitleBar() {
  const docName = usePersistenceStore((s) => s.currentDocumentName);
  const { isDirty, status } = useAutoSave();
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    // Lightweight UA sniff for the macOS traffic-light gap. We don't need
    // accurate platform detection — being wrong just means a few pixels of
    // empty space, never broken behavior.
    const ua = navigator.userAgent.toLowerCase();
    setIsMac(/mac|iphone|ipad|ipod/.test(ua));
  }, []);

  const statusDot =
    status === 'saving' ? '◐' : isDirty ? '●' : '○';
  const statusTitle =
    status === 'saving' ? 'Saving…' : isDirty ? 'Unsaved changes' : 'Saved';

  return (
    <div className="title-bar" data-tauri-drag-region>
      {/* macOS reserves a left gap so the would-be-traffic-light area isn't
       * overlapped by app content. Tauri can be configured to keep the real
       * traffic lights overlay-style; until that's wired, we leave the gap
       * empty so users with macOS read the spacing as familiar. */}
      {isMac && <div className="title-bar-mac-gap" data-tauri-drag-region />}

      <div className="title-bar-title" data-tauri-drag-region>
        <span
          className={`title-bar-status title-bar-status-${status === 'saving' ? 'saving' : isDirty ? 'dirty' : 'saved'}`}
          title={statusTitle}
          aria-label={statusTitle}
        >
          {statusDot}
        </span>
        <span className="title-bar-name" title={docName || 'DocuShark'}>
          {docName || 'DocuShark'}
        </span>
      </div>

      <WindowControls />
    </div>
  );
}
