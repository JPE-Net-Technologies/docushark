/**
 * Relay Settings tab — connect to and authenticate against an external
 * `diagrammer-relay` binary.
 *
 * Phase 20.3 Slice E.5 Commit 1. Three states keyed off
 * `useConnectionStore.status`:
 *   - disconnected: URL + username + password form (URL pre-fills from
 *     `loadConnection()`)
 *   - connecting/authenticating: disabled form + spinner + last error
 *   - authenticated: current user + URL + Disconnect button
 *
 * The actual REST login + WS auth handshake lives in
 * `UnifiedSyncProvider.loginWithCredentials` (Slice E.2 Commit 3); this
 * component is just the UI shell that triggers
 * `useCollaborationStore.startSession`.
 */

import { useEffect, useState, useCallback, FormEvent } from 'react';
import { Cloud, LogIn, LogOut, AlertCircle } from 'lucide-react';
import { useConnectionStore } from '../../store/connectionStore';
import { useCollaborationStore } from '../../collaboration';
import { usePersistenceStore } from '../../store/persistenceStore';
import { loadConnection, clearJwt } from '../../api/relayConnection';
import './RelaySettings.css';

const DEFAULT_RELAY_URL = 'http://localhost:9876';

/** Convert a REST origin (http://host:port) to the matching WS URL (ws://host:port/ws). */
function restUrlToWsUrl(restUrl: string): string {
  return restUrl
    .replace(/\/+$/, '')
    .replace(/^http:\/\//, 'ws://')
    .replace(/^https:\/\//, 'wss://')
    .concat('/ws');
}

export function RelaySettings() {
  const status = useConnectionStore((s) => s.status);
  const user = useConnectionStore((s) => s.user);
  const host = useConnectionStore((s) => s.host);
  const collabError = useCollaborationStore((s) => s.error);
  const startSession = useCollaborationStore((s) => s.startSession);
  const stopSession = useCollaborationStore((s) => s.stopSession);
  const currentDocumentId = usePersistenceStore((s) => s.currentDocumentId);

  const [relayUrl, setRelayUrl] = useState(DEFAULT_RELAY_URL);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  // Seed the URL field once from persisted state; honor it even if the
  // user is already connected (display the connected URL via `host`).
  useEffect(() => {
    const persisted = loadConnection();
    if (persisted?.relayUrl) {
      setRelayUrl(persisted.relayUrl);
    }
  }, []);

  const isAuthenticated = status === 'authenticated';
  const isBusy = status === 'connecting' || status === 'authenticating';

  const handleConnect = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const trimmedUrl = relayUrl.trim();
      const trimmedUsername = username.trim();
      if (!trimmedUrl || !trimmedUsername || !password) return;

      const serverUrl = restUrlToWsUrl(trimmedUrl);
      const docId = currentDocumentId ?? 'default';
      startSession({
        serverUrl,
        documentId: docId,
        credentials: { username: trimmedUsername, password },
        user: {
          id: 'pending',
          name: trimmedUsername,
          color: '#4a90d9',
        },
      });
      setPassword('');
    },
    [relayUrl, username, password, currentDocumentId, startSession],
  );

  const handleDisconnect = useCallback(() => {
    stopSession();
    clearJwt();
  }, [stopSession]);

  return (
    <div className="relay-settings">
      <h3 className="settings-section-title">
        <Cloud size={18} style={{ verticalAlign: 'middle', marginRight: 8 }} />
        Relay Connection
      </h3>

      <p className="relay-settings__intro">
        Connect to an external <code>diagrammer-relay</code> binary to
        sync documents across devices and collaborate in real time.
        Local documents work without a relay.
      </p>

      {isAuthenticated && user ? (
        <div className="relay-settings__panel">
          <div className="relay-settings__status relay-settings__status--ok">
            <span className="relay-settings__status-dot" />
            Authenticated
          </div>

          <dl className="relay-settings__info">
            <div>
              <dt>User</dt>
              <dd>
                {user.username}
                {user.role ? <span className="relay-settings__role">{user.role}</span> : null}
              </dd>
            </div>
            <div>
              <dt>Relay</dt>
              <dd>{host?.url ?? '—'}</dd>
            </div>
          </dl>

          <button
            type="button"
            className="relay-settings__btn relay-settings__btn--secondary"
            onClick={handleDisconnect}
          >
            <LogOut size={16} />
            Disconnect
          </button>
        </div>
      ) : (
        <form className="relay-settings__panel" onSubmit={handleConnect}>
          <div className={`relay-settings__status relay-settings__status--${isBusy ? 'busy' : 'idle'}`}>
            <span className="relay-settings__status-dot" />
            {status === 'connecting' && 'Connecting…'}
            {status === 'authenticating' && 'Authenticating…'}
            {status === 'error' && 'Error'}
            {(status === 'disconnected' || status === 'connected') && 'Disconnected'}
          </div>

          {collabError ? (
            <div className="relay-settings__error" role="alert">
              <AlertCircle size={16} />
              <span>{collabError}</span>
            </div>
          ) : null}

          <div className="relay-settings__field">
            <label htmlFor="relay-url">Relay URL</label>
            <input
              id="relay-url"
              type="url"
              value={relayUrl}
              onChange={(e) => setRelayUrl(e.target.value)}
              placeholder={DEFAULT_RELAY_URL}
              disabled={isBusy}
              autoComplete="url"
              required
            />
          </div>

          <div className="relay-settings__field">
            <label htmlFor="relay-username">Username</label>
            <input
              id="relay-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={isBusy}
              autoComplete="username"
              required
            />
          </div>

          <div className="relay-settings__field">
            <label htmlFor="relay-password">Password</label>
            <input
              id="relay-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={isBusy}
              autoComplete="current-password"
              required
            />
          </div>

          <button
            type="submit"
            className="relay-settings__btn relay-settings__btn--primary"
            disabled={isBusy || !relayUrl.trim() || !username.trim() || !password}
          >
            <LogIn size={16} />
            {isBusy ? 'Connecting…' : 'Connect'}
          </button>
        </form>
      )}
    </div>
  );
}

export default RelaySettings;
