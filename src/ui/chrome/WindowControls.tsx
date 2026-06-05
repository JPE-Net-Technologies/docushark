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
import { Minus, Square, Copy, X } from 'lucide-react';
import { Icon } from '../icons';
import { windowControls } from '../../platform/window';
import './WindowControls.css';

export function WindowControls() {
  const [isMaximized, setIsMaximized] = useState(false);
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    if (!windowControls.isSupported()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const maximized = await windowControls.isMaximized();
      if (cancelled) return;
      setSupported(true);
      setIsMaximized(maximized);
      const un = await windowControls.onResized(async () => {
        setIsMaximized(await windowControls.isMaximized());
      });
      if (cancelled) {
        un();
        return;
      }
      unlisten = un;
    })().catch((err) => {
      console.warn('[WindowControls] window API unavailable:', err);
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  if (!supported) return null;

  const dispatch = async (action: 'minimize' | 'toggleMaximize' | 'close') => {
    try {
      if (action === 'minimize') await windowControls.minimize();
      else if (action === 'toggleMaximize') await windowControls.toggleMaximize();
      else await windowControls.close();
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
        <Icon icon={Minus} size={10} />
      </button>
      <button
        type="button"
        className="window-control window-control-max"
        onClick={() => void dispatch('toggleMaximize')}
        aria-label={isMaximized ? 'Restore' : 'Maximize'}
        title={isMaximized ? 'Restore' : 'Maximize'}
      >
        {isMaximized ? <Icon icon={Copy} size={10} /> : <Icon icon={Square} size={10} />}
      </button>
      <button
        type="button"
        className="window-control window-control-close"
        onClick={() => void dispatch('close')}
        aria-label="Close"
        title="Close"
      >
        <Icon icon={X} size={10} />
      </button>
    </div>
  );
}
