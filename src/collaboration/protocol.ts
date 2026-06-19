/**
 * Protocol message types and structures for the relay WebSocket
 * channel.
 *
 * Phase 20.3 Slice E.3: the WS now carries only CRDT sync (Yjs),
 * awareness, bearer-token auth, JOIN_DOC routing, and DOC_EVENT
 * broadcasts. Document CRUD and credential-based login moved to
 * REST (`src/api/relayClient.ts`). The deleted message-type bytes
 * (3–6, 11–13) stay reserved so future additions don't reuse them.
 *
 * Must match the Rust definitions in `relay/src/server/protocol.rs`.
 */

import type { DocumentMetadata } from '../types/Document';

// ============ Protocol Version ============

/**
 * Wire-protocol version. Must match `PROTOCOL_VERSION` in
 * src-tauri/src/server/protocol.rs (and the future /relay/ crate).
 *
 * Sent as `?protocolVersion=<N>` on the WebSocket upgrade URL. The
 * server refuses connections with a different version. Bump on any
 * breaking change to message types, payload shapes, or framing.
 *
 * v4 (JP-340): canvas shapes are per-page (`shapes:<id>`/`shapeOrder:<id>`
 * shared types) instead of a single active-page `shapes`/`shapeOrder` surface.
 */
export const PROTOCOL_VERSION = 4;

/** Query-parameter name carrying the client's protocol version. */
export const PROTOCOL_VERSION_PARAM = 'protocolVersion';

/** Error code returned when client/server protocol versions disagree. */
export const ERR_PROTOCOL_VERSION_MISMATCH = 'ERR_PROTOCOL_VERSION_MISMATCH';

// ============ Message Type Constants ============
// Must match MESSAGE_* constants in `relay/src/server/protocol.rs`.
// Reserved gaps (3–6, 11–13) are intentional — see module docs.

/** Yjs CRDT sync messages */
export const MESSAGE_SYNC = 0;

/** Awareness/presence messages */
export const MESSAGE_AWARENESS = 1;

/** Authentication (JWT bearer-token validation on the WS channel) */
export const MESSAGE_AUTH = 2;

// 3..=6 reserved (formerly DOC_LIST/GET/SAVE/DELETE — now REST)

/** Document event broadcast (from the relay to clients) */
export const MESSAGE_DOC_EVENT = 7;

/** Error response */
export const MESSAGE_ERROR = 8;

/** Authentication response (server → client, after MESSAGE_AUTH) */
export const MESSAGE_AUTH_RESPONSE = 9;

/** Join document (for CRDT room routing) */
export const MESSAGE_JOIN_DOC = 10;

// 11..=13 reserved (formerly AUTH_LOGIN, DOC_SHARE, DOC_TRANSFER — now REST)

/**
 * A fragment of a large SYNC frame, split client→relay so a big offline-
 * reconnect update can be delivered under the per-message cap (JP-309).
 * Body (binary): `[msgId: 16 bytes][seq: u32 BE][total: u32 BE][payload]`.
 */
export const MESSAGE_SYNC_CHUNK = 14;

/** Relay→client ack once a chunked update's msgId is reassembled + applied.
 * Body (binary): `[msgId: 16 bytes]`. */
export const MESSAGE_SYNC_CHUNK_ACK = 15;

// ============ Request/Response Types ============

/** Authentication response from server */
export interface AuthResponse {
  success: boolean;
  userId?: string;
  username?: string;
  role?: string;
  /** JWT token (returned on successful login) */
  token?: string;
  /** Token expiration timestamp in milliseconds */
  tokenExpiresAt?: number;
  error?: string;
  /**
   * Relay's inbound per-message cap in bytes (JP-309). The client splits any
   * outbound SYNC frame larger than this into MESSAGE_SYNC_CHUNK frames. Absent
   * on older relays → the client falls back to its built-in default.
   */
  maxMessageSize?: number;
}

/** Document event types */
export type DocEventType = 'created' | 'updated' | 'deleted';

/** Document event broadcast message */
export interface DocEvent {
  eventType: DocEventType;
  docId: string;
  metadata?: DocumentMetadata;
  userId: string;
}

/** Join document request (for CRDT routing) */
export interface JoinDocRequest {
  docId: string;
}

/** Error response */
export interface ErrorResponse {
  requestId?: string;
  error: string;
  /** Error code for programmatic handling */
  code?: string;
}

// ============ Permission Error Codes ============
// Must match error_codes in Rust permissions.rs

/** User lacks required permission for operation */
export const ERR_ACCESS_DENIED = 'ERR_ACCESS_DENIED';
/** Document not found */
export const ERR_DOC_NOT_FOUND = 'ERR_DOC_NOT_FOUND';
/** User not authenticated */
export const ERR_NOT_AUTHENTICATED = 'ERR_NOT_AUTHENTICATED';
/** Permission level insufficient for delete operation */
export const ERR_DELETE_FORBIDDEN = 'ERR_DELETE_FORBIDDEN';
/** Permission level insufficient for edit operation */
export const ERR_EDIT_FORBIDDEN = 'ERR_EDIT_FORBIDDEN';
/** Permission level insufficient for view operation */
export const ERR_VIEW_FORBIDDEN = 'ERR_VIEW_FORBIDDEN';
/**
 * Sent by the relay when a client's JOIN_DOC targets a doc id the relay
 * has no record of in the client's workspace (never promoted, deleted, or
 * a diverged local-only id). The join is refused; the connection stays
 * open. The client should treat the doc as local-only / not syncing.
 */
export const ERR_UNKNOWN_DOC = 'ERR_UNKNOWN_DOC';

/** True for an unknown-doc JOIN_DOC rejection (see {@link ERR_UNKNOWN_DOC}). */
export function isUnknownDocError(error: string): boolean {
  return hasErrorCode(error, ERR_UNKNOWN_DOC);
}

// ============ Message Size Limits ============

/** Maximum message size in bytes (16 MB) */
export const MAX_MESSAGE_SIZE = 16 * 1024 * 1024;

/** Warning threshold for large messages (1 MB) */
export const MESSAGE_SIZE_WARNING_THRESHOLD = 1 * 1024 * 1024;

/** Maximum document size in bytes (8 MB) */
export const MAX_DOCUMENT_SIZE = 8 * 1024 * 1024;

/** Error for messages that exceed size limit */
export const ERR_MESSAGE_TOO_LARGE = 'ERR_MESSAGE_TOO_LARGE';

/**
 * Result of message size validation.
 */
export interface MessageSizeValidation {
  valid: boolean;
  size: number;
  error?: string;
  warning?: string;
}

/**
 * Validate message size before sending.
 * Returns validation result with size info.
 */
export function validateMessageSize(data: Uint8Array): MessageSizeValidation {
  const size = data.length;
  
  if (size > MAX_MESSAGE_SIZE) {
    return {
      valid: false,
      size,
      error: `${ERR_MESSAGE_TOO_LARGE}: Message size ${formatBytes(size)} exceeds limit of ${formatBytes(MAX_MESSAGE_SIZE)}`,
    };
  }
  
  if (size > MESSAGE_SIZE_WARNING_THRESHOLD) {
    return {
      valid: true,
      size,
      warning: `Large message (${formatBytes(size)}). Consider chunking for better performance.`,
    };
  }
  
  return { valid: true, size };
}

/**
 * Format bytes as human-readable string.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Check if an error string contains a specific error code.
 */
export function hasErrorCode(error: string, code: string): boolean {
  return error.startsWith(code);
}

/**
 * Check if an error is a permission error.
 */
export function isPermissionError(error: string): boolean {
  return hasErrorCode(error, ERR_ACCESS_DENIED) ||
         hasErrorCode(error, ERR_DELETE_FORBIDDEN) ||
         hasErrorCode(error, ERR_EDIT_FORBIDDEN) ||
         hasErrorCode(error, ERR_VIEW_FORBIDDEN) ||
         hasErrorCode(error, ERR_NOT_AUTHENTICATED);
}

// ============ Encoding/Decoding Helpers ============

/**
 * Result of encoding a message with size validation.
 */
export interface EncodeResult {
  data: Uint8Array;
  size: number;
  warning?: string;
}

/**
 * Error thrown when message exceeds size limit.
 */
export class MessageTooLargeError extends Error {
  constructor(
    public readonly size: number,
    public readonly limit: number
  ) {
    super(`${ERR_MESSAGE_TOO_LARGE}: Message size ${formatBytes(size)} exceeds limit of ${formatBytes(limit)}`);
    this.name = 'MessageTooLargeError';
  }
}

/**
 * Encode a message with type prefix for sending over WebSocket.
 * Format: [msgType (1 byte)][JSON payload]
 * 
 * @throws MessageTooLargeError if encoded size exceeds MAX_MESSAGE_SIZE
 */
export function encodeMessage<T>(msgType: number, payload: T): Uint8Array {
  const json = JSON.stringify(payload);
  const jsonBytes = new TextEncoder().encode(json);
  const data = new Uint8Array(1 + jsonBytes.length);
  data[0] = msgType;
  data.set(jsonBytes, 1);
  
  if (data.length > MAX_MESSAGE_SIZE) {
    throw new MessageTooLargeError(data.length, MAX_MESSAGE_SIZE);
  }
  
  return data;
}

/**
 * Encode a message with size validation, returning result with warnings.
 * Does not throw on large messages within limit, but returns warnings.
 * 
 * @throws MessageTooLargeError if encoded size exceeds MAX_MESSAGE_SIZE
 */
export function encodeMessageSafe<T>(msgType: number, payload: T): EncodeResult {
  const data = encodeMessage(msgType, payload);
  const validation = validateMessageSize(data);
  
  return {
    data,
    size: validation.size,
    ...(validation.warning !== undefined ? { warning: validation.warning } : {}),
  };
}

/**
 * Decode the message type from binary data.
 */
export function decodeMessageType(data: Uint8Array | ArrayBuffer): number | null {
  const arr = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  if (arr.length === 0) return null;
  const msgType = arr[0];
  return msgType !== undefined ? msgType : null;
}

/**
 * Decode the message payload (everything after the first byte).
 */
export function decodePayload<T>(data: Uint8Array | ArrayBuffer): T {
  const arr = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  if (arr.length < 2) {
    throw new Error('Message too short');
  }
  const json = new TextDecoder().decode(arr.slice(1));
  return JSON.parse(json) as T;
}

/**
 * Generate a unique request ID.
 */
export function generateRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ============ Message Classification ============

/**
 * Check if a message type is a CRDT sync message (SYNC or AWARENESS).
 * Retained because BlobSyncService / engine code still distinguishes
 * CRDT traffic from everything else for diagnostics.
 */
export function isCRDTMessage(msgType: number): boolean {
  return msgType === MESSAGE_SYNC || msgType === MESSAGE_AWARENESS;
}

/**
 * Validate document size before saving.
 * @returns Error message if too large, undefined if OK
 */
export function validateDocumentSize(document: unknown): string | undefined {
  const json = JSON.stringify(document);
  const size = new TextEncoder().encode(json).length;

  if (size > MAX_DOCUMENT_SIZE) {
    return `Document size ${formatBytes(size)} exceeds limit of ${formatBytes(MAX_DOCUMENT_SIZE)}`;
  }

  return undefined;
}

/**
 * Get the serialized size of a document in bytes.
 */
export function getDocumentSize(document: unknown): number {
  const json = JSON.stringify(document);
  return new TextEncoder().encode(json).length;
}

/**
 * Get human-readable name for a message type (for debugging).
 */
export function getMessageTypeName(msgType: number): string {
  switch (msgType) {
    case MESSAGE_SYNC: return 'SYNC';
    case MESSAGE_AWARENESS: return 'AWARENESS';
    case MESSAGE_AUTH: return 'AUTH';
    case MESSAGE_DOC_EVENT: return 'DOC_EVENT';
    case MESSAGE_ERROR: return 'ERROR';
    case MESSAGE_AUTH_RESPONSE: return 'AUTH_RESPONSE';
    case MESSAGE_JOIN_DOC: return 'JOIN_DOC';
    default: return `UNKNOWN(${msgType})`;
  }
}