import { useEffect, useState } from 'react';
import { useConnectionStore } from '../store/connectionStore';
import { useCollaborationStore } from '../collaboration/collaborationStore';
import './ConnectionStatusBanner.css';

/**
 * Terminal connection banner (JP-237).
 *
 * Shows ONLY when reconnection has failed and can't be re-established on its own
 * — retries exhausted, auth rejected, or the user cancelled
 * (`reconnectPhase === 'offline'`). Transient reconnects are handled by the
 * single updatable "reconnecting…" toast, NOT here, so the banner no longer
 * flashes on every status flip during normal recovery.
 *
 * "Reconnect" retries the existing session immediately and opens the relay
 * quick-connect menu so the user can re-pair if the token/relay needs it.
 */
export function ConnectionStatusBanner() {
  const phase = useConnectionStore((s) => s.reconnectPhase);
  const [dismissed, setDismissed] = useState(false);

  // A fresh offline transition re-shows the banner even if a prior one was
  // dismissed (reset whenever the phase changes).
  useEffect(() => {
    setDismissed(false);
  }, [phase]);

  if (phase !== 'offline' || dismissed) return null;

  const handleReconnect = () => {
    useCollaborationStore.getState().reconnectNow();
    // Open the relay quick-connect menu (Documents → Cloud) so the user can
    // re-pair if the immediate retry can't restore the session on its own.
    window.dispatchEvent(new CustomEvent('docushark:open-cloud-connect'));
  };

  return (
    <div className="connection-banner connection-banner--error" role="status">
      <span className="connection-banner__icon" aria-hidden="true">
        ⚠
      </span>
      <span className="connection-banner__message">
        Workspace connection lost. Your changes are saved locally.
      </span>
      <div className="connection-banner__actions">
        <button className="connection-banner__retry" onClick={handleReconnect}>
          Reconnect
        </button>
        <button
          className="connection-banner__dismiss"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
