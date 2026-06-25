/**
 * Cloud connect panel — the body of the Cloud sign-in modal.
 *
 * Customer-facing: the path of least resistance is one prominent **Sign in with
 * DocuShark Cloud** button (it works on the pre-filled defaults). The Relay URL
 * + Cloud URL inputs — only self-hosters, testing, and (eventually) enterprise
 * touch them — live under a collapsed **Advanced** disclosure.
 *
 * Since the relay became a pure OIDC resource server (JP-77) it no longer mints
 * tokens or stores passwords. The editor obtains a relay app token out-of-band
 * via the OAuth Device Authorization Grant (`cloudAuth.beginCloudSignIn`): we
 * request a code from `docushark-web`, open the system browser to `/auth/device`,
 * and poll until the user authorizes — then a REST-only session is stood up
 * (the live WS comes up when a cloud doc is opened).
 *
 * UI states:
 *   - signed out:  Sign in button + Advanced (Relay/Cloud URLs)
 *   - awaiting:    user code + verification link while we poll
 *   - connecting/authenticating: spinner (driven by the WS handshake)
 *   - signed in:   workspace identity + Disconnect + Remove workspace
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import {
  LogIn,
  LogOut,
  AlertCircle,
  ExternalLink,
  Loader2,
  KeyRound,
  Trash2,
  ChevronRight,
  DoorOpen,
} from 'lucide-react';
import { useConnectionStore } from '../../store/connectionStore';
import { useIsCloudSignedIn } from '../../store/relayDocumentStore';
import { useCollaborationStore, useIsRelaySessionLive } from '../../collaboration';
import { usePersistenceStore } from '../../store/persistenceStore';
import { useNotificationStore } from '../../store/notificationStore';
import { removeCurrentWorkspace } from '../../services/removeWorkspace';
import { webClient, WebClientError } from '../../api/webClient';
import { confirmDialog } from '../confirm/confirmStore';
import {
  loadConnection,
  clearJwt,
  DEFAULT_CLOUD_BASE_URL,
  WORKSPACE_URL_BASE,
} from '../../api/relayConnection';
import { completeCloudSignIn } from '../../api/completeCloudSignIn';
import { beginCloudSignIn, CloudAuthError, type CloudSignInHandle } from '../../api/cloudAuth';
import {
  RELAY_LOCATIONS,
  DEFAULT_RELAY_LOCATION,
  locationForUrl,
} from '../../api/relayLocations';
import { WorkspaceMembersSection } from './WorkspaceMembersSection';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

/** Local sign-in phase, distinct from the connection-store status. */
type SignInPhase = 'idle' | 'starting' | 'awaiting' | 'error';

export interface CloudConnectPanelProps {
  /** Dismiss the surrounding modal (called after a workspace is removed). */
  onClose: () => void;
}

export function CloudConnectPanel({ onClose }: CloudConnectPanelProps) {
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
  // modal shows "Signed in" (not "Disconnected") and doesn't prompt a re-pair.
  const cloudSignedIn = useIsCloudSignedIn();

  const [relayUrl, setRelayUrl] = useState(DEFAULT_RELAY_LOCATION.relayUrl);
  const [cloudUrl, setCloudUrl] = useState(DEFAULT_CLOUD_BASE_URL);
  // Controlled Advanced disclosure: force-opened when the relay URL is a custom
  // (non-location) origin so the override field isn't hidden; otherwise the user
  // toggles it freely (tracked via onToggle).
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [hasStoredToken, setHasStoredToken] = useState(false);
  const [wsName, setWsName] = useState<string | null>(null);
  const [wsSlug, setWsSlug] = useState<string | null>(null);
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
  // so a signed-out-looking modal still tells the user a session is saved and will
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

  // Cancel any in-flight device-code poll if the modal unmounts (dismissed
  // mid-flow) — otherwise the poll loop leaks until the device code expires.
  useEffect(() => {
    return () => handleRef.current?.cancel();
  }, []);

  const isAuthenticated = status === 'authenticated' || cloudSignedIn;

  // Load the workspace name/slug from the persisted connection record (JP-343).
  // Keyed on the signed-in signal, NOT `status`: a REST-only sign-in leaves
  // `connectionStore.status` 'disconnected' (#285/#286), so a status-only effect
  // would never pick up the freshly-persisted identity.
  useEffect(() => {
    let active = true;
    void (async () => {
      const persisted = await loadConnection();
      if (!active) return;
      setWsName(persisted?.workspaceName ?? null);
      setWsSlug(persisted?.workspaceSlug ?? null);
    })();
    return () => {
      active = false;
    };
  }, [isAuthenticated]);
  const isConnecting = status === 'connecting' || status === 'authenticating';
  const isAwaiting = phase === 'starting' || phase === 'awaiting';
  const isBusy = isConnecting || isAwaiting;

  // The location currently selected in the switcher is derived from the relay
  // URL (no separate state to keep in sync). Undefined → a custom/self-host URL,
  // shown as "Custom" in the switcher.
  const selectedLocation = locationForUrl(relayUrl);

  // Reveal the Advanced override whenever the relay URL is a custom origin (e.g.
  // a persisted self-host URL on mount) so it's never stranded behind a closed
  // disclosure. Manual toggles still work via onToggle.
  useEffect(() => {
    if (locationForUrl(relayUrl) === undefined) setAdvancedOpen(true);
  }, [relayUrl]);

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

      const {
        token,
        expiresAt,
        relayUrl: serverRelayUrl,
        workspaceName,
        workspaceSlug,
      } = await handle.result;
      handleRef.current = null;

      // The relay's device-token response carries the workspace's region-resolved
      // relay origin; adopt it as authoritative so a hosted sign-in lands on the
      // right region relay regardless of the switcher/form default. Fall back to
      // the form value for older relays / self-hosts that don't return one.
      const effectiveRelay = serverRelayUrl?.trim() || trimmedRelay;

      await completeCloudSignIn({
        relayUrl: effectiveRelay,
        cloudBaseUrl: trimmedCloud,
        token,
        expiresAt,
        documentId: currentDocumentId,
        ...(workspaceName !== undefined ? { workspaceName } : {}),
        ...(workspaceSlug !== undefined ? { workspaceSlug } : {}),
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
      onClose();
    } catch (err) {
      console.error('[CloudConnectPanel] Remove workspace failed:', err);
      useNotificationStore
        .getState()
        .error('Could not fully remove the workspace. Some local data may remain.', {
          category: 'permanent',
        });
    } finally {
      setRemoving(false);
      setConfirmRemove(false);
    }
  }, [onClose]);

  // Leave Workspace (JP-370 follow-up) — a member's self-unenrol. Distinct from
  // "Remove workspace" (a local forget): this drops the caller's server-side
  // membership, then tears down the local copy. Owners can't leave (they'd
  // orphan the workspace), so the action is only offered to non-owners.
  const [leaving, setLeaving] = useState(false);
  const handleLeaveWorkspace = useCallback(async () => {
    const ok = await confirmDialog({
      title: 'Leave this workspace?',
      message: 'You will lose access to its shared documents and be removed from its member list.',
      details: 'You can rejoin only with a new invite from the workspace owner.',
      confirmLabel: 'Leave workspace',
      danger: true,
    });
    if (!ok) return;
    setLeaving(true);
    try {
      await webClient.leaveWorkspace();
      // Server membership gone — now drop the local copy + relay identity.
      await removeCurrentWorkspace();
      useNotificationStore.getState().success('You left the workspace.');
      onClose();
    } catch (err) {
      console.error('[CloudConnectPanel] Leave workspace failed:', err);
      const msg =
        err instanceof WebClientError && err.code === 'owner_cannot_leave'
          ? 'Workspace owners can’t leave their own workspace.'
          : 'Could not leave the workspace. Try again.';
      useNotificationStore.getState().error(msg, { category: 'permanent' });
    } finally {
      setLeaving(false);
    }
  }, [onClose]);

  if (isAuthenticated && user) {
    return (
      <div className="cloud-connect">
        <div className="cloud-connect__status cloud-connect__status--ok">
          <span className="cloud-connect__status-dot" />
          Signed in
        </div>

        <dl className="cloud-connect__info">
          <div>
            <dt>Account</dt>
            <dd>
              {user.username || user.id}
              {user.role ? <span className="cloud-connect__role">{user.role}</span> : null}
            </dd>
          </div>
          {wsName || wsSlug ? (
            <div>
              <dt>Workspace</dt>
              <dd>
                {wsName ?? 'Workspace'}
                {wsSlug ? (
                  <span className="cloud-connect__slug">{WORKSPACE_URL_BASE}/{wsSlug}</span>
                ) : null}
              </dd>
            </div>
          ) : null}
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

        {/* JP-370: switch between the workspaces you belong to (renders only
            when there's more than one), then this workspace's members + invites.
            Self-hosts/offline degrade gracefully (both render nothing / a note). */}
        {cloudSignedIn ? <WorkspaceSwitcher /> : null}
        {cloudSignedIn ? (
          <WorkspaceMembersSection isOwner={user.role === 'owner'} currentUserId={user.id} />
        ) : null}

        <button
          type="button"
          className="cloud-connect__btn cloud-connect__btn--secondary"
          onClick={handleDisconnect}
        >
          <LogOut size={16} />
          Disconnect
        </button>

        {/* JP-370: a non-owner can unenrol from the workspace (server-side),
            which also tears down the local copy. Owners can't leave. */}
        {cloudSignedIn && user.role !== 'owner' ? (
          <button
            type="button"
            className="cloud-connect__btn cloud-connect__btn--secondary"
            onClick={() => void handleLeaveWorkspace()}
            disabled={leaving}
          >
            {leaving ? <Loader2 size={16} className="cloud-connect__spin" /> : <DoorOpen size={16} />}
            {leaving ? 'Leaving…' : 'Leave workspace…'}
          </button>
        ) : null}

        <div className="cloud-connect__danger">
          {!confirmRemove ? (
            <button
              type="button"
              className="cloud-connect__btn cloud-connect__btn--danger"
              onClick={() => setConfirmRemove(true)}
            >
              <Trash2 size={16} />
              Remove workspace…
            </button>
          ) : (
            <div className="cloud-connect__confirm" role="alertdialog" aria-label="Remove workspace">
              <p className="cloud-connect__confirm-text">
                Remove this workspace from <strong>this device</strong>? Its documents
                and downloaded offline copies will be deleted locally and the relay
                forgotten. Documents on the server are not affected.
              </p>
              <div className="cloud-connect__confirm-actions">
                <button
                  type="button"
                  className="cloud-connect__btn cloud-connect__btn--danger"
                  onClick={() => void handleRemoveWorkspace()}
                  disabled={removing}
                >
                  {removing ? <Loader2 size={16} className="cloud-connect__spin" /> : <Trash2 size={16} />}
                  {removing ? 'Removing…' : 'Remove everything'}
                </button>
                <button
                  type="button"
                  className="cloud-connect__btn cloud-connect__btn--secondary"
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
    );
  }

  return (
    <div className="cloud-connect">
      <p className="cloud-connect__intro">
        Sign in with DocuShark Cloud to sync your documents across devices in real
        time. Local documents keep working without a connection.
      </p>

      {hasStoredToken && !isBusy ? (
        <div className="cloud-connect__token-stored" role="status">
          <KeyRound size={14} />
          <span>Saved session token — sign in to resume</span>
        </div>
      ) : null}

      {(collabError || signInError) && phase !== 'awaiting' ? (
        <div className="cloud-connect__error" role="alert">
          <AlertCircle size={16} />
          <span>{signInError ?? collabError}</span>
        </div>
      ) : null}

      {phase === 'awaiting' && userCode ? (
        <div className="cloud-connect__device" role="status">
          <p className="cloud-connect__device-hint">
            Your browser should have opened. Confirm this code matches, then
            authorize the device:
          </p>
          <div className="cloud-connect__device-code">{userCode}</div>
          {verificationUri ? (
            <a
              className="cloud-connect__device-link"
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
            className="cloud-connect__btn cloud-connect__btn--secondary"
            onClick={handleCancelSignIn}
          >
            Cancel
          </button>
        </div>
      ) : (
        <>
          <div className="cloud-connect__field cloud-connect__field--location">
            <label htmlFor="relay-location">Location</label>
            <select
              id="relay-location"
              className="cloud-connect__location-select"
              value={selectedLocation?.id ?? 'custom'}
              onChange={(e) => {
                const loc = RELAY_LOCATIONS.find((l) => l.id === e.target.value);
                if (loc) setRelayUrl(loc.relayUrl);
              }}
              disabled={isBusy}
            >
              {RELAY_LOCATIONS.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.label}
                </option>
              ))}
              {/* Only present when the relay URL was overridden under Advanced —
                  not directly selectable, just reflects the custom state. */}
              {!selectedLocation ? <option value="custom">Custom (Advanced)</option> : null}
            </select>
            <p className="cloud-connect__hint">
              Connects to the relay region nearest you. Override the URL under
              Advanced for self-hosting.
            </p>
          </div>

          <button
            type="button"
            className="cloud-connect__btn cloud-connect__btn--primary cloud-connect__btn--block"
            onClick={() => void handleSignIn()}
            disabled={isBusy || !relayUrl.trim() || !cloudUrl.trim()}
          >
            {isBusy ? <Loader2 size={16} className="cloud-connect__spin" /> : <LogIn size={16} />}
            {isBusy
              ? status === 'connecting'
                ? 'Connecting…'
                : status === 'authenticating'
                  ? 'Authenticating…'
                  : 'Signing in…'
              : 'Sign in with DocuShark Cloud'}
          </button>

          {/* Advanced: only self-hosters / testing / enterprise change these.
              Controlled so a custom relay URL force-opens it (see effect). */}
          <details
            className="cloud-connect__advanced"
            open={advancedOpen}
            onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
          >
            <summary className="cloud-connect__advanced-summary">
              <ChevronRight size={14} className="cloud-connect__advanced-caret" />
              Advanced
            </summary>
            <div className="cloud-connect__advanced-body">
              <div className="cloud-connect__field">
                <label htmlFor="relay-url">Relay URL</label>
                <input
                  id="relay-url"
                  type="url"
                  value={relayUrl}
                  onChange={(e) => setRelayUrl(e.target.value)}
                  placeholder={DEFAULT_RELAY_LOCATION.relayUrl}
                  disabled={isBusy}
                  autoComplete="url"
                  required
                />
              </div>

              <div className="cloud-connect__field">
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
            </div>
          </details>
        </>
      )}
    </div>
  );
}

export default CloudConnectPanel;
