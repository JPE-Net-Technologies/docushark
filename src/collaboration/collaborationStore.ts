/**
 * Collaboration Store
 *
 * Manages the collaboration state and ties together:
 * - YjsDocument for CRDT-based shape sync
 * - UnifiedSyncProvider for WebSocket communication
 * - Integration with documentStore for local state
 *
 * This store handles:
 * - Starting/stopping collaboration sessions
 * - Syncing local changes to remote peers
 * - Applying remote changes to local state
 * - Managing presence (cursor positions, selections)
 *
 * Phase 14.1 Collaboration Overhaul - Uses UnifiedSyncProvider
 */

import { create } from 'zustand';
import { IndexeddbPersistence } from 'y-indexeddb';
import { YjsDocument } from './YjsDocument';
import { UnifiedSyncProvider, AwarenessUserState } from './UnifiedSyncProvider';
import { useRelayDocumentStore } from '../store/relayDocumentStore';
import { reattachAwaitingTeamDocument, syncCurrentDocToRelayOnConnect } from '../store/persistenceStore';
import { getSyncStateManager } from './SyncStateManager';
import {
  useConnectionStore,
  type ConnectionStatus,
  startTokenExpirationMonitor,
  stopTokenExpirationMonitor,
  muteConnectionToasts,
} from '../store/connectionStore';
import { attemptTokenRefresh } from '../api/tokenRefresh';
import { usePresenceStore } from '../store/presenceStore';
import { RelayClient } from '../api/relayClient';
import { RestDocumentProvider } from '../api/restDocumentProvider';
import { clearJwt, saveConnection } from '../api/relayConnection';
import { useNotificationStore } from '../store/notificationStore';
import { useDocumentRegistry } from '../store/documentRegistry';
import { isRemoteDocument } from '../types/DocumentRegistry';
import type { Shape } from '../shapes/Shape';
import type { DocEvent } from './protocol';
import { isUnknownDocError } from './protocol';
import { throttle } from '../utils/requestUtils';
import { getAdaptiveBudget } from '../platform/adaptiveBudget';
import { relayFetch } from '../platform/relayFetch';

/** Convert a WS server URL to the matching REST origin for the same relay. */
function wsUrlToHttpOrigin(wsUrl: string): string {
  return wsUrl
    .replace(/^ws:\/\//, 'http://')
    .replace(/^wss:\/\//, 'https://')
    .replace(/\/ws\/?$/, '');
}

/**
 * Collaboration session configuration
 */
export interface CollaborationConfig {
  /** WebSocket URL (e.g., ws://localhost:9876/ws) */
  serverUrl: string;
  /** Document ID to collaborate on */
  documentId: string;
  /** Relay app token (RS256 JWT) obtained via Cloud sign-in. */
  token?: string;
  /** Local user info */
  user: {
    id: string;
    name: string;
    color: string;
  };
}

/**
 * Remote user with awareness state
 */
export interface RemoteUser extends AwarenessUserState {
  clientId: number;
}

/**
 * Collaboration store state
 */
interface CollaborationState {
  /** Whether collaboration is active */
  isActive: boolean;
  /** Current connection status */
  connectionStatus: ConnectionStatus;
  /** Whether the document is synced with server */
  isSynced: boolean;
  /**
   * Whether the local `y-indexeddb` persistence has finished loading the
   * Y.Doc from IndexedDB (JP-108 step 3). The CRDT→view adopt must wait for
   * this AND `isSynced`, so it adopts the fully-loaded Y.Doc (persisted offline
   * edits + relay state) rather than a partial one.
   */
  isIdbSynced: boolean;
  /** Connection error message */
  error: string | null;
  /** Remote users currently viewing the document */
  remoteUsers: RemoteUser[];
  /** Current collaboration config */
  config: CollaborationConfig | null;
  /**
   * Monotonic counter bumped on every `startSession` — i.e. every time a NEW
   * `YjsDocument` instance is created (incl. `switchDocument`'s restart). React
   * effects that bind to the Y.Doc (registering `onShapeChange` etc.) depend on
   * this so they re-subscribe to the new instance; without it a `switchDocument`
   * restart (where `isActive` nets true→true) would leave callbacks registered
   * on the old, destroyed Y.Doc and remote changes would never reach the view.
   */
  sessionEpoch: number;
}

/**
 * Collaboration store actions
 */
interface CollaborationActions {
  /** Start a collaboration session */
  startSession: (config: CollaborationConfig) => void;
  /** Stop the current collaboration session (full sign-out: also drops the
   *  relay connection/auth). Used by the disconnect button + `switchDocument`. */
  stopSession: () => void;
  /**
   * Leave the current document but **stay signed in** to the relay. Tears down
   * the per-doc CRDT engine + WS (so the presence frame clears and you leave
   * the doc's awareness) while preserving `connectionStore` auth — so reopening
   * a relay doc reconnects with the existing token instead of falling back to
   * offline/re-login. Used when navigating from a relay doc to a local one.
   */
  leaveDocument: () => void;

  // Local -> Remote sync
  /** Sync a shape change to remote peers */
  syncShape: (shape: Shape) => void;
  /** Sync multiple shapes to remote peers */
  syncShapes: (shapes: Shape[]) => void;
  /** Sync a shape deletion to remote peers */
  syncDeleteShape: (shapeId: string) => void;
  /** Sync shape order to remote peers */
  syncShapeOrder: (order: string[]) => void;
  /**
   * Sync the document name (a rename) to peers via the Y.Doc `metadata` map
   * (CRDT-native rename, so it propagates + persists like shapes rather than
   * via the REST path that `isCollabContentDoc` suppresses). Bumps
   * `updatedAt` so the relay's flatten can tell a fresh CRDT rename from a
   * stale title vs an out-of-band REST rename.
   */
  syncDocumentName: (name: string) => void;

  // Document switching
  /** Switch to a different document for CRDT sync */
  switchDocument: (docId: string) => void;

  // Presence
  /** Update local cursor position */
  updateCursor: (x: number, y: number) => void;
  /** Update local selection */
  updateSelection: (shapeIds: string[]) => void;

  // Internal
  /** Set connection status (internal) */
  _setConnectionStatus: (status: ConnectionStatus) => void;
  /** Set synced state (internal) */
  _setSynced: (synced: boolean) => void;
  /** Set IndexedDB-loaded state (internal) */
  _setIdbSynced: (synced: boolean) => void;
  /** Set error (internal) */
  _setError: (error: string | null) => void;
  /** Update remote users (internal) */
  _updateRemoteUsers: (users: Map<number, AwarenessUserState>) => void;

  // Access to internals (for document store integration)
  /** Get the YjsDocument instance */
  getYjsDocument: () => YjsDocument | null;
  /** Get the UnifiedSyncProvider instance */
  getSyncProvider: () => UnifiedSyncProvider | null;
}

/**
 * Internal state (not in Zustand to avoid serialization issues)
 */
let yjsDoc: YjsDocument | null = null;
let syncProvider: UnifiedSyncProvider | null = null;
/**
 * Local CRDT persistence for the shared Y.Doc (JP-108 step 3). Loads the doc's
 * persisted Yjs state from IndexedDB at session start and persists every update,
 * so offline edits survive reload and reconcile via the normal sync handshake
 * instead of being clobbered. Room-keyed per relay+doc.
 */
let idbPersistence: IndexeddbPersistence | null = null;
let relayClient: RelayClient | null = null;
let connectionUnsubscribe: (() => void) | null = null;
let awarenessUnsubscribe: (() => void) | null = null;

/**
 * Cursor + selection broadcasts are throttled to the device's collab cadence
 * (JP-101) — a ~30fps cap on capable devices, slower on low-power ones — so
 * the relay isn't flooded with one awareness update per pointer move. Created
 * once at module load so the throttle window persists across calls; the bodies
 * read `syncProvider` lazily so a reconnect's new provider is picked up.
 * Trailing edge is on, so the final resting position/selection is never lost.
 */
const broadcastCadenceMs = getAdaptiveBudget().cursorBroadcastMs;
const broadcastCursor = throttle(
  (x: number, y: number) => {
    syncProvider?.updateCursor(x, y);
  },
  { interval: broadcastCadenceMs, leading: true, trailing: true }
);
const broadcastSelection = throttle(
  (shapeIds: string[]) => {
    syncProvider?.updateSelection(shapeIds);
  },
  { interval: broadcastCadenceMs, leading: true, trailing: true }
);

/**
 * Drop the relay session and prompt re-auth — the fallback when a silent
 * token refresh isn't possible (no refresher registered, or it failed).
 * Mirrors the original 401 handling.
 */
function dropSessionWithToast(): void {
  useConnectionStore.getState().setToken(null, null);
  useConnectionStore.getState().setUser(null);
  void clearJwt();
  useNotificationStore
    .getState()
    .error('Session expired — please log in again.', { category: 'permanent' });
}

/**
 * Tear down the live session's per-document CRDT engine + WS provider and reset
 * the doc-level store state. Shared by `stopSession` and `leaveDocument` so the
 * two teardown paths can't drift.
 *
 * `preserveAuth` is the only difference: a full **sign-out** (`stopSession`,
 * e.g. the disconnect button) clears the relay identity via
 * `connectionStore.reset()`; an intentional **doc-leave** (`leaveDocument`)
 * keeps it (token/host/user) so the user stays signed in and reopening a relay
 * doc reconnects with the token rather than dropping to offline/re-login.
 *
 * Note: destroying the WS provider flips `connectionStore.status` to
 * `disconnected` regardless (the live WS is gone) — `preserveAuth` only governs
 * the durable identity (token), not the momentary connection status.
 */
function teardownSession(
  set: (partial: Partial<CollaborationState>) => void,
  opts: { preserveAuth: boolean },
): void {
  // Destroying the per-doc WS flips the connection to `disconnected`; this is an
  // intentional transition (leave / switch / sign-out), so mute the generic
  // connection-loss toast. A `startSession` right after (switch/reopen) extends
  // the window to also mute its "Reconnected" toast.
  muteConnectionToasts();

  // Stop the token-expiry monitor started in startSession.
  stopTokenExpirationMonitor();

  // Unsubscribe from awareness changes before destroying the provider.
  if (awarenessUnsubscribe) {
    awarenessUnsubscribe();
    awarenessUnsubscribe = null;
  }

  if (connectionUnsubscribe) {
    connectionUnsubscribe();
    connectionUnsubscribe = null;
  }
  relayClient = null;

  if (syncProvider) {
    syncProvider.destroy();
    syncProvider = null;
  }

  // Detach local persistence. `destroy()` closes the IndexedDB connection but
  // leaves the persisted data on disk (it's the durability store), so the next
  // session reloads it.
  if (idbPersistence) {
    void idbPersistence.destroy();
    idbPersistence = null;
  }

  if (yjsDoc) {
    yjsDoc.destroy();
    yjsDoc = null;
  }

  // Clear relay document store + presence.
  useRelayDocumentStore.getState().setProvider(null);
  useRelayDocumentStore.getState().clearRelayDocuments();
  usePresenceStore.getState().setLocalUser(null);
  usePresenceStore.getState().clearRemoteUsers();

  // Full sign-out resets the relay identity; an intentional doc-leave keeps it.
  if (!opts.preserveAuth) {
    useConnectionStore.getState().reset();
  }

  set({
    isActive: false,
    connectionStatus: 'disconnected',
    isSynced: false,
    isIdbSynced: false,
    error: null,
    remoteUsers: [],
    config: null,
  });
}

/**
 * Collaboration store for managing real-time sync.
 */
export const useCollaborationStore = create<CollaborationState & CollaborationActions>()(
  (set, get) => ({
    // Initial state
    isActive: false,
    connectionStatus: 'disconnected',
    isSynced: false,
    isIdbSynced: false,
    error: null,
    remoteUsers: [],
    config: null,
    sessionEpoch: 0,

    startSession: (config: CollaborationConfig) => {
      // Bringing a session up is an intentional transition (sign-in / doc-switch
      // / reopen) — mute the connect/reconnect toasts for its connect→auth round
      // trip. An unexpected drop's auto-reconnect goes through the provider, not
      // here, so genuine "Reconnected" toasts are unaffected.
      muteConnectionToasts();

      // Stop any existing session
      if (get().isActive) {
        get().stopSession();
      }

      // Set host info in connection store
      useConnectionStore.getState().setHost({
        address: new URL(config.serverUrl).host,
        url: config.serverUrl,
      });

      // Create Yjs document. The Y.Doc clientID is Yjs's random per-instance
      // default (JP-172) — NOT keyed off documentId; doc identity is the relay
      // room below, not the clientID.
      yjsDoc = new YjsDocument();

      // JP-108 step 3: attach local CRDT persistence BEFORE the provider connects.
      // Room is scoped per relay+doc (matching the cache/queue relay-tagging, JP-117)
      // so the same doc on a different relay can't bleed. y-indexeddb loads any
      // persisted state into the Y.Doc; `isIdbSynced` gates the view adopt so it
      // waits for the persisted offline edits to load. Browser-only (skips under
      // jsdom/tests). The relay preserves CRDT identity (JP-108 step 1) + JP-172
      // gave random clientIDs, so this no longer corrupts merges.
      get()._setIdbSynced(false);
      if (typeof indexedDB !== 'undefined') {
        const idbRoom = `${new URL(config.serverUrl).host}:${config.documentId}`;
        idbPersistence = new IndexeddbPersistence(idbRoom, yjsDoc.getDoc());
        idbPersistence.whenSynced
          .then(() => get()._setIdbSynced(true))
          .catch((e) => {
            console.warn('[collab][idb] load failed:', e);
            get()._setIdbSynced(true); // unblock adopt; fall back to relay state
          });
      } else {
        get()._setIdbSynced(true); // no IndexedDB → nothing to wait for
      }

      // The local engine is live now — Y.Doc + y-indexeddb + the view binding
      // (which activates on `isActive`) — independent of any connection. Edits
      // are CRDT ops from here, so anything typed offline/pre-sign-in is captured
      // and persisted, then merges on connect (JP-108 step 3). Set this BEFORE
      // attaching the provider so the engine doesn't depend on the network.
      // Bump `sessionEpoch` so the view effects re-bind to this fresh
      // YjsDocument — a switchDocument restart nets isActive true→true and would
      // otherwise leave onShapeChange registered on the old, destroyed instance.
      set({ isActive: true, config, error: null, sessionEpoch: get().sessionEpoch + 1 });

      // Only attach the WS provider when we have a token. A token-less provider
      // would no-auth-join → get rejected → fire the "this document isn't syncing
      // — saved locally only" toast while the user edits offline pre-sign-in.
      // The provider attaches on sign-in (a later `startSession` with a token)
      // onto this same live Y.Doc.
      if (!config.token) return;

      // Create unified sync provider
      syncProvider = new UnifiedSyncProvider(yjsDoc.getDoc(), {
        url: config.serverUrl,
        documentId: config.documentId,
        token: config.token,
        onStatusChange: (status, error) => {
          get()._setConnectionStatus(status);
          if (error) {
            get()._setError(error);
          }

          // Update relay document store connection status
          const isConnected = status === 'connected' || status === 'authenticated';
          useRelayDocumentStore.getState().setHostConnected(isConnected);
          if (error) {
            useRelayDocumentStore.getState().setError(`Connection: ${error}`);
          } else if (isConnected) {
            useRelayDocumentStore.getState().setError(null);
          }
        },
        onSynced: () => {
          get()._setSynced(true);
        },
        onAuthenticated: (success, user) => {
          useRelayDocumentStore.getState().setAuthenticated(success);

          // Adopt the server-confirmed identity (the token `sub`) for the
          // local awareness/presence user once authenticated.
          if (success && user) {
            config.user.id = user.id;
            if (user.username) {
              config.user.name = user.username;
            }
          }

          // If a team doc was selected at startup but couldn't be loaded
          // (server wasn't up yet), reattach now that we're authenticated.
          // Then explicitly drain the offline sync queue and push any
          // unsynced in-session edits, so a save fires on connect — not only
          // on the next edit (JP-106 follow-up).
          //
          // NOTE: SyncStateManager's own autoProcessOnReconnect hook fires on
          // the connectionStore status flip to 'authenticated', which happens
          // *before* setAuthenticated() above — so at that instant the
          // provider's isReady() is still false and the auto-process bails.
          // We re-trigger here, after setAuthenticated, where isReady() holds.
          if (success) {
            // Replay only this relay's queued entries — not another relay's
            // (JP-117). `config.serverUrl` is the relay we just authenticated to.
            const replayRelayId = useConnectionStore.getState().host?.address;
            void reattachAwaitingTeamDocument()
              .then(() =>
                replayRelayId
                  ? getSyncStateManager().processQueueForHost(replayRelayId)
                  : undefined,
              )
              .then(() => syncCurrentDocToRelayOnConnect())
              .catch((e) => console.warn('[collab] on-connect relay sync failed:', e));
          }
        },
        onDocumentEvent: (event: DocEvent) => {
          useRelayDocumentStore.getState().handleDocumentEvent(event);
        },
        onError: (error: string, docId: string | null) => {
          // A rejected JOIN_DOC means the relay has no record of this doc in
          // our workspace (never promoted, deleted, or a diverged local-only
          // id). Mark it as not-syncing and tell the user their edits are
          // local-only, rather than letting them edit into the void.
          if (isUnknownDocError(error) && docId) {
            useDocumentRegistry.getState().setSyncState(docId, 'error');
            useNotificationStore
              .getState()
              .warning(
                'This document isn’t syncing — the relay has no record of it. ' +
                  'Your changes are saved locally only.',
              );
          }
        },
        shouldJoinDocument: (docId: string) => {
          // Don't fire a JOIN_DOC for a local-only document; the relay will
          // reject it. Relay docs ('remote') and offline-cached relay docs
          // ('cached') are valid join targets. Unknown ids (e.g. a doc not
          // yet registered at startup) default to allowed.
          const record = useDocumentRegistry.getState().getRecord(docId);
          return !record || record.type !== 'local';
        },
      });

      // Set up awareness change handler
      awarenessUnsubscribe = syncProvider.onAwarenessChange((users) => {
        get()._updateRemoteUsers(users);
      });

      // Set local user awareness
      syncProvider.setLocalAwareness({
        id: config.user.id,
        name: config.user.name,
        color: config.user.color,
      });

      // Set local user in presence store
      usePresenceStore.getState().setLocalUser({
        userId: config.user.id,
        name: config.user.name,
        color: config.user.color,
      });

      // Build the REST client + adapter so the relay document store
       // routes CRUD through HTTP rather than the WS multiplexer. The
       // WS provider still owns CRDT sync, awareness, and auth — see
       // Slice E.2 plan for the split.
      const restBaseUrl = wsUrlToHttpOrigin(config.serverUrl);
      relayClient = new RelayClient({
        baseUrl: restBaseUrl,
        ...(config.token !== undefined ? { token: config.token } : {}),
        // JP-127: on desktop this routes through the reqwest-backed Tauri HTTP
        // plugin (the webview's libsoup fetch throttles large uploads to
        // 15–80 KB/s); on web it's the native fetch. Resolved lazily on first
        // request, so construction stays synchronous.
        fetchImpl: relayFetch,
        onUnauthorized: () => {
          // JP-100: try a silent token refresh first (no-op until a
          // TokenRefresher is registered — see tokenRefresh.ts). On success the
          // fresh token is already committed and the next request carries it;
          // otherwise fall back to dropping the session and prompting re-auth.
          void attemptTokenRefresh().then((refreshed) => {
            if (!refreshed) dropSessionWithToast();
          });
        },
      });
      // Mirror JWT updates from the connection store (set by the WS
      // auth path) into the REST client + on-disk cache so the next
      // REST call carries the freshest bearer and a browser refresh
      // can pre-fill the login form.
      connectionUnsubscribe = useConnectionStore.subscribe((state) => {
        relayClient?.setToken(state.token ?? undefined);
        // Zustand subscribers can't be async; persistence is best-effort and
        // the in-memory store is the source of truth (last-write-wins).
        void saveConnection(restBaseUrl, state.token);
      });
      // Seed the REST client from the SESSION's own token (the same one the WS
      // provider uses), NOT `connectionStore.token`. The internal `stopSession`
      // at the top of `startSession` resets the connection store, so on an
      // engine-only→authenticated transition (Stage 2: an engine-only session is
      // live before sign-in) `connectionStore.token` is transiently null here —
      // seeding from it would leave the REST client unauthenticated (401 on
      // /api/docs) even though the WS authenticated fine. `config.token` is
      // always set in this block (the token-less path returned early above).
      relayClient.setToken(config.token ?? undefined);
      void saveConnection(restBaseUrl, config.token ?? null);

      useRelayDocumentStore
        .getState()
        .setProvider(new RestDocumentProvider(relayClient));

      // Connect
      syncProvider.connect();

      // JP-100: proactively refresh (or warn) as the token nears expiry, only
      // while a session is active. `attemptTokenRefresh` is a no-op until a
      // refresher is registered; the expiry warning toast is wired regardless.
      startTokenExpirationMonitor({
        onTokenExpiring: () => {
          void attemptTokenRefresh();
        },
        onTokenExpired: () => {
          void attemptTokenRefresh().then((refreshed) => {
            if (!refreshed) dropSessionWithToast();
          });
        },
      });
    },

    stopSession: () => {
      // Full sign-out: tear down the doc engine AND drop the relay identity.
      teardownSession(set, { preserveAuth: false });
    },

    leaveDocument: () => {
      // Leave the doc but stay signed in: same teardown, but keep the relay
      // token/host/user so reopening a relay doc reconnects authenticated.
      teardownSession(set, { preserveAuth: true });
    },

    syncShape: (shape: Shape) => {
      if (yjsDoc) {
        yjsDoc.setShape(shape);
      }
    },

    syncShapes: (shapes: Shape[]) => {
      if (yjsDoc) {
        yjsDoc.setShapes(shapes);
      }
    },

    syncDeleteShape: (shapeId: string) => {
      if (yjsDoc) {
        yjsDoc.deleteShape(shapeId);
      }
    },

    syncShapeOrder: (order: string[]) => {
      if (yjsDoc) {
        yjsDoc.setShapeOrder(order);
      }
    },

    syncDocumentName: (name: string) => {
      if (yjsDoc) {
        // Stored under `title` in the metadata map (the relay seeds it from the
        // doc `name` on hydrate and flattens it back). `updatedAt` lets the
        // relay order this against a possibly-concurrent REST rename.
        yjsDoc.setMetadata({ title: name, updatedAt: Date.now() });
      }
    },

    switchDocument: (docId: string) => {
      // Per-doc engine RESTART (JP-108 step 3, Stage 2). The old implementation
      // cleared the CRDT in place (`yjsDoc.clear()`) and re-joined on the same
      // Y.Doc. That is unsafe now that `y-indexeddb` is attached (Stage 1):
      // `clear()` persists the EMPTY state into the *current* doc's room, wiping
      // its offline edits, and a single Y.Doc can't be keyed to two rooms. So we
      // tear the session down and start a fresh one for the new doc — new Y.Doc,
      // new `host:docId` room, correct persistence — carrying the live token so
      // an online collaborator stays connected across the switch.
      //
      // Always restarts, even when `docId` equals the current doc: that's how a
      // just-promoted local→relay doc (DocumentBrowser) forces a real JOIN_DOC
      // now that the relay has a record of it.
      const config = get().config;
      if (!config) return;

      // Freshest token: the auth path / refresh updates connectionStore; fall
      // back to the config's original. `undefined` → engine-only restart.
      const conn = useConnectionStore.getState();
      const token = conn.token ?? config.token;
      const tokenExpiresAt = conn.tokenExpiresAt;

      get().stopSession();

      // `stopSession` resets the connection store (token → null). Re-assert the
      // identity BEFORE the new `startSession` so its REST-client seed + token
      // monitor pick it up — otherwise an authenticated collaborator would drop
      // to unauthenticated across a doc switch.
      if (token) {
        useConnectionStore.getState().setToken(token, tokenExpiresAt);
      }

      get().startSession({
        serverUrl: config.serverUrl,
        documentId: docId,
        ...(token ? { token } : {}),
        // Reset to a placeholder; `onAuthenticated` re-adopts the token `sub`.
        user: { id: 'pending', name: 'You', color: '#4a90d9' },
      });
    },

    updateCursor: (x: number, y: number) => {
      broadcastCursor(x, y);
    },

    updateSelection: (shapeIds: string[]) => {
      broadcastSelection(shapeIds);
    },

    _setConnectionStatus: (status: ConnectionStatus) => {
      set({ connectionStatus: status });
    },

    _setSynced: (synced: boolean) => {
      set({ isSynced: synced });
    },

    _setIdbSynced: (synced: boolean) => {
      set({ isIdbSynced: synced });
    },

    _setError: (error: string | null) => {
      set({ error });
    },

    _updateRemoteUsers: (users: Map<number, AwarenessUserState>) => {
      const remoteUsers: RemoteUser[] = [];
      users.forEach((user, clientId) => {
        remoteUsers.push({ ...user, clientId });
      });
      set({ remoteUsers });

      // Sync to presenceStore for optimized presence rendering
      usePresenceStore.getState().syncRemoteUsers(users);
    },

    getYjsDocument: () => yjsDoc,
    getSyncProvider: () => syncProvider,
  })
);

/**
 * Subscribe to remote shape changes.
 * Returns unsubscribe function.
 *
 * This should be called from the document store to integrate CRDT changes.
 */
export function subscribeToRemoteChanges(
  onShapeChange: (added: Shape[], updated: Shape[], removed: string[]) => void,
  onOrderChange: (order: string[]) => void
): () => void {
  const store = useCollaborationStore.getState();
  const yjsDoc = store.getYjsDocument();

  if (!yjsDoc) {
    return () => {};
  }

  const unsubShape = yjsDoc.onShapeChange(onShapeChange);
  const unsubOrder = yjsDoc.onOrderChange(onOrderChange);

  return () => {
    unsubShape();
    unsubOrder();
  };
}

/**
 * Initialize CRDT with existing document state.
 * Call this when starting collaboration on an existing document.
 */
export function initializeCRDTFromState(
  shapes: Shape[],
  order: string[]
): void {
  const store = useCollaborationStore.getState();
  const yjsDoc = store.getYjsDocument();

  if (yjsDoc) {
    yjsDoc.initializeFromState(shapes, order);
  }
}

/**
 * Whether `docId` is the document of an active collaboration session — i.e. its
 * content is owned by the relay-mediated CRDT (and the relay's own persistence,
 * JP-36 + JP-108), so the client must NOT also REST-save/queue it. Doing so
 * would replay an LWW snapshot that clobbers the merge, and would bump
 * `serverVersion` (invalidating the relay's binary Y.Doc sidecar → prose +
 * identity loss). See JP-108 "relay sole writer".
 *
 * Deliberately does NOT require `isSynced`: an offline (unsynced) edit must also
 * stay off the REST queue, or the clobber returns on reconnect. The one
 * exception is an **errored** doc — the relay has no record of it (rejected
 * JOIN_DOC), so the CRDT can't own it; REST stays its durability fallback (the
 * "saved locally only" safety net).
 */
export function isCollabContentDoc(docId: string): boolean {
  const collab = useCollaborationStore.getState();
  if (!collab.isActive || collab.config?.documentId !== docId) return false;

  // An errored doc (relay rejected JOIN_DOC / has no record) can't be CRDT-owned
  // — keep it on the REST path. `syncState` lives on RemoteDocument only.
  const record = useDocumentRegistry.getState().getRecord(docId);
  if (record && isRemoteDocument(record) && record.syncState === 'error') {
    return false;
  }
  return true;
}

// Re-export types for backwards compatibility
export type { ConnectionStatus } from '../store/connectionStore';
export type { AwarenessUserState } from './UnifiedSyncProvider';

export default useCollaborationStore;
