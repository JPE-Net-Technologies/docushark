/**
 * Connection Store
 *
 * Centralized store for managing WebSocket connection state.
 * Used by UnifiedSyncProvider and consumed by UI components.
 *
 * Phase 14.1 Collaboration Overhaul
 */

import { create } from 'zustand';
import type { Notification, NotificationOptions } from './notificationStore';

// ============ Types ============

/** Connection status */
export type ConnectionStatus =
  | 'disconnected'  // Not connected
  | 'connecting'    // Attempting to connect
  | 'connected'     // WebSocket open, not yet authenticated
  | 'authenticating' // Sending credentials/token
  | 'authenticated' // Ready for operations
  | 'error';        // Connection or auth error

/**
 * High-level reconnect phase for the UI — distinct from the low-level
 * `ConnectionStatus`. Driven by the connection controller (NOT raw status flips),
 * so an intentional doc-leave/switch/sign-in never looks like an outage.
 *
 * - `online` — authenticated/healthy (or never-connected; no affordance).
 * - `reconnecting` — an unexpected drop the provider is auto-retrying; show the
 *   single updatable "reconnecting…" toast.
 * - `offline` — terminal: retries exhausted, auth rejected, or the user cancelled;
 *   show the connection banner (the toast is dismissed).
 */
export type ReconnectPhase = 'online' | 'reconnecting' | 'offline';

/** Authentication method */
export type AuthMethod = 'token' | 'credentials' | 'none';

/** Host connection info */
export interface HostInfo {
  /** Host address (e.g., "192.168.1.100:9876") */
  address: string;
  /** Full WebSocket URL */
  url: string;
  /** Host display name (if known) */
  name?: string;
}

/** Authenticated user info */
export interface AuthenticatedUser {
  id: string;
  username: string;
  role?: string | undefined;
}

/** Connection state */
interface ConnectionState {
  /** Current connection status */
  status: ConnectionStatus;
  /** Host we're connected/connecting to */
  host: HostInfo | null;
  /** Authentication method being used */
  authMethod: AuthMethod;
  /** Authenticated user (after successful auth) */
  user: AuthenticatedUser | null;
  /** JWT token (for reconnection) */
  token: string | null;
  /** Token expiration timestamp */
  tokenExpiresAt: number | null;
  /** Error message (if status is 'error') */
  error: string | null;
  /** Number of reconnection attempts */
  reconnectAttempts: number;
  /** Timestamp of last successful connection */
  lastConnectedAt: number | null;
  /** Whether auto-reconnect is enabled */
  autoReconnect: boolean;
  /** High-level reconnect phase for the UI (online/reconnecting/offline). */
  reconnectPhase: ReconnectPhase;
}

/** Connection actions */
interface ConnectionActions {
  /** Set connection status */
  setStatus: (status: ConnectionStatus, error?: string) => void;
  /** Set host info (on connect attempt) */
  setHost: (host: HostInfo | null) => void;
  /** Set authentication method */
  setAuthMethod: (method: AuthMethod) => void;
  /** Set authenticated user (on auth success) */
  setUser: (user: AuthenticatedUser | null) => void;
  /** Set JWT token (received from server) */
  setToken: (token: string | null, expiresAt?: number | null) => void;
  /** Increment reconnect attempts */
  incrementReconnectAttempts: () => void;
  /** Reset reconnect attempts (on successful connect) */
  resetReconnectAttempts: () => void;
  /** Set auto-reconnect flag */
  setAutoReconnect: (enabled: boolean) => void;
  /** Set the high-level reconnect phase (driven by the connection controller). */
  setReconnectPhase: (phase: ReconnectPhase) => void;
  /** Reset all connection state (on disconnect) */
  reset: () => void;
  /** Check if token is still valid */
  isTokenValid: () => boolean;
}

// ============ Initial State ============

const initialState: ConnectionState = {
  status: 'disconnected',
  host: null,
  authMethod: 'none',
  user: null,
  token: null,
  tokenExpiresAt: null,
  error: null,
  reconnectAttempts: 0,
  lastConnectedAt: null,
  autoReconnect: true,
  reconnectPhase: 'online',
};

// ============ Store ============

/**
 * Connection store for managing WebSocket connection state.
 */
export const useConnectionStore = create<ConnectionState & ConnectionActions>()(
  (set, get) => ({
    ...initialState,

    setStatus: (status, error) => {
      const updates: Partial<ConnectionState> = { status };

      if (error !== undefined) {
        updates.error = error;
      } else if (status !== 'error') {
        updates.error = null;
      }

      // Track last successful connection
      if (status === 'authenticated') {
        updates.lastConnectedAt = Date.now();
      }

      set(updates);
    },

    setHost: (host) => {
      set({ host });
    },

    setAuthMethod: (method) => {
      set({ authMethod: method });
    },

    setUser: (user) => {
      set({ user });
    },

    setToken: (token, expiresAt = null) => {
      set({ token, tokenExpiresAt: expiresAt });
    },

    incrementReconnectAttempts: () => {
      set((state) => ({ reconnectAttempts: state.reconnectAttempts + 1 }));
    },

    resetReconnectAttempts: () => {
      set({ reconnectAttempts: 0 });
    },

    setAutoReconnect: (enabled) => {
      set({ autoReconnect: enabled });
    },

    setReconnectPhase: (reconnectPhase) => {
      set({ reconnectPhase });
    },

    reset: () => {
      set(initialState);
    },

    isTokenValid: () => {
      const { token, tokenExpiresAt } = get();
      if (!token) return false;
      if (!tokenExpiresAt) return true; // No expiry means assume valid
      return Date.now() < tokenExpiresAt;
    },
  })
);

// ============ Selectors ============

/**
 * Check if currently connected and authenticated.
 */
export function useIsConnected(): boolean {
  return useConnectionStore((state) => state.status === 'authenticated');
}

/**
 * Check if currently in a connecting/authenticating state.
 */
export function useIsConnecting(): boolean {
  return useConnectionStore((state) =>
    state.status === 'connecting' || state.status === 'authenticating'
  );
}

/**
 * Get connection error if any.
 */
export function useConnectionError(): string | null {
  return useConnectionStore((state) =>
    state.status === 'error' ? state.error : null
  );
}

/**
 * Get current host info.
 */
export function useCurrentHost(): HostInfo | null {
  return useConnectionStore((state) => state.host);
}

/**
 * Get authenticated user.
 */
export function useAuthenticatedUser(): AuthenticatedUser | null {
  return useConnectionStore((state) => state.user);
}

/**
 * True when the renderer has an authenticated relay session. Replaces
 * the legacy `serverMode === 'client'` / `isRelayMode()` checks from
 * the deleted `useRelayStore`.
 */
export function useIsRelayAuthenticated(): boolean {
  return useConnectionStore((state) => state.status === 'authenticated');
}

/** Imperative variant for non-React callers. */
export function isRelayAuthenticated(): boolean {
  return useConnectionStore.getState().status === 'authenticated';
}

// ============ Notification Integration ============

/** Token refresh buffer - refresh 5 minutes before expiry */
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/** Token warning threshold - warn 10 minutes before expiry */
const TOKEN_WARNING_THRESHOLD_MS = 10 * 60 * 1000;

/** Minimum time between token checks */
const TOKEN_CHECK_INTERVAL_MS = 60 * 1000;

/**
 * Intentional session-transition toast mute (JP-190).
 *
 * The relay WS is **per-document**, so an intentional leave / doc-switch /
 * sign-in tears the socket down and brings a new one up. Without this, that
 * churn fires the generic "Disconnected from server" / "Reconnected to server"
 * toasts as if the network had dropped — which is what made leaving a doc look
 * like a disconnect. The collaboration session lifecycle calls
 * `muteConnectionToasts()` around those intentional transitions; an *unexpected*
 * drop (the provider's own auto-reconnect via `handleClose`/`scheduleReconnect`)
 * never calls it, so genuine connection-loss toasts still fire. Time-bounded so
 * a real drop shortly after a transition is never permanently swallowed.
 */
let connectionToastMuteUntil = 0;

/** Suppress the connection up/down toasts for `ms` (an intentional transition). */
export function muteConnectionToasts(ms = 8000): void {
  connectionToastMuteUntil = Date.now() + ms;
}

/**
 * Token expiration monitoring state.
 */
interface TokenMonitorState {
  checkInterval: ReturnType<typeof setInterval> | null;
  warningShown: boolean;
  onTokenExpiring: (() => void) | undefined;
  onTokenExpired: (() => void) | undefined;
}

const tokenMonitorState: TokenMonitorState = {
  checkInterval: null,
  warningShown: false,
  onTokenExpiring: undefined,
  onTokenExpired: undefined,
};

/**
 * Get time until token expires in milliseconds.
 * Returns null if no expiration is set.
 */
export function getTokenTimeRemaining(): number | null {
  const { tokenExpiresAt } = useConnectionStore.getState();
  if (!tokenExpiresAt) return null;
  return tokenExpiresAt - Date.now();
}

/**
 * Check if token needs refresh (within buffer period).
 */
export function tokenNeedsRefresh(): boolean {
  const remaining = getTokenTimeRemaining();
  if (remaining === null) return false;
  return remaining > 0 && remaining <= TOKEN_REFRESH_BUFFER_MS;
}

/**
 * Check if token is about to expire (within warning period).
 */
export function tokenIsExpiringSoon(): boolean {
  const remaining = getTokenTimeRemaining();
  if (remaining === null) return false;
  return remaining > 0 && remaining <= TOKEN_WARNING_THRESHOLD_MS;
}

/**
 * Start monitoring token expiration.
 * Calls callbacks when token is about to expire or has expired.
 */
export function startTokenExpirationMonitor(options: {
  onTokenExpiring?: () => void;
  onTokenExpired?: () => void;
}): void {
  stopTokenExpirationMonitor();

  tokenMonitorState.onTokenExpiring = options.onTokenExpiring;
  tokenMonitorState.onTokenExpired = options.onTokenExpired;
  tokenMonitorState.warningShown = false;

  const checkToken = (): void => {
    const { token, tokenExpiresAt, status } = useConnectionStore.getState();

    // Only check when authenticated with a token that has expiry
    if (status !== 'authenticated' || !token || !tokenExpiresAt) return;

    const remaining = tokenExpiresAt - Date.now();

    if (remaining <= 0) {
      // Token has expired
      tokenMonitorState.onTokenExpired?.();
      tokenMonitorState.warningShown = false;
    } else if (remaining <= TOKEN_REFRESH_BUFFER_MS) {
      // Token needs refresh - trigger callback
      if (!tokenMonitorState.warningShown) {
        tokenMonitorState.onTokenExpiring?.();
        tokenMonitorState.warningShown = true;
      }
    } else if (remaining > TOKEN_WARNING_THRESHOLD_MS) {
      // Token is healthy - reset warning state
      tokenMonitorState.warningShown = false;
    }
  };

  // Check immediately
  checkToken();

  // Set up periodic check
  tokenMonitorState.checkInterval = setInterval(checkToken, TOKEN_CHECK_INTERVAL_MS);
}

/**
 * Stop monitoring token expiration.
 */
export function stopTokenExpirationMonitor(): void {
  if (tokenMonitorState.checkInterval) {
    clearInterval(tokenMonitorState.checkInterval);
    tokenMonitorState.checkInterval = null;
  }
  tokenMonitorState.warningShown = false;
  tokenMonitorState.onTokenExpiring = undefined;
  tokenMonitorState.onTokenExpired = undefined;
}

// ============ Connection controller (reconnect phase + single toast) ============

/** Lazy notification API — avoids a static circular import with notificationStore. */
type ConnectionNotifApi = {
  notify: (o: NotificationOptions) => string;
  update: (id: string, changes: Partial<Pick<Notification, 'message' | 'severity'>>) => void;
  dismiss: (id: string) => void;
  error: (message: string, options?: { category?: 'transient' | 'permanent' }) => void;
};
let connectionNotif: ConnectionNotifApi | null = null;

/** Id of the live "reconnecting…" toast, reused across a whole drop→retry cycle. */
let reconnectToastId: string | null = null;
/** True once we've authenticated at least once (a first-connect failure isn't an "outage"). */
let everAuthenticated = false;
/** Latched when reconnect is terminal (gave up / cancelled) until a fresh connect or manual retry. */
let reconnectTerminal = false;

/** ms a resolved "Reconnected" toast lingers before auto-dismissing. */
const RECONNECTED_TOAST_MS = 3000;

function dismissReconnectToast(): void {
  if (reconnectToastId) connectionNotif?.dismiss(reconnectToastId);
  reconnectToastId = null;
}

/**
 * The user cancelled reconnecting (Cancel on the toast). Stop showing the toast
 * and go `offline` so the banner takes over. Latched until a successful reconnect
 * or an explicit manual retry (`clearReconnectTerminal`).
 */
export function markReconnectCancelled(): void {
  reconnectTerminal = true;
  dismissReconnectToast();
  useConnectionStore.getState().setReconnectPhase('offline');
}

/** A manual reconnect was requested — un-latch so the reconnecting UI can show again. */
export function clearReconnectTerminal(): void {
  reconnectTerminal = false;
}

/** Test-only: reset the module-level controller latches. */
export function __resetConnectionControllerForTests(): void {
  reconnectToastId = null;
  everAuthenticated = false;
  reconnectTerminal = false;
  connectionToastMuteUntil = 0;
}

/**
 * Set up connection-status notifications + the high-level reconnect phase. Call
 * once at app startup.
 *
 * An UNEXPECTED drop after we've authenticated shows ONE persistent
 * "reconnecting…" toast that updates in place (no per-status-flip spam) with a
 * Cancel action; a successful reconnect resolves it to a brief "Reconnected"; a
 * terminal give-up (max attempts) or the user cancelling flips the phase to
 * `offline` (the banner takes over) and dismisses the toast. Intentional
 * transitions (leave / switch / sign-in) are muted via `muteConnectionToasts`,
 * so they never enter the reconnecting phase.
 */
export function initConnectionNotifications(): () => void {
  // Dynamic import to avoid a circular dependency with notificationStore.
  import('./notificationStore').then((module) => {
    const store = module.useNotificationStore.getState();
    connectionNotif = {
      notify: (o) => store.notify(o),
      update: (id, changes) => store.update(id, changes),
      dismiss: (id) => store.dismiss(id),
      error: (msg, opts) => store.error(msg, opts),
    };
  });

  let previousStatus: ConnectionStatus = 'disconnected';

  return useConnectionStore.subscribe((state) => {
    const { status, error, reconnectAttempts } = state;
    if (status === previousStatus) return;
    previousStatus = status;

    const { setReconnectPhase } = useConnectionStore.getState();
    const muted = Date.now() < connectionToastMuteUntil;
    const gaveUp = status === 'error' && !!error && /max reconnect/i.test(error);

    // Reconnected (or first successful connect): resolve any live toast.
    if (status === 'authenticated') {
      if (reconnectToastId) {
        const id = reconnectToastId;
        reconnectToastId = null;
        connectionNotif?.update(id, { message: 'Reconnected', severity: 'success' });
        setTimeout(() => connectionNotif?.dismiss(id), RECONNECTED_TOAST_MS);
      }
      reconnectTerminal = false;
      everAuthenticated = true;
      if (muted) connectionToastMuteUntil = 0;
      setReconnectPhase('online');
      return;
    }

    // Before the first successful auth, keep legacy behavior: surface errors as a
    // toast, no reconnect phase/banner (a first-connect failure isn't an outage).
    if (!everAuthenticated) {
      if (status === 'error' && error) connectionNotif?.error(error, { category: 'permanent' });
      return;
    }

    // Terminal: gave up (max attempts) or the user cancelled. The banner owns it.
    if (reconnectTerminal || gaveUp) {
      reconnectTerminal = true;
      dismissReconnectToast();
      setReconnectPhase('offline');
      if (status === 'error' && error) connectionNotif?.error(error, { category: 'permanent' });
      return;
    }

    // Intentional-transition churn — stay quiet (don't enter the reconnecting UI).
    if (muted) return;

    // Transient drop: the provider is auto-retrying. Show/keep ONE updatable toast.
    if (status === 'disconnected' || status === 'connecting' || status === 'error') {
      const message =
        reconnectAttempts > 0
          ? `Workspace connection lost — reconnecting… (attempt ${reconnectAttempts})`
          : 'Workspace connection lost — reconnecting…';
      if (reconnectToastId) {
        connectionNotif?.update(reconnectToastId, { message });
      } else {
        reconnectToastId =
          connectionNotif?.notify({
            message,
            severity: 'warning',
            category: 'transient',
            duration: 0,
            actionLabel: 'Cancel',
            onAction: () => {
              void import('../collaboration/collaborationStore').then((m) =>
                m.useCollaborationStore.getState().cancelReconnect(),
              );
            },
          }) ?? null;
      }
      setReconnectPhase('reconnecting');
    }
  });
}

export default useConnectionStore;
