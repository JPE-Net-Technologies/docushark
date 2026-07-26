/**
 * Cloud connect panel — the body of the Cloud sign-in modal.
 *
 * Customer-facing: the path of least resistance is one prominent **Sign in with
 * DocuShark Cloud** button (it works on the pre-filled defaults). The Workspace
 * URL + Cloud URL inputs — only self-hosters, testing, and (eventually)
 * enterprise touch them — live under a collapsed **Advanced** disclosure.
 * Customer copy says "workspace", never "relay" (the internal component name).
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
  CheckCircle2,
  ExternalLink,
  Loader2,
  KeyRound,
  Trash2,
  ChevronRight,
  DoorOpen,
  Users,
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
import {
  beginCloudSignIn,
  CloudAuthError,
  type CloudSignInResult,
  type ResumedSignInHandle,
} from '../../api/cloudAuth';
import {
  savePendingSignIn,
  clearPendingSignIn,
  type PendingSignIn,
} from '../../api/pendingSignIn';
import { ensureSignInResumed } from '../../api/resumeInterruptedSignIn';
import {
  RELAY_LOCATIONS,
  DEFAULT_RELAY_LOCATION,
  locationForUrl,
} from '../../api/relayLocations';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { RichSelect } from '../components/RichSelect';
import { InitialsAvatar } from '../components/InitialsAvatar';
import { RoleBadge, type BadgeRole } from '../components/RoleBadge';
import { openAccessPanel } from '../access/accessPanelStore';

/** Local sign-in phase, distinct from the connection-store status. */
type SignInPhase = 'idle' | 'starting' | 'awaiting' | 'success' | 'error';

/** How long the "Connected" confirmation beat lingers before the panel flips
 *  to the signed-in view. Overridable for tests. */
const SUCCESS_BEAT_MS = 1200;

export interface CloudConnectPanelProps {
  /** Dismiss the surrounding modal (called after a workspace is removed). */
  onClose: () => void;
  /**
   * Reports whether a device-code sign-in is pending (JP-420). The modal uses
   * this to block accidental backdrop dismissal while the poll is in flight.
   */
  onBusyChange?: (busy: boolean) => void;
  /** Test seam: shorten the success-beat delay. */
  successBeatMs?: number;
}

export function CloudConnectPanel({
  onClose,
  onBusyChange,
  successBeatMs = SUCCESS_BEAT_MS,
}: CloudConnectPanelProps) {
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
  /** Workspace name shown in the post-sign-in confirmation beat. */
  const [successName, setSuccessName] = useState<string | null>(null);
  /** True when the verification page could not be opened (popup blocked). */
  const [browserOpenFailed, setBrowserOpenFailed] = useState(false);
  const handleRef = useRef<ResumedSignInHandle | null>(null);
  /** Mirrors `phase` for the mount-only resume effect, which must not re-run on it. */
  const phaseRef = useRef<SignInPhase>('idle');
  phaseRef.current = phase;

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

  // Stop the in-flight poll if the modal unmounts, so the loop doesn't leak
  // until the device code expires.
  //
  // Deliberately does NOT clear the persisted grant (JP-455): an unmount is not
  // the user abandoning the sign-in — it's a dismissal, a re-render, or the page
  // going away — and destroying the grant here is exactly what stranded an
  // already-authorized device. Only genuinely terminal outcomes (success,
  // failure, explicit Cancel) clear it.
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

  // Block accidental backdrop dismissal for the whole NON-TERMINAL window
  // (JP-455), not just the poll (JP-420's original, narrower rule).
  //
  // The old rule reasoned that after the token lands dismissal is harmless —
  // true of the token, false of the user: `success` and the WS connect are
  // exactly when the signed-in view hasn't painted yet, so the panel still
  // looks unfinished and a stray click-out reads as "get me out of here",
  // stranding the flow. The invariant is now: the backdrop dismisses only on a
  // state the user can act on — the signed-out form, an error, or the
  // signed-in view. Escape and Cancel remain the explicit exits.
  const isTransitional = isAwaiting || phase === 'success' || isConnecting;
  useEffect(() => {
    onBusyChange?.(isTransitional);
  }, [isTransitional, onBusyChange]);

  // Success beat (JP-420): hold a brief "Connected" confirmation, then let the
  // signed-in view take over.
  useEffect(() => {
    if (phase !== 'success') return;
    const timer = window.setTimeout(() => setPhase('idle'), successBeatMs);
    return () => window.clearTimeout(timer);
  }, [phase, successBeatMs]);

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

  /**
   * Shared tail for both paths that can land a token — a fresh sign-in and a
   * grant resumed from storage (JP-455). Commits the session and clears the
   * persisted grant, since the flow has now terminated successfully.
   */
  const finishWithToken = useCallback(
    async (result: CloudSignInResult, fallbackRelayUrl: string, cloudBase: string) => {
      const { token, expiresAt, relayUrl: serverRelayUrl, workspaceName, workspaceSlug } = result;

      // The relay's device-token response carries the workspace's region-resolved
      // relay origin; adopt it as authoritative so a hosted sign-in lands on the
      // right region relay regardless of the switcher/form default. Fall back to
      // the form value for older relays / self-hosts that don't return one.
      const effectiveRelay = serverRelayUrl?.trim() || fallbackRelayUrl;

      await completeCloudSignIn({
        relayUrl: effectiveRelay,
        cloudBaseUrl: cloudBase,
        token,
        expiresAt,
        documentId: currentDocumentId,
        ...(workspaceName !== undefined ? { workspaceName } : {}),
        ...(workspaceSlug !== undefined ? { workspaceSlug } : {}),
      });

      await clearPendingSignIn();
      setSuccessName(workspaceName ?? null);
      setPhase('success');
      setUserCode(null);
      setVerificationUri(null);
      setBrowserOpenFailed(false);
    },
    [currentDocumentId],
  );

  /** Terminal failure handling shared by both paths. */
  const failSignIn = useCallback(async (err: unknown) => {
    handleRef.current = null;
    await clearPendingSignIn();
    if (err instanceof CloudAuthError && err.code === 'cancelled') {
      setPhase('idle');
      return;
    }
    const message = err instanceof Error ? err.message : 'Sign-in failed. Please try again.';
    setSignInError(message);
    setPhase('error');
  }, []);

  // Resume an interrupted sign-in (JP-455). If a grant issued before the page
  // went away is still live, show the live flow rather than a fresh form — the
  // user may already have authorized, and the verification page promised the app
  // would finish signing in automatically.
  //
  // `ensureSignInResumed` owns the poll and the session commit (one poller per
  // grant, see its module doc), so this effect only mirrors it into the UI —
  // notably it does NOT call `finishWithToken`, or the token would be redeemed
  // twice when boot resumed first.
  useEffect(() => {
    let active = true;
    void (async () => {
      // Never stomp a flow the user has already started in this mount.
      if (handleRef.current || phaseRef.current !== 'idle') return;
      const resume = await ensureSignInResumed();
      if (!active || !resume) return;
      if (handleRef.current || phaseRef.current !== 'idle') return;

      setUserCode(resume.grant.userCode);
      setVerificationUri(resume.grant.verificationUri);
      setPhase('awaiting');

      try {
        const result = await resume.done;
        if (!active) return;
        setSuccessName(result.workspaceName ?? null);
        setPhase('success');
        setUserCode(null);
        setVerificationUri(null);
      } catch (err) {
        if (!active) return;
        if (err instanceof CloudAuthError && err.code === 'cancelled') {
          setPhase('idle');
          return;
        }
        setSignInError(err instanceof Error ? err.message : 'Sign-in failed. Please try again.');
        setPhase('error');
      }
    })();
    return () => {
      active = false;
    };
    // Mount-only: a resume is a boot-time concern, not a reaction to state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSignIn = useCallback(async () => {
    const trimmedRelay = relayUrl.trim();
    const trimmedCloud = cloudUrl.trim().replace(/\/+$/, '');
    if (!trimmedRelay || !trimmedCloud) return;

    setSignInError(null);
    setUserCode(null);
    setVerificationUri(null);
    setBrowserOpenFailed(false);
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
        setSuccessName(persisted.workspaceName ?? null);
        setPhase('success');
        return;
      }

      const handle = await beginCloudSignIn(trimmedCloud);
      handleRef.current = handle;
      setUserCode(handle.userCode);
      setVerificationUri(handle.verificationUriComplete);
      setBrowserOpenFailed(handle.browserOpenFailed);
      setPhase('awaiting');

      // Persist BEFORE awaiting the token: the whole point is to survive a
      // teardown that happens while we're waiting (JP-455).
      const pending: PendingSignIn = { ...handle.grant, relayUrl: trimmedRelay };
      await savePendingSignIn(pending);

      const result = await handle.result;
      handleRef.current = null;
      await finishWithToken(result, trimmedRelay, trimmedCloud);
    } catch (err) {
      await failSignIn(err);
    }
  }, [relayUrl, cloudUrl, finishWithToken, failSignIn]);

  const handleCancelSignIn = useCallback(() => {
    handleRef.current?.cancel();
    handleRef.current = null;
    // An explicit Cancel is terminal, so the grant is dropped and will NOT be
    // resumed on the next mount. Contrast the unmount cleanup below, which only
    // stops the poll and deliberately leaves the grant standing (JP-455).
    void clearPendingSignIn();
    setPhase('idle');
    setUserCode(null);
    setVerificationUri(null);
    setBrowserOpenFailed(false);
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

  // Confirmation beat: shown briefly after a successful sign-in, BEFORE the
  // signed-in view takes over (the isAuthenticated branch below would
  // otherwise swallow it the instant the store flips).
  if (phase === 'success') {
    return (
      <div className="cloud-connect">
        <div className="cloud-connect__success" role="status">
          <CheckCircle2 size={20} aria-hidden="true" />
          <span>{successName ? `Connected to ${successName}` : 'Connected'}</span>
        </div>
      </div>
    );
  }

  if (isAuthenticated && user) {
    return (
      <div className="cloud-connect">
        <div className="cloud-connect__status cloud-connect__status--ok">
          <span className="cloud-connect__status-dot" />
          Signed in
        </div>

        {/* Identity as a person, not a record (JP-456). This used to lead with
            the account UUID while the email sat two rows below, and put the role
            badge inline where it wrapped mid-word ("OWN ER"). */}
        <div className="cloud-connect__identity">
          <InitialsAvatar name={user.username || user.id} size={32} />
          <span className="cloud-connect__identity-text">
            <span className="cloud-connect__identity-name">{user.username || user.id}</span>
            {wsName ? (
              <span className="cloud-connect__identity-sub">in {wsName}</span>
            ) : null}
          </span>
          {user.role ? <RoleBadge role={user.role as BadgeRole} /> : null}
        </div>

        <dl className="cloud-connect__info">
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
            <dt>Syncing</dt>
            <dd>
              {sessionLive
                ? 'This document is syncing.'
                : 'Nothing open yet — open a cloud document to sync it.'}
            </dd>
          </div>
        </dl>

        {/* The connection URL is diagnostic, not something a customer acts on —
            AGENTS.md keeps "relay" out of customer copy, and a raw WebSocket URL
            as a headline field is that rule broken harder. Kept, but folded away
            for when something needs debugging. */}
        <details className="cloud-connect__advanced">
          <summary className="cloud-connect__advanced-summary">
            <ChevronRight size={14} className="cloud-connect__advanced-caret" />
            Connection details
          </summary>
          <div className="cloud-connect__advanced-body">
            <dl className="cloud-connect__info">
              <div>
                <dt>Address</dt>
                <dd>{host?.url ?? '—'}</dd>
              </div>
            </dl>
          </div>
        </details>

        {/* JP-370: switch between the workspaces you belong to (renders only
            when there's more than one). Members + invites moved out to the
            access panel (JP-456) — they belong beside document access, not
            inside a sign-in dialog. */}
        {cloudSignedIn ? <WorkspaceSwitcher /> : null}

        {cloudSignedIn ? (
          <button
            type="button"
            className="cloud-connect__btn cloud-connect__btn--secondary"
            onClick={() => openAccessPanel({ scope: 'workspace' })}
          >
            <Users size={16} />
            Manage access
          </button>
        ) : null}

        <button
          type="button"
          className="cloud-connect__btn cloud-connect__btn--secondary"
          onClick={handleDisconnect}
        >
          <LogOut size={16} />
          Sign out
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
                and downloaded offline copies will be deleted locally and the saved
                workspace connection forgotten. Documents on the server are not
                affected.
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
          {/* Don't assert the browser opened when it demonstrably didn't — a
              blocked popup used to leave the user staring at a code with no page
              to type it into, and no hint that the link below was the way out. */}
          <p className="cloud-connect__device-hint">
            {browserOpenFailed
              ? 'Open the verification page below, then check this code matches and authorize the device:'
              : 'Your browser should have opened. Confirm this code matches, then authorize the device:'}
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
            <label>Location</label>
            <RichSelect
              value={selectedLocation?.id ?? 'custom'}
              onChange={(id) => {
                const loc = RELAY_LOCATIONS.find((l) => l.id === id);
                if (loc) setRelayUrl(loc.relayUrl);
              }}
              // "Custom" only appears when the relay URL was overridden under
              // Advanced — it reflects the state rather than being a choice.
              items={[
                ...RELAY_LOCATIONS.map((loc) => ({ value: loc.id, label: loc.label })),
                ...(!selectedLocation ? [{ value: 'custom', label: 'Custom (Advanced)' }] : []),
              ]}
              ariaLabel="Workspace location"
              className={`cloud-connect__location-select${isBusy ? ' cloud-connect__control-disabled' : ''}`}
            />
            <p className="cloud-connect__hint">
              Connects your workspace to the region nearest you. Override the
              URL under Advanced for self-hosting.
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
                <label htmlFor="relay-url">Workspace URL</label>
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
