import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as Y from 'yjs';
import { UnifiedSyncProvider, type UnifiedSyncProviderOptions } from './UnifiedSyncProvider';
import {
  MESSAGE_AUTH,
  MESSAGE_AUTH_RESPONSE,
  MESSAGE_DOC_EVENT,
  MESSAGE_JOIN_DOC,
  MESSAGE_ERROR,
  MESSAGE_SYNC,
  MESSAGE_SYNC_CHUNK,
  encodeMessage,
  decodeMessageType,
  decodePayload,
  type AuthResponse,
  type DocEvent,
  type ErrorResponse,
  type JoinDocRequest,
} from './protocol';

// Mock WebSocket class
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState: number = MockWebSocket.CONNECTING;
  binaryType: string = 'blob';

  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  private messageListeners: Array<(event: MessageEvent) => void> = [];
  sentMessages: Uint8Array[] = [];

  constructor(url: string) {
    this.url = url;
  }

  // Simulate connection opening
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  // Simulate receiving a message
  simulateMessage(data: Uint8Array | ArrayBuffer): void {
    const event = new MessageEvent('message', { data });
    this.onmessage?.(event);
    this.messageListeners.forEach((listener) => listener(event));
  }

  // Simulate connection closing
  simulateClose(code = 1000, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code, reason }));
  }

  // Simulate error
  simulateError(): void {
    this.onerror?.(new Event('error'));
  }

  send(data: Uint8Array): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
    this.sentMessages.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSING;
    setTimeout(() => this.simulateClose(), 0);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    if (type === 'message') {
      this.messageListeners.push(listener);
    }
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
    if (type === 'message') {
      this.messageListeners = this.messageListeners.filter((l) => l !== listener);
    }
  }

  // Helper to get last sent message
  getLastSentMessage(): { type: number; payload: unknown } | null {
    const lastMsg = this.sentMessages[this.sentMessages.length - 1];
    if (!lastMsg) return null;

    const type = decodeMessageType(lastMsg);
    if (type === null) return null;

    try {
      const payload = decodePayload(lastMsg);
      return { type, payload };
    } catch {
      return { type, payload: null };
    }
  }

  // Helper to find sent message by type
  findSentMessage(msgType: number): { type: number; payload: unknown } | null {
    for (const msg of this.sentMessages) {
      const type = decodeMessageType(msg);
      if (type === msgType) {
        try {
          const payload = decodePayload(msg);
          return { type, payload };
        } catch {
          return { type, payload: null };
        }
      }
    }
    return null;
  }

  // Clear sent messages for clean test state
  clearSentMessages(): void {
    this.sentMessages = [];
  }
}

// Setup global WebSocket mock
let mockWebSocket: MockWebSocket | null = null;

// Store original WebSocket
const originalWebSocket = globalThis.WebSocket;

function setupWebSocketMock(): void {
  (globalThis as unknown as { WebSocket: new (url: string) => MockWebSocket }).WebSocket = class extends MockWebSocket {
    constructor(url: string) {
      super(url);
      mockWebSocket = this;
    }
  };
}

function restoreWebSocket(): void {
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = originalWebSocket;
  mockWebSocket = null;
}

describe('UnifiedSyncProvider', () => {
  let doc: Y.Doc;
  let provider: UnifiedSyncProvider;
  let onStatusChange: ReturnType<typeof vi.fn>;
  let onSynced: ReturnType<typeof vi.fn>;
  let onAuthenticated: ReturnType<typeof vi.fn>;
  let onDocumentEvent: ReturnType<typeof vi.fn>;

  function createProvider(overrides: Partial<UnifiedSyncProviderOptions> = {}): UnifiedSyncProvider {
    const options: UnifiedSyncProviderOptions = {
      url: 'ws://localhost:9876',
      documentId: 'test-doc',
      autoReconnect: false, // Disable for tests
      reconnectJitter: false, // Disable jitter for deterministic tests
      onStatusChange,
      onSynced,
      onAuthenticated,
      onDocumentEvent,
      ...overrides,
    };
    return new UnifiedSyncProvider(doc, options);
  }

  beforeEach(() => {
    setupWebSocketMock();
    vi.useFakeTimers();

    doc = new Y.Doc();
    onStatusChange = vi.fn();
    onSynced = vi.fn();
    onAuthenticated = vi.fn();
    onDocumentEvent = vi.fn();
  });

  afterEach(() => {
    provider?.destroy();
    restoreWebSocket();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('Connection Lifecycle', () => {
    it('starts in disconnected state', () => {
      provider = createProvider();
      expect(provider.getStatus()).toBe('disconnected');
      expect(provider.isSynced()).toBe(false);
      expect(provider.isAuthenticated()).toBe(false);
    });

    it('transitions to connecting state on connect', () => {
      provider = createProvider();
      provider.connect();

      expect(provider.getStatus()).toBe('connecting');
      expect(onStatusChange).toHaveBeenCalledWith('connecting', undefined);
    });

    it('transitions to connected state on WebSocket open', () => {
      provider = createProvider();
      provider.connect();
      mockWebSocket?.simulateOpen();

      expect(provider.getStatus()).toBe('connected');
      expect(onStatusChange).toHaveBeenCalledWith('connected', undefined);
    });

    it('includes document ID in WebSocket URL', () => {
      provider = createProvider({ documentId: 'my-custom-doc' });
      provider.connect();

      expect(mockWebSocket?.url).toContain('doc=my-custom-doc');
    });

    it('sends JOIN_DOC message on open', () => {
      provider = createProvider({ documentId: 'join-test-doc' });
      provider.connect();
      mockWebSocket?.simulateOpen();

      const joinMsg = mockWebSocket?.findSentMessage(MESSAGE_JOIN_DOC);
      expect(joinMsg).not.toBeNull();
      expect((joinMsg?.payload as JoinDocRequest).docId).toBe('join-test-doc');
    });

    it('does not send JOIN_DOC when shouldJoinDocument returns false (JP-106)', () => {
      // A local-only doc the relay has no record of — joining would be a
      // doomed round-trip that gets silently rejected.
      provider = createProvider({
        documentId: 'local-only-doc',
        shouldJoinDocument: () => false,
      });
      provider.connect();
      mockWebSocket?.simulateOpen();

      expect(mockWebSocket?.findSentMessage(MESSAGE_JOIN_DOC)).toBeNull();
    });

    it('disconnects cleanly', () => {
      provider = createProvider();
      provider.connect();
      mockWebSocket?.simulateOpen();
      provider.disconnect();

      expect(provider.getStatus()).toBe('disconnected');
      expect(provider.isSynced()).toBe(false);
      expect(provider.isAuthenticated()).toBe(false);
    });

    it('transitions to disconnected on WebSocket close', () => {
      provider = createProvider();
      provider.connect();
      mockWebSocket?.simulateOpen();
      mockWebSocket?.simulateClose();

      expect(provider.getStatus()).toBe('disconnected');
    });

    it('transitions to error on WebSocket error', () => {
      provider = createProvider();
      provider.connect();
      mockWebSocket?.simulateOpen();
      mockWebSocket?.simulateError();

      expect(provider.getStatus()).toBe('error');
    });
  });

  describe('Token Authentication', () => {
    it('sends AUTH message with token on open', () => {
      provider = createProvider({ token: 'test-jwt-token' });
      provider.connect();
      mockWebSocket?.simulateOpen();

      const authMsg = mockWebSocket?.findSentMessage(MESSAGE_AUTH);
      expect(authMsg).not.toBeNull();
      expect(authMsg?.payload).toBe('test-jwt-token');
    });

    it('transitions to authenticating when token provided', () => {
      provider = createProvider({ token: 'test-token' });
      provider.connect();
      mockWebSocket?.simulateOpen();

      // Should have called status change with 'authenticating'
      expect(onStatusChange).toHaveBeenCalledWith('authenticating', undefined);
    });

    it('transitions to authenticated on successful auth response', () => {
      provider = createProvider({ token: 'valid-token' });
      provider.connect();
      mockWebSocket?.simulateOpen();

      // Simulate auth response
      const response: AuthResponse = {
        success: true,
        userId: 'user-1',
        username: 'testuser',
        role: 'user',
      };
      mockWebSocket?.simulateMessage(encodeMessage(MESSAGE_AUTH_RESPONSE, response));

      expect(provider.getStatus()).toBe('authenticated');
      expect(provider.isAuthenticated()).toBe(true);
      expect(onAuthenticated).toHaveBeenCalledWith(true, {
        id: 'user-1',
        username: 'testuser',
        role: 'user',
      });
    });

    it('JP-123: notifies onAuthenticated before flipping status to authenticated', () => {
      // "Ready to operate" is a two-flag composite: connectionStore.status ===
      // 'authenticated' AND a flag the onAuthenticated handler sets. connectionStore
      // notifies subscribers synchronously inside setStatus, so onAuthenticated must
      // run first — otherwise a status-flip subscriber sees the second flag still
      // false and bails ("Cannot process queue: not connected"). Guard the ordering.
      provider = createProvider({ token: 'valid-token' });
      provider.connect();
      mockWebSocket?.simulateOpen();

      mockWebSocket?.simulateMessage(
        encodeMessage(MESSAGE_AUTH_RESPONSE, { success: true, userId: 'user-1' }),
      );

      const authedStatusOrder = onStatusChange.mock.calls
        .map((args, i) => ({ status: args[0], order: onStatusChange.mock.invocationCallOrder[i]! }))
        .find((c) => c.status === 'authenticated')?.order;
      const onAuthOrder = onAuthenticated.mock.invocationCallOrder[0];

      expect(authedStatusOrder).toBeDefined();
      expect(onAuthOrder).toBeLessThan(authedStatusOrder!);
    });

    it('transitions to error on failed auth response', () => {
      provider = createProvider({ token: 'invalid-token' });
      provider.connect();
      mockWebSocket?.simulateOpen();

      const response: AuthResponse = {
        success: false,
        error: 'Invalid token',
      };
      mockWebSocket?.simulateMessage(encodeMessage(MESSAGE_AUTH_RESPONSE, response));

      expect(provider.getStatus()).toBe('error');
      expect(provider.isAuthenticated()).toBe(false);
      expect(onAuthenticated).toHaveBeenCalledWith(false);
    });
  });

  describe('Document Events', () => {
    beforeEach(() => {
      provider = createProvider({ token: 'valid-token' });
      provider.connect();
      mockWebSocket?.simulateOpen();
      mockWebSocket?.simulateMessage(
        encodeMessage(MESSAGE_AUTH_RESPONSE, { success: true, userId: 'user-1' })
      );
    });

    it('triggers onDocumentEvent callback for created event', () => {
      const event: DocEvent = {
        eventType: 'created',
        docId: 'new-doc',
        userId: 'user-2',
        metadata: {
          id: 'new-doc',
          name: 'New Document',
          createdAt: Date.now(),
          modifiedAt: Date.now(),
          ownerId: 'user-2',
          ownerName: 'User 2',
          pageCount: 1,
        },
      };
      mockWebSocket?.simulateMessage(encodeMessage(MESSAGE_DOC_EVENT, event));

      expect(onDocumentEvent).toHaveBeenCalledWith(event);
    });

    it('triggers onDocumentEvent callback for updated event', () => {
      const event: DocEvent = {
        eventType: 'updated',
        docId: 'existing-doc',
        userId: 'user-1',
      };
      mockWebSocket?.simulateMessage(encodeMessage(MESSAGE_DOC_EVENT, event));

      expect(onDocumentEvent).toHaveBeenCalledWith(event);
    });

    it('triggers onDocumentEvent callback for deleted event', () => {
      const event: DocEvent = {
        eventType: 'deleted',
        docId: 'deleted-doc',
        userId: 'admin',
      };
      mockWebSocket?.simulateMessage(encodeMessage(MESSAGE_DOC_EVENT, event));

      expect(onDocumentEvent).toHaveBeenCalledWith(event);
    });
  });

  describe('Document Joining', () => {
    beforeEach(() => {
      provider = createProvider();
      provider.connect();
      mockWebSocket?.simulateOpen();
    });

    it('sends JOIN_DOC when joining a document', () => {
      mockWebSocket?.clearSentMessages();
      provider.joinDocument('new-doc-to-join');

      const joinMsg = mockWebSocket?.findSentMessage(MESSAGE_JOIN_DOC);
      expect(joinMsg).not.toBeNull();
      expect((joinMsg?.payload as JoinDocRequest).docId).toBe('new-doc-to-join');
    });
  });

  describe('Ready State', () => {
    it('isReady returns false when not authenticated', () => {
      provider = createProvider();
      provider.connect();
      mockWebSocket?.simulateOpen();

      expect(provider.isReady()).toBe(false);
    });

    it('isReady returns true when authenticated', () => {
      provider = createProvider({ token: 'valid' });
      provider.connect();
      mockWebSocket?.simulateOpen();
      mockWebSocket?.simulateMessage(
        encodeMessage(MESSAGE_AUTH_RESPONSE, { success: true, userId: 'u1' })
      );

      expect(provider.isReady()).toBe(true);
    });
  });

  describe('Reconnection', () => {
    it('does not reconnect when autoReconnect is false', () => {
      provider = createProvider({ autoReconnect: false });
      provider.connect();
      mockWebSocket?.simulateOpen();
      mockWebSocket?.simulateClose();

      vi.advanceTimersByTime(10000);

      // Should stay disconnected
      expect(provider.getStatus()).toBe('disconnected');
    });

    it('schedules reconnect when autoReconnect is true', () => {
      provider = createProvider({ autoReconnect: true, reconnectDelay: 1000 });
      provider.connect();
      const firstWs = mockWebSocket;
      firstWs?.simulateOpen();
      firstWs?.simulateClose();

      // Should be disconnected initially
      expect(provider.getStatus()).toBe('disconnected');

      // After delay, should try to reconnect
      vi.advanceTimersByTime(1000);

      // New WebSocket should be created
      expect(mockWebSocket).not.toBe(firstWs);
      expect(provider.getStatus()).toBe('connecting');
    });

    it('uses exponential backoff for reconnects', () => {
      provider = createProvider({ autoReconnect: true, reconnectDelay: 1000, maxReconnectAttempts: 5 });
      provider.connect();
      mockWebSocket?.simulateOpen();
      mockWebSocket?.simulateClose();

      // First reconnect at 1000ms
      vi.advanceTimersByTime(1000);
      mockWebSocket?.simulateClose();

      // Second reconnect at 2000ms
      vi.advanceTimersByTime(1500); // Not enough time
      expect(provider.getStatus()).toBe('disconnected');
      vi.advanceTimersByTime(500); // Now 2000ms total
      expect(provider.getStatus()).toBe('connecting');
    });

    it('stops reconnecting after max attempts', () => {
      provider = createProvider({ autoReconnect: true, reconnectDelay: 100, maxReconnectAttempts: 2 });
      provider.connect();
      mockWebSocket?.simulateOpen();

      // First close
      mockWebSocket?.simulateClose();
      vi.advanceTimersByTime(100);
      mockWebSocket?.simulateClose();

      // Second attempt
      vi.advanceTimersByTime(200);
      mockWebSocket?.simulateClose();

      // Should be at max attempts now
      vi.advanceTimersByTime(1000);
      expect(provider.getStatus()).toBe('error');
    });
  });

  describe('Connection Cleanup', () => {
    it('cleans up on destroy', () => {
      provider = createProvider();
      provider.connect();
      mockWebSocket?.simulateOpen();

      provider.destroy();

      expect(provider.getStatus()).toBe('disconnected');
      expect(mockWebSocket?.readyState).toBe(MockWebSocket.CLOSING);
    });
  });

  describe('Awareness', () => {
    beforeEach(() => {
      provider = createProvider();
      provider.connect();
      mockWebSocket?.simulateOpen();
    });

    it('provides awareness instance', () => {
      const awareness = provider.getAwareness();
      expect(awareness).toBeDefined();
      expect(awareness.doc).toBe(doc);
    });

    it('sets local awareness state', () => {
      provider.setLocalAwareness({
        id: 'user-1',
        name: 'Test User',
        color: '#ff0000',
      });

      const localState = provider.getAwareness().getLocalState();
      expect(localState?.['user']).toMatchObject({
        id: 'user-1',
        name: 'Test User',
        color: '#ff0000',
      });
    });

    it('updates cursor position', () => {
      provider.setLocalAwareness({ id: 'user-1', name: 'Test', color: '#000' });
      provider.updateCursor(100, 200);

      const localState = provider.getAwareness().getLocalState();
      const user = localState?.['user'] as { cursor?: { x: number; y: number } };
      expect(user?.cursor).toEqual({ x: 100, y: 200 });
    });

    it('updates selection', () => {
      provider.setLocalAwareness({ id: 'user-1', name: 'Test', color: '#000' });
      provider.updateSelection(['shape-1', 'shape-2']);

      const localState = provider.getAwareness().getLocalState();
      const user = localState?.['user'] as { selection?: string[] };
      expect(user?.selection).toEqual(['shape-1', 'shape-2']);
    });
  });

  describe('Error frames (JP-106)', () => {
    it('routes a MESSAGE_ERROR frame to onError with the current doc id', () => {
      const onError = vi.fn();
      provider = createProvider({ documentId: 'doc-A', onError });
      provider.connect();
      mockWebSocket?.simulateOpen(); // joins doc-A → currentDocId = 'doc-A'

      const frame = encodeMessage(MESSAGE_ERROR, {
        error: 'ERR_UNKNOWN_DOC',
      } satisfies ErrorResponse);
      mockWebSocket?.simulateMessage(frame);

      expect(onError).toHaveBeenCalledWith('ERR_UNKNOWN_DOC', 'doc-A');
    });

    it('keeps the connection open on a soft error frame', () => {
      provider = createProvider({ documentId: 'doc-A', onError: vi.fn() });
      provider.connect();
      mockWebSocket?.simulateOpen();

      mockWebSocket?.simulateMessage(
        encodeMessage(MESSAGE_ERROR, { error: 'ERR_UNKNOWN_DOC' }),
      );

      expect(provider.getStatus()).toBe('connected');
    });
  });

  describe('JP-309 large-update chunking', () => {
    function parseChunk(frame: Uint8Array) {
      const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      return {
        type: frame[0]!,
        msgId: frame.slice(1, 17),
        seq: view.getUint32(17, false),
        total: view.getUint32(21, false),
        payload: frame.slice(25),
      };
    }

    it('adopts the relay-advertised maxMessageSize from AUTH_RESPONSE', () => {
      provider = createProvider();
      provider.connect();
      mockWebSocket!.simulateOpen();
      mockWebSocket!.simulateMessage(
        encodeMessage(MESSAGE_AUTH_RESPONSE, {
          success: true,
          userId: 'u',
          maxMessageSize: 4242,
        } satisfies AuthResponse),
      );
      expect((provider as unknown as { maxMessageSize: number }).maxMessageSize).toBe(4242);
    });

    it('sends a sub-cap SYNC frame unchanged (single frame)', () => {
      provider = createProvider();
      provider.connect();
      mockWebSocket!.simulateOpen();
      (provider as unknown as { maxMessageSize: number }).maxMessageSize = 1024 * 1024;
      mockWebSocket!.clearSentMessages();

      const frame = new Uint8Array(500);
      frame[0] = MESSAGE_SYNC;
      (provider as unknown as { sendSyncFrame(f: Uint8Array): void }).sendSyncFrame(frame);

      expect(mockWebSocket!.sentMessages).toHaveLength(1);
      expect(decodeMessageType(mockWebSocket!.sentMessages[0]!)).toBe(MESSAGE_SYNC);
      expect(mockWebSocket!.sentMessages[0]).toEqual(frame);
    });

    it('splits an over-cap SYNC frame into chunks that reassemble byte-identically', () => {
      provider = createProvider();
      provider.connect();
      mockWebSocket!.simulateOpen();
      (provider as unknown as { maxMessageSize: number }).maxMessageSize = 1000;
      mockWebSocket!.clearSentMessages();

      // 600 KiB > the 256 KiB chunk size ⇒ multiple fragments.
      const frame = new Uint8Array(600 * 1024);
      for (let i = 0; i < frame.length; i++) frame[i] = i & 0xff;
      (provider as unknown as { sendSyncFrame(f: Uint8Array): void }).sendSyncFrame(frame);

      const chunks = mockWebSocket!.sentMessages.map(parseChunk);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((c) => c.type === MESSAGE_SYNC_CHUNK)).toBe(true);

      const total = chunks[0]!.total;
      expect(chunks).toHaveLength(total);
      // Same msgId across all fragments.
      const id0 = chunks[0]!.msgId;
      expect(chunks.every((c) => c.msgId.every((b, i) => b === id0[i]))).toBe(true);

      // Reassemble by seq and assert byte-identical to the original frame.
      const ordered = [...chunks].sort((a, b) => a.seq - b.seq);
      ordered.forEach((c, i) => expect(c.seq).toBe(i));
      const reassembled = new Uint8Array(frame.length);
      let off = 0;
      for (const c of ordered) {
        reassembled.set(c.payload, off);
        off += c.payload.length;
      }
      expect(reassembled).toEqual(frame);
    });
  });
});
