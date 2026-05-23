/**
 * Unified Sync Provider
 *
 * Single WebSocket provider that handles all collaboration functionality:
 * - CRDT sync via Yjs (shapes, order, metadata)
 * - Awareness/presence (cursors, selections)
 * - Document operations (list, get, save, delete)
 * - Authentication (token or credentials)
 *
 * Replaces separate SyncProvider and DocumentSyncProvider with unified architecture.
 *
 * Phase 14.1 Collaboration Overhaul
 */

import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

import {
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_PARAM,
  MESSAGE_SYNC,
  MESSAGE_AWARENESS,
  MESSAGE_AUTH,
  MESSAGE_AUTH_RESPONSE,
  MESSAGE_DOC_EVENT,
  MESSAGE_JOIN_DOC,
  encodeMessage,
  decodePayload,
  type AuthResponse,
  type DocEvent,
  type JoinDocRequest,
} from './protocol';

/** Convert ws://host/ws → http://host (mirror of collaborationStore helper). */
function wsUrlToHttpOrigin(wsUrl: string): string {
  return wsUrl
    .replace(/^ws:\/\//, 'http://')
    .replace(/^wss:\/\//, 'https://')
    .replace(/\/ws\/?$/, '');
}
import { useConnectionStore, type ConnectionStatus, type AuthenticatedUser } from '../store/connectionStore';

// ============ Types ============

/** Awareness user state */
export interface AwarenessUserState {
  id: string;
  name: string;
  color: string;
  cursor?: { x: number; y: number };
  selection?: string[];
}

/** Unified provider options */
export interface UnifiedSyncProviderOptions {
  /** WebSocket URL (e.g., ws://localhost:9876/ws) */
  url: string;
  /** Document ID for CRDT room */
  documentId: string;
  /** JWT token for authentication (use this OR credentials) */
  token?: string | undefined;
  /** Login credentials (alternative to token) */
  credentials?: {
    username: string;
    password: string;
  } | undefined;
  /** Auto-reconnect on disconnect (default: true) */
  autoReconnect?: boolean | undefined;
  /** Reconnect delay in ms (default: 1000) */
  reconnectDelay?: number | undefined;
  /** Max reconnect attempts (default: 10) */
  maxReconnectAttempts?: number | undefined;
  /** Whether to add jitter to reconnect delays (default: true, disable for testing) */
  reconnectJitter?: boolean | undefined;
  // Callbacks
  /** Called when connection status changes */
  onStatusChange?: ((status: ConnectionStatus, error?: string) => void) | undefined;
  /** Called when CRDT is synced */
  onSynced?: (() => void) | undefined;
  /** Called when authentication completes */
  onAuthenticated?: ((success: boolean, user?: AuthenticatedUser) => void) | undefined;
  /** Called when document event received */
  onDocumentEvent?: ((event: DocEvent) => void) | undefined;
}

/** Resolved options with defaults applied (no undefined values) */
interface ResolvedSyncProviderOptions {
  url: string;
  documentId: string;
  token: string;
  credentials: { username: string; password: string } | null;
  autoReconnect: boolean;
  reconnectDelay: number;
  maxReconnectAttempts: number;
  reconnectJitter: boolean;
  onStatusChange: (status: ConnectionStatus, error?: string) => void;
  onSynced: () => void;
  onAuthenticated: (success: boolean, user?: AuthenticatedUser) => void;
  onDocumentEvent: (event: DocEvent) => void;
}

// ============ UnifiedSyncProvider ============

/**
 * UnifiedSyncProvider manages all WebSocket-based collaboration.
 *
 * Single connection handles:
 * - Yjs CRDT sync (MESSAGE_SYNC)
 * - Awareness/presence (MESSAGE_AWARENESS)
 * - Authentication (MESSAGE_AUTH, MESSAGE_AUTH_LOGIN, MESSAGE_AUTH_RESPONSE)
 * - Document operations (MESSAGE_DOC_*)
 */
export class UnifiedSyncProvider {
  private doc: Y.Doc;
  private options: ResolvedSyncProviderOptions;
  private ws: WebSocket | null = null;
  private awareness: awarenessProtocol.Awareness;

  private status: ConnectionStatus = 'disconnected';
  private synced = false;
  private authenticated = false;
  private reconnectAttempts = 0;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

  /** Current document ID for CRDT routing */
  private currentDocId: string | null = null;

  constructor(doc: Y.Doc, options: UnifiedSyncProviderOptions) {
    this.doc = doc;
    this.options = {
      url: options.url,
      documentId: options.documentId,
      token: options.token ?? '',
      credentials: options.credentials ?? null,
      autoReconnect: options.autoReconnect ?? true,
      reconnectDelay: options.reconnectDelay ?? 1000,
      maxReconnectAttempts: options.maxReconnectAttempts ?? 10,
      reconnectJitter: options.reconnectJitter ?? true,
      onStatusChange: options.onStatusChange ?? (() => {}),
      onSynced: options.onSynced ?? (() => {}),
      onAuthenticated: options.onAuthenticated ?? (() => {}),
      onDocumentEvent: options.onDocumentEvent ?? (() => {}),
    };

    // Create awareness instance
    this.awareness = new awarenessProtocol.Awareness(doc);

    // Set up document update handler
    this.doc.on('update', this.handleDocumentUpdate);

    // Set up awareness update handler
    this.awareness.on('update', this.handleAwarenessUpdate);
  }

  // ============ Connection ============

  /** Get current connection status */
  getStatus(): ConnectionStatus {
    return this.status;
  }

  /** Check if CRDT is synced */
  isSynced(): boolean {
    return this.synced;
  }

  /** Check if authenticated */
  isAuthenticated(): boolean {
    return this.authenticated;
  }

  /** Check if ready (connected and authenticated) */
  isReady(): boolean {
    return this.status === 'authenticated' && this.authenticated;
  }

  /** Connect to the WebSocket server */
  connect(): void {
    if (this.ws) {
      return;
    }

    this.setStatus('connecting');

    try {
      // Build URL with document ID and protocol version negotiation
      const url = new URL(this.options.url);
      url.searchParams.set('doc', this.options.documentId);
      url.searchParams.set(PROTOCOL_VERSION_PARAM, String(PROTOCOL_VERSION));

      this.ws = new WebSocket(url.toString());
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = this.handleOpen;
      this.ws.onmessage = this.handleMessage;
      this.ws.onclose = this.handleClose;
      this.ws.onerror = this.handleError;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Connection failed';
      console.error('[UnifiedSyncProvider] Connection error:', errorMsg);
      this.setStatus('error', errorMsg);
      this.scheduleReconnect();
    }
  }

  /** Disconnect from the WebSocket server */
  disconnect(): void {
    this.clearReconnectTimeout();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.synced = false;
    this.authenticated = false;
    this.setStatus('disconnected');
  }

  /** Destroy the provider and clean up */
  destroy(): void {
    this.disconnect();

    this.doc.off('update', this.handleDocumentUpdate);
    this.awareness.off('update', this.handleAwarenessUpdate);
    this.awareness.destroy();
  }

  // ============ Awareness/Presence ============

  /** Get the awareness instance */
  getAwareness(): awarenessProtocol.Awareness {
    return this.awareness;
  }

  /** Set local user awareness state */
  setLocalAwareness(state: Partial<AwarenessUserState>): void {
    this.awareness.setLocalStateField('user', state);
  }

  /** Update cursor position */
  updateCursor(x: number, y: number): void {
    const currentState = this.awareness.getLocalState();
    const user = (currentState?.['user'] as AwarenessUserState) ?? {};
    this.awareness.setLocalStateField('user', { ...user, cursor: { x, y } });
  }

  /** Update selection */
  updateSelection(shapeIds: string[]): void {
    const currentState = this.awareness.getLocalState();
    const user = (currentState?.['user'] as AwarenessUserState) ?? {};
    this.awareness.setLocalStateField('user', { ...user, selection: shapeIds });
  }

  /** Get all remote users' awareness states */
  getRemoteUsers(): Map<number, AwarenessUserState> {
    const result = new Map<number, AwarenessUserState>();
    const states = this.awareness.getStates();

    states.forEach((state, clientId) => {
      if (clientId === this.doc.clientID) return;
      const userState = state['user'];
      if (userState) {
        result.set(clientId, userState as AwarenessUserState);
      }
    });

    return result;
  }

  /** Subscribe to awareness changes */
  onAwarenessChange(callback: (users: Map<number, AwarenessUserState>) => void): () => void {
    const handler = () => callback(this.getRemoteUsers());
    this.awareness.on('change', handler);
    return () => this.awareness.off('change', handler);
  }

  // ============ Document Operations ============
  //
  // As of 20.3 Slice E.2 (Commit 3), document CRUD (list/get/save/
  // delete/share/transfer) is no longer multiplexed over this WS.
  // Those operations live on `RelayClient` (REST) and are wired into
  // the store via `RestDocumentProvider`. The WS keeps SYNC,
  // AWARENESS, AUTH, JOIN_DOC, and DOC_EVENT broadcasts.

  /** Join a document for CRDT routing */
  joinDocument(docId: string): void {
    this.currentDocId = docId;

    if (this.ws?.readyState === WebSocket.OPEN) {
      const request: JoinDocRequest = { docId };
      const data = encodeMessage(MESSAGE_JOIN_DOC, request);
      this.ws.send(data);
    }
  }

  /** Request initial sync after joining a document */
  requestSync(): void {
    this.synced = false;
    this.sendSyncStep1();
  }

  /** Leave current document */
  leaveDocument(): void {
    this.currentDocId = null;
  }

  // ============ Authentication ============

  /**
   * Login with username and password.
   * Returns token on success for future connections.
   */
  async loginWithCredentials(
    username: string,
    password: string
  ): Promise<{
    success: boolean;
    token?: string;
    tokenExpiresAt?: number;
    user?: AuthenticatedUser;
    error?: string;
  }> {
    // Slice E.2 Commit 3: login is now a REST call. Once we have the
    // JWT we send MESSAGE_AUTH over the existing WS so the relay
    // validates it for the SYNC/AWARENESS/DOC_EVENT channel. The old
    // MESSAGE_AUTH_LOGIN multiplexing is dead and gets removed in E.3.
    const { RelayClient } = await import('../api/relayClient');
    const client = new RelayClient({ baseUrl: wsUrlToHttpOrigin(this.options.url) });

    try {
      const result = await client.login({ username, password });
      const user: AuthenticatedUser = {
        id: result.user.id,
        username: result.user.username,
        role: result.user.role,
      };

      useConnectionStore.getState().setUser(user);
      useConnectionStore.getState().setToken(result.token, result.expiresAt);
      this.options.token = result.token;

      // Validate the freshly issued JWT against the WS auth channel so
      // SYNC/AWARENESS/DOC_EVENT messages start flowing.
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.sendAuth(result.token);
      }

      const out: {
        success: boolean;
        token?: string;
        tokenExpiresAt?: number;
        user?: AuthenticatedUser;
        error?: string;
      } = { success: true, token: result.token, user };
      if (result.expiresAt) out.tokenExpiresAt = result.expiresAt;
      return out;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Authentication failed';
      this.setStatus('error', message);
      this.options.onAuthenticated?.(false);
      return { success: false, error: message };
    }
  }

  // ============ Private: Connection Handlers ============

  private setStatus(status: ConnectionStatus, error?: string): void {
    this.status = status;

    // Update connection store
    useConnectionStore.getState().setStatus(status, error);

    this.options.onStatusChange?.(status, error);
  }

  private handleOpen = (): void => {
    this.setStatus('connected');
    this.reconnectAttempts = 0;
    useConnectionStore.getState().resetReconnectAttempts();

    // Authenticate if we have token
    if (this.options.token) {
      this.setStatus('authenticating');
      useConnectionStore.getState().setAuthMethod('token');
      this.sendAuth(this.options.token);
    } else if (this.options.credentials) {
      this.setStatus('authenticating');
      useConnectionStore.getState().setAuthMethod('credentials');
      this.loginWithCredentials(
        this.options.credentials.username,
        this.options.credentials.password
      ).catch((err) => {
        console.error('[UnifiedSyncProvider] Credentials login failed:', err);
      });
    } else {
      useConnectionStore.getState().setAuthMethod('none');
    }

    // Join document FIRST - this sets current_doc_id on server for routing
    // Must happen before sending any CRDT messages
    const docToJoin = this.currentDocId ?? this.options.documentId;
    if (docToJoin) {
      this.joinDocument(docToJoin);
    }

    // Send initial CRDT sync step 1 (now routed to correct document)
    this.sendSyncStep1();

    // Send initial awareness
    this.sendAwarenessUpdate();
  };

  private handleMessage = (event: MessageEvent): void => {
    const data = event.data as ArrayBuffer;
    const arr = new Uint8Array(data);

    if (arr.length === 0) return;

    const msgType = arr[0]!;

    switch (msgType) {
      case MESSAGE_SYNC:
        this.handleSyncMessage(arr);
        break;
      case MESSAGE_AWARENESS:
        this.handleAwarenessMessage(arr);
        break;
      case MESSAGE_AUTH_RESPONSE:
        this.handleAuthResponse(data);
        break;
      case MESSAGE_DOC_EVENT:
        this.handleDocEvent(data);
        break;
      default:
        // Unknown message type, ignore
        break;
    }
  };

  private handleClose = (_event: CloseEvent): void => {
    this.ws = null;
    this.synced = false;
    this.authenticated = false;

    if (this.status !== 'disconnected') {
      this.setStatus('disconnected');
      this.scheduleReconnect();
    }
  };

  private handleError = (): void => {
    console.error('[UnifiedSyncProvider] WebSocket error');
    this.setStatus('error', 'WebSocket error');
  };

  // ============ Private: CRDT Sync ============

  private handleDocumentUpdate = (update: Uint8Array, origin: unknown): void => {
    // Don't send updates that originated from the server
    if (origin === this) return;

    if (this.ws?.readyState === WebSocket.OPEN) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.ws.send(encoding.toUint8Array(encoder));
    }
  };

  private handleAwarenessUpdate = ({ added, updated, removed }: {
    added: number[];
    updated: number[];
    removed: number[];
  }): void => {
    const changedClients = added.concat(updated).concat(removed);

    if (changedClients.includes(this.doc.clientID)) {
      this.sendAwarenessUpdate();
    }
  };

  private handleSyncMessage(data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    decoding.readVarUint(decoder); // Skip message type

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);

    const syncMessageType = syncProtocol.readSyncMessage(
      decoder,
      encoder,
      this.doc,
      this
    );

    // Send response if needed
    if (encoding.length(encoder) > 1) {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(encoding.toUint8Array(encoder));
      }
    }

    // Mark as synced after sync step 2
    if (syncMessageType === syncProtocol.messageYjsSyncStep2 && !this.synced) {
      this.synced = true;
      this.options.onSynced?.();
    }
  }

  private handleAwarenessMessage(data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    decoding.readVarUint(decoder); // Skip message type

    awarenessProtocol.applyAwarenessUpdate(
      this.awareness,
      decoding.readVarUint8Array(decoder),
      this
    );
  }

  private sendSyncStep1(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    this.ws.send(encoding.toUint8Array(encoder));
  }

  private sendAwarenessUpdate(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID])
    );
    this.ws.send(encoding.toUint8Array(encoder));
  }

  // ============ Private: Authentication ============

  private sendAuth(token: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;

    const data = encodeMessage(MESSAGE_AUTH, token);
    this.ws.send(data);
  }

  private handleAuthResponse(data: ArrayBuffer): void {
    try {
      const response = decodePayload<AuthResponse>(data);

      if (response.success) {
        this.authenticated = true;
        this.setStatus('authenticated');

        const user: AuthenticatedUser | undefined = response.userId
          ? { id: response.userId, username: response.username ?? '', role: response.role ?? undefined }
          : undefined;

        useConnectionStore.getState().setUser(user ?? null);

        this.options.onAuthenticated?.(true, user);
      } else {
        this.setStatus('error', response.error ?? 'Authentication failed');
        this.options.onAuthenticated?.(false);
      }
    } catch (e) {
      console.error('[UnifiedSyncProvider] Failed to parse auth response:', e);
    }
  }

  // ============ Private: Document Events ============

  private handleDocEvent(data: ArrayBuffer): void {
    try {
      const event = decodePayload<DocEvent>(data);
      this.options.onDocumentEvent?.(event);
    } catch (e) {
      console.error('[UnifiedSyncProvider] Failed to parse doc event:', e);
    }
  }

  // ============ Private: Reconnection ============

  /** Maximum reconnect delay in ms (30 seconds) */
  private static readonly MAX_RECONNECT_DELAY = 30000;

  private scheduleReconnect(): void {
    if (!this.options.autoReconnect) return;
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      this.setStatus('error', 'Max reconnect attempts reached');
      return;
    }

    this.clearReconnectTimeout();

    // Exponential backoff with cap
    const baseDelay = this.options.reconnectDelay * Math.pow(2, this.reconnectAttempts);
    const cappedDelay = Math.min(baseDelay, UnifiedSyncProvider.MAX_RECONNECT_DELAY);

    // Add jitter (±20%) to prevent thundering herd (can be disabled for testing)
    let delay: number;
    if (this.options.reconnectJitter) {
      const jitter = cappedDelay * (0.8 + Math.random() * 0.4);
      delay = Math.round(jitter);
    } else {
      delay = cappedDelay;
    }

    this.reconnectAttempts++;
    useConnectionStore.getState().incrementReconnectAttempts();

    console.log(`[UnifiedSyncProvider] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private clearReconnectTimeout(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }
}

export default UnifiedSyncProvider;
