/**
 * TitleBar — custom in-app title bar rendered when the user opts in to custom
 * window chrome. Drag region uses `data-tauri-drag-region` so Tauri intercepts
 * mousedown for window dragging; window controls live on the right.
 *
 * This bar is Tauri window chrome and is intentionally NOT a home for the
 * document title — that lives in the UnifiedToolbar (showing it here too just
 * duplicated it). Instead it surfaces the live relay/WebSocket connection
 * status and, when signed in, the active workspace name.
 *
 * In a PWA build (no Tauri), the bar still renders if the user opted in, but
 * WindowControls renders nothing — the bar is then just a decorative strip.
 */

import { useEffect, useState } from 'react';
import { useConnectionStore } from '../../store/connectionStore';
import { loadConnection } from '../../api/relayConnection';
import { WindowControls } from './WindowControls';
import './TitleBar.css';

type OnlineState = 'online' | 'connecting' | 'reconnecting' | 'offline' | 'local';

const ONLINE_LABELS: Record<OnlineState, string> = {
  online: 'Online',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  offline: 'Offline',
  local: 'Local',
};

export function TitleBar() {
  const status = useConnectionStore((s) => s.status);
  const reconnectPhase = useConnectionStore((s) => s.reconnectPhase);
  const token = useConnectionStore((s) => s.token);
  const [isMac, setIsMac] = useState(false);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);

  useEffect(() => {
    // Lightweight UA sniff for the macOS traffic-light gap. We don't need
    // accurate platform detection — being wrong just means a few pixels of
    // empty space, never broken behavior.
    const ua = navigator.userAgent.toLowerCase();
    setIsMac(/mac|iphone|ipad|ipod/.test(ua));
  }, []);

  // The workspace name lives in the persisted connection record (written by
  // completeCloudSignIn), not in a reactive store. Re-read it whenever sign-in
  // state flips — by the time the token is set the name is already persisted.
  // Cleared when signed out (no token), so a local user shows no workspace.
  useEffect(() => {
    if (!token) {
      setWorkspaceName(null);
      return undefined;
    }
    let cancelled = false;
    void loadConnection().then((conn) => {
      if (!cancelled) setWorkspaceName(conn?.workspaceName ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // WS-live status. No token → purely local (neutral). With a token: authed is
  // a live session; connecting/reconnecting are transient; anything else is a
  // dropped connection.
  let onlineState: OnlineState;
  if (!token) onlineState = 'local';
  else if (status === 'authenticated') onlineState = 'online';
  else if (reconnectPhase === 'reconnecting') onlineState = 'reconnecting';
  else if (status === 'connecting' || status === 'connected') onlineState = 'connecting';
  else onlineState = 'offline';

  const label = ONLINE_LABELS[onlineState];

  return (
    <div className="title-bar" data-tauri-drag-region>
      {/* macOS reserves a left gap so the would-be-traffic-light area isn't
       * overlapped by app content. Tauri can be configured to keep the real
       * traffic lights overlay-style; until that's wired, we leave the gap
       * empty so users with macOS read the spacing as familiar. */}
      {isMac && <div className="title-bar-mac-gap" data-tauri-drag-region />}

      <div className="title-bar-info" data-tauri-drag-region>
        <span
          className={`title-bar-online title-bar-online-${onlineState}`}
          title={`Connection: ${label}`}
          aria-label={`Connection: ${label}`}
        >
          <span className="title-bar-online-dot" aria-hidden="true" />
          <span className="title-bar-online-label">{label}</span>
        </span>
        {workspaceName && (
          <span className="title-bar-workspace" title={workspaceName}>
            {workspaceName}
          </span>
        )}
      </div>

      <WindowControls />
    </div>
  );
}
