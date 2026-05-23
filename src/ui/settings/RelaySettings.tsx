/**
 * Relay Settings tab — connect to and authenticate against an external
 * `docushark-relay` binary.
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
import { Cloud, LogIn, LogOut, AlertCircle, KeyRound, CheckCircle2 } from 'lucide-react';
import { useConnectionStore } from '../../store/connectionStore';
import { useCollaborationStore } from '../../collaboration';
import { usePersistenceStore } from '../../store/persistenceStore';
import { loadConnection, clearJwt } from '../../api/relayConnection';
import { RelayError } from '../../api/relayClient';
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
  const changePassword = useCollaborationStore((s) => s.changePassword);
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
        Connect to an external <code>docushark-relay</code> binary to
        sync documents across devices and collaborate in real time.
        Local documents work without a relay.
      </p>

      {isAuthenticated && user ? (
        <>
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

          <ChangePasswordPanel onSubmit={changePassword} />
        </>
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

interface ChangePasswordPanelProps {
  onSubmit: (args: { currentPassword: string; newPassword: string }) => Promise<void>;
}

function ChangePasswordPanel({ onSubmit }: ChangePasswordPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const reset = useCallback(() => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setError(null);
  }, []);

  const handleCollapse = useCallback(() => {
    reset();
    setSuccess(false);
    setExpanded(false);
  }, [reset]);

  const handleSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setError(null);
      setSuccess(false);

      if (newPassword.length < 8) {
        setError('New password must be at least 8 characters.');
        return;
      }
      if (newPassword !== confirmPassword) {
        setError('New password and confirmation do not match.');
        return;
      }

      setSubmitting(true);
      try {
        await onSubmit({ currentPassword, newPassword });
        setSuccess(true);
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
      } catch (err) {
        // Wrong current password surfaces as a 401 from the relay; keep
        // the new + confirm fields populated so the user only retypes
        // what was actually wrong.
        if (err instanceof RelayError && err.status === 401) {
          setError('Current password is incorrect.');
          setCurrentPassword('');
        } else if (err instanceof Error) {
          setError(err.message);
        } else {
          setError('Failed to change password.');
        }
      } finally {
        setSubmitting(false);
      }
    },
    [currentPassword, newPassword, confirmPassword, onSubmit],
  );

  if (!expanded) {
    return (
      <div className="relay-settings__panel">
        {success ? (
          <div className="relay-settings__success" role="status">
            <CheckCircle2 size={16} />
            <span>Password updated.</span>
          </div>
        ) : null}
        <button
          type="button"
          className="relay-settings__btn relay-settings__btn--secondary"
          onClick={() => {
            setSuccess(false);
            setExpanded(true);
          }}
        >
          <KeyRound size={16} />
          Change password
        </button>
      </div>
    );
  }

  return (
    <form className="relay-settings__panel" onSubmit={handleSubmit}>
      <div className="relay-settings__field">
        <label htmlFor="relay-current-password">Current password</label>
        <input
          id="relay-current-password"
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          disabled={submitting}
          autoComplete="current-password"
          required
        />
      </div>

      <div className="relay-settings__field">
        <label htmlFor="relay-new-password">New password</label>
        <input
          id="relay-new-password"
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          disabled={submitting}
          autoComplete="new-password"
          minLength={8}
          required
        />
      </div>

      <div className="relay-settings__field">
        <label htmlFor="relay-confirm-password">Confirm new password</label>
        <input
          id="relay-confirm-password"
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          disabled={submitting}
          autoComplete="new-password"
          minLength={8}
          required
        />
      </div>

      {error ? (
        <div className="relay-settings__error" role="alert">
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="relay-settings__btn-row">
        <button
          type="submit"
          className="relay-settings__btn relay-settings__btn--primary"
          disabled={submitting || !currentPassword || !newPassword || !confirmPassword}
        >
          <KeyRound size={16} />
          {submitting ? 'Updating…' : 'Update password'}
        </button>
        <button
          type="button"
          className="relay-settings__btn relay-settings__btn--secondary"
          onClick={handleCollapse}
          disabled={submitting}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export default RelaySettings;
