/**
 * WindowControls — minimize / toggle-maximize / close buttons drawn by the
 * renderer when custom chrome is opted in. Falls back to a no-op (and renders
 * nothing) when not running under Tauri, so a PWA user toggling custom chrome
 * doesn't see broken buttons.
 *
 * Phase A is platform-naive (Windows/Linux style: right-aligned controls).
 * Per-OS polish (macOS traffic-light placement, WinUI hover glows) is
 * tracked in the backlog.
 */

import { useEffect, useState } from 'react';
import { isTauri } from '../../tauri/commands';
import './WindowControls.css';

export function WindowControls() {
  const [isMaximized, setIsMaximized] = useState(false);
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      if (cancelled) return;
      const win = getCurrentWindow();
      setSupported(true);
      setIsMaximized(await win.isMaximized());
      unlisten = await win.onResized(async () => {
        setIsMaximized(await win.isMaximized());
      });
    })().catch((err) => {
      console.warn('[WindowControls] Tauri window API unavailable:', err);
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  if (!supported) return null;

  const dispatch = async (action: 'minimize' | 'toggleMaximize' | 'close') => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const win = getCurrentWindow();
      if (action === 'minimize') await win.minimize();
      else if (action === 'toggleMaximize') await win.toggleMaximize();
      else await win.close();
    } catch (err) {
      // Surface permission gaps or runtime errors — these were silent
      // until Phase A.1; the user couldn't tell why a button did nothing.
      console.error(`[WindowControls] ${action} failed:`, err);
    }
  };

  return (
    <div className="window-controls" role="group" aria-label="Window controls">
      <button
        type="button"
        className="window-control window-control-min"
        onClick={() => void dispatch('minimize')}
        aria-label="Minimize"
        title="Minimize"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <rect x="1" y="4.5" width="8" height="1" fill="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        className="window-control window-control-max"
        onClick={() => void dispatch('toggleMaximize')}
        aria-label={isMaximized ? 'Restore' : 'Maximize'}
        title={isMaximized ? 'Restore' : 'Maximize'}
      >
        {isMaximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="2.5" y="1" width="6.5" height="6.5" fill="none" stroke="currentColor" />
            <rect x="1" y="2.5" width="6.5" height="6.5" fill="none" stroke="currentColor" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="1" y="1" width="8" height="8" fill="none" stroke="currentColor" />
          </svg>
        )}
      </button>
      <button
        type="button"
        className="window-control window-control-close"
        onClick={() => void dispatch('close')}
        aria-label="Close"
        title="Close"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  );
}
