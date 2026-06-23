/**
 * Relay Settings tab — connect to a `docushark-relay` by signing in
 * through DocuShark Cloud.
 *
 * Since the relay became a pure OIDC resource server (JP-77) it no
 * longer mints tokens or stores passwords. The editor obtains a relay
 * app token out-of-band via the OAuth Device Authorization Grant
 * (`cloudAuth.beginCloudSignIn`): we request a code from `docushark-web`,
 * open the system browser to `/auth/device`, and poll until the user
 * authorizes — then start a collaboration session with the returned
 * token (sent in-band over the WS as MESSAGE_AUTH).
 *
 * UI states:
 *   - disconnected: Relay URL + Cloud URL + "Sign in with DocuShark Cloud"
 *   - awaiting:     show the user code + verification link while we poll
 *   - connecting/authenticating: spinner (driven by the WS handshake)
 *   - authenticated: signed-in identity + Disconnect
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { Cloud, LogIn, LogOut, AlertCircle, ExternalLink, Loader2, KeyRound, Trash2 } from 'lucide-react';
import { useConnectionStore } from '../../store/connectionStore';
import { useIsCloudSignedIn } from '../../store/relayDocumentStore';
import { useCollaborationStore, useIsRelaySessionLive } from '../../collaboration';
import { usePersistenceStore } from '../../store/persistenceStore';
import { useNotificationStore } from '../../store/notificationStore';
import { removeCurrentWorkspace } from '../../services/removeWorkspace';
import {
  loadConnection,
  clearJwt,
  DEFAULT_CLOUD_BASE_URL,
} from '../../api/relayConnection';
import { completeCloudSignIn } from '../../api/completeCloudSignIn';
import { beginCloudSignIn, CloudAuthError, type CloudSignInHandle } from '../../api/cloudAuth';
import './RelaySettings.css';

const DEFAULT_RELAY_URL = 'http://localhost:9876';

/** Local sign-in phase, distinct from the connection-store status. */
type SignInPhase = 'idle' | 'starting' | 'awaiting' | 'error';

export function RelaySettings() {
  const status = useConnectionStore((s) => s.status);
  const user = useConnectionStore((s) => s.user);
  const host = useConnectionStore((s) => s.host);
  const collabError = useCollaborationStore((s) => s.error);
  const stopSession = useCollaborationStore((s) => s.stopSession);
  const currentDocumentId = usePersistenceStore((s) => s.currentDocumentId);
  // Token-accepted ("Signed in") vs the active doc actually live-synced — the
  // JP-123 distinction made first-class (JP-199).
  const sessionLive = useIsRelaySessionLive();
  // A cached REST-only session counts as signed in even with no live WS, so the
  // menu shows "Signed in" (not "Disconnected") and doesn't prompt a re-pair.
  const cloudSignedIn = useIsCloudSignedIn();

  const [relayUrl, setRelayUrl] = useState(DEFAULT_RELAY_URL);
  const [cloudUrl, setCloudUrl] = useState(DEFAULT_CLOUD_BASE_URL);

  const [hasStoredToken, setHasStoredToken] = useState(false);
  const [phase, setPhase] = useState<SignInPhase>('idle');
  const [userCode, setUserCode] = useState<string | null>(null);
  const [verificationUri, setVerificationUri] = useState<string | null>(null);
  const [signInError, setSignInError] = useState<string | null>(null);
  const handleRef = useRef<CloudSignInHandle | null>(null);

  // Seed the URL fields once from persisted state (async since JP-100 moved
  // the connection record into IndexedDB). Guard against a late resolve after
  // unmount.
  useEffect(() => {
    let active = true;
    void (async () => {
      const persisted = await loadConnection();
      if (!active || !persisted) return;
      if (persisted.relayUrl) setRelayUrl(persisted.relayUrl);
      if (persisted.cloudBaseUrl) setCloudUrl(persisted.cloudBaseUrl);
    })();
    return () => {
      active = false;
    };
  }, []);

  // Surface whether a relay token is already persisted (JP-100 IndexedDB store),
  // so a signed-out-looking page still tells the user a session is saved and will
  // resume on sign-in. Re-checked on every status change — a successful sign-in
  // persists the token, Disconnect clears it via clearJwt().
  useEffect(() => {
    let active = true;
    void (async () => {
      const persisted = await loadConnection();
      if (!active) return;
      const valid =
        !!persisted?.jwt &&
        (persisted.jwtExpiresAt === null || persisted.jwtExpiresAt > Date.now());
      setHasStoredToken(valid);
    })();
    return () => {
      active = false;
    };
  }, [status]);

  // Cancel any in-flight device-code poll if the tab unmounts.
  useEffect(() => {
    return () => handleRef.current?.cancel();
  }, []);

  const isAuthenticated = status === 'authenticated' || cloudSignedIn;
  const isConnecting = status === 'connecting' || status === 'authenticating';
  const isAwaiting = phase === 'starting' || phase === 'awaiting';
  const isBusy = isConnecting || isAwaiting;

  const handleSignIn = useCallback(async () => {
    const trimmedRelay = relayUrl.trim();
    const trimmedCloud = cloudUrl.trim().replace(/\/+$/, '');
    if (!trimmedRelay || !trimmedCloud) return;

    setSignInError(null);
    setUserCode(null);
    setVerificationUri(null);
    setPhase('starting');

    try {
      // "Use the key": if a valid token for this relay is already cached, reuse
      // it (REST-only sign-in) instead of re-running the device-code flow. Only
      // re-pair when there's no usable cached token (or it's a different relay).
      const persisted = await loadConnection();
      if (
        persisted?.jwt &&
        persisted.relayUrl === trimmedRelay &&
        (persisted.jwtExpiresAt === null || persisted.jwtExpiresAt > Date.now())
      ) {
        await completeCloudSignIn({
          relayUrl: trimmedRelay,
          cloudBaseUrl: trimmedCloud,
          token: persisted.jwt,
          expiresAt: persisted.jwtExpiresAt,
          documentId: currentDocumentId,
        });
        setPhase('idle');
        return;
      }

      const handle = await beginCloudSignIn(trimmedCloud);
      handleRef.current = handle;
      setUserCode(handle.userCode);
      setVerificationUri(handle.verificationUriComplete);
      setPhase('awaiting');

      const { token, expiresAt } = await handle.result;
      handleRef.current = null;

      await completeCloudSignIn({
        relayUrl: trimmedRelay,
        cloudBaseUrl: trimmedCloud,
        token,
        expiresAt,
        documentId: currentDocumentId,
      });

      setPhase('idle');
      setUserCode(null);
      setVerificationUri(null);
    } catch (err) {
      handleRef.current = null;
      if (err instanceof CloudAuthError && err.code === 'cancelled') {
        setPhase('idle');
        return;
      }
      const message =
        err instanceof Error ? err.message : 'Sign-in failed. Please try again.';
      setSignInError(message);
      setPhase('error');
    }
  }, [relayUrl, cloudUrl, currentDocumentId]);

  const handleCancelSignIn = useCallback(() => {
    handleRef.current?.cancel();
    handleRef.current = null;
    setPhase('idle');
    setUserCode(null);
    setVerificationUri(null);
  }, []);

  const handleDisconnect = useCallback(() => {
    stopSession();
    void clearJwt();
  }, [stopSession]);

  // Remove Workspace (JP-237) — the destructive counterpart to Disconnect. Uses
  // an inline two-step confirm (mirrors the document browser's delete confirm)
  // rather than a bare window.confirm.
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const handleRemoveWorkspace = useCallback(async () => {
    setRemoving(true);
    try {
      await removeCurrentWorkspace();
      useNotificationStore
        .getState()
        .success('Workspace removed. Its documents and offline copies were deleted from this device.');
    } catch (err) {
      console.error('[RelaySettings] Remove workspace failed:', err);
      useNotificationStore
        .getState()
        .error('Could not fully remove the workspace. Some local data may remain.', {
          category: 'permanent',
        });
    } finally {
      setRemoving(false);
      setConfirmRemove(false);
    }
  }, []);

  return (
    <div className="relay-settings">
      <h3 className="settings-section-title">
        <Cloud size={18} style={{ verticalAlign: 'middle', marginRight: 8 }} />
        Relay Connection
      </h3>

      <p className="relay-settings__intro">
        Sign in with DocuShark Cloud to connect a <code>docushark-relay</code>{' '}
        and sync documents across devices in real time. Local documents work
        without a relay.
      </p>

      {isAuthenticated && user ? (
        <div className="relay-settings__panel">
          <div className="relay-settings__status relay-settings__status--ok">
            <span className="relay-settings__status-dot" />
            Signed in
          </div>

          <dl className="relay-settings__info">
            <div>
              <dt>Account</dt>
              <dd>
                {user.username || user.id}
                {user.role ? <span className="relay-settings__role">{user.role}</span> : null}
              </dd>
            </div>
            <div>
              <dt>Relay</dt>
              <dd>{host?.url ?? '—'}</dd>
            </div>
            <div>
              <dt>Session</dt>
              <dd>
                {sessionLive
                  ? 'Live · current document synced'
                  : 'Signed in · no document synced yet'}
              </dd>
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

          <div className="relay-settings__danger">
            {!confirmRemove ? (
              <button
                type="button"
                className="relay-settings__btn relay-settings__btn--danger"
                onClick={() => setConfirmRemove(true)}
              >
                <Trash2 size={16} />
                Remove workspace…
              </button>
            ) : (
              <div className="relay-settings__confirm" role="alertdialog" aria-label="Remove workspace">
                <p className="relay-settings__confirm-text">
                  Remove this workspace from <strong>this device</strong>? Its documents
                  and downloaded offline copies will be deleted locally and the relay
                  forgotten. Documents on the server are not affected.
                </p>
                <div className="relay-settings__confirm-actions">
                  <button
                    type="button"
                    className="relay-settings__btn relay-settings__btn--danger"
                    onClick={() => void handleRemoveWorkspace()}
                    disabled={removing}
                  >
                    {removing ? <Loader2 size={16} className="relay-settings__spin" /> : <Trash2 size={16} />}
                    {removing ? 'Removing…' : 'Remove everything'}
                  </button>
                  <button
                    type="button"
                    className="relay-settings__btn relay-settings__btn--secondary"
                    onClick={() => setConfirmRemove(false)}
                    disabled={removing}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="relay-settings__panel">
          <div
            className={`relay-settings__status relay-settings__status--${isBusy ? 'busy' : 'idle'}`}
          >
            <span className="relay-settings__status-dot" />
            {status === 'connecting' && 'Connecting…'}
            {status === 'authenticating' && 'Authenticating…'}
            {phase === 'awaiting' && 'Waiting for browser authorization…'}
            {phase === 'starting' && 'Requesting a sign-in code…'}
            {phase !== 'awaiting' &&
              phase !== 'starting' &&
              !isConnecting &&
              'Disconnected'}
          </div>

          {hasStoredToken && !isBusy ? (
            <div className="relay-settings__token-stored" role="status">
              <KeyRound size={14} />
              <span>Saved session token — sign in to resume</span>
            </div>
          ) : null}

          {(collabError || signInError) && phase !== 'awaiting' ? (
            <div className="relay-settings__error" role="alert">
              <AlertCircle size={16} />
              <span>{signInError ?? collabError}</span>
            </div>
          ) : null}

          {phase === 'awaiting' && userCode ? (
            <div className="relay-settings__device" role="status">
              <p className="relay-settings__device-hint">
                Your browser should have opened. Confirm this code matches, then
                authorize the device:
              </p>
              <div className="relay-settings__device-code">{userCode}</div>
              {verificationUri ? (
                <a
                  className="relay-settings__device-link"
                  href={verificationUri}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink size={14} />
                  Open the verification page
                </a>
              ) : null}
              <button
                type="button"
                className="relay-settings__btn relay-settings__btn--secondary"
                onClick={handleCancelSignIn}
              >
                Cancel
              </button>
            </div>
          ) : (
            <>
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
                <label htmlFor="cloud-url">DocuShark Cloud URL</label>
                <input
                  id="cloud-url"
                  type="url"
                  value={cloudUrl}
                  onChange={(e) => setCloudUrl(e.target.value)}
                  placeholder={DEFAULT_CLOUD_BASE_URL}
                  disabled={isBusy}
                  autoComplete="url"
                  required
                />
              </div>

              <button
                type="button"
                className="relay-settings__btn relay-settings__btn--primary"
                onClick={() => void handleSignIn()}
                disabled={isBusy || !relayUrl.trim() || !cloudUrl.trim()}
              >
                {isBusy ? <Loader2 size={16} className="relay-settings__spin" /> : <LogIn size={16} />}
                {isBusy ? 'Signing in…' : 'Sign in with DocuShark Cloud'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default RelaySettings;
