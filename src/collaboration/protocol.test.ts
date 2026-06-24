import { describe, it, expect } from 'vitest';
import {
  // Message type constants
  MESSAGE_SYNC,
  MESSAGE_AWARENESS,
  MESSAGE_AUTH,
  MESSAGE_DOC_EVENT,
  MESSAGE_ERROR,
  MESSAGE_AUTH_RESPONSE,
  MESSAGE_JOIN_DOC,
  // Error codes
  ERR_ACCESS_DENIED,
  ERR_DOC_NOT_FOUND,
  ERR_MESSAGE_TOO_LARGE,
  // Size constants
  MAX_MESSAGE_SIZE,
  MESSAGE_SIZE_WARNING_THRESHOLD,
  MAX_DOCUMENT_SIZE,
  // Functions
  encodeMessage,
  encodeMessageSafe,
  decodeMessageType,
  decodePayload,
  generateRequestId,
  hasErrorCode,
  isPermissionError,
  isUnknownDocError,
  isDeletedDocError,
  isCRDTMessage,
  getMessageTypeName,
  validateMessageSize,
  validateDocumentSize,
  getDocumentSize,
  MessageTooLargeError,
  // Types
  type AuthResponse,
  type DocEvent,
  type JoinDocRequest,
} from './protocol';

describe('Protocol Message Types', () => {
  it('has correct message type values', () => {
    expect(MESSAGE_SYNC).toBe(0);
    expect(MESSAGE_AWARENESS).toBe(1);
    expect(MESSAGE_AUTH).toBe(2);
    expect(MESSAGE_DOC_EVENT).toBe(7);
    expect(MESSAGE_ERROR).toBe(8);
    expect(MESSAGE_AUTH_RESPONSE).toBe(9);
    expect(MESSAGE_JOIN_DOC).toBe(10);
  });
});

describe('encodeMessage', () => {
  it('encodes a simple string payload', () => {
    const data = encodeMessage(MESSAGE_AUTH, 'test-token');

    expect(data[0]).toBe(MESSAGE_AUTH);
    const json = new TextDecoder().decode(data.slice(1));
    expect(JSON.parse(json)).toBe('test-token');
  });

  it('encodes a JoinDocRequest payload', () => {
    const payload: JoinDocRequest = { docId: 'doc-1' };
    const data = encodeMessage(MESSAGE_JOIN_DOC, payload);

    expect(data[0]).toBe(MESSAGE_JOIN_DOC);
    const json = new TextDecoder().decode(data.slice(1));
    expect(JSON.parse(json)).toEqual({ docId: 'doc-1' });
  });

  it('handles unicode characters', () => {
    const payload = { docId: '测试文档 📝' };
    const data = encodeMessage(MESSAGE_JOIN_DOC, payload);

    const decoded = JSON.parse(new TextDecoder().decode(data.slice(1)));
    expect(decoded.docId).toBe('测试文档 📝');
  });

  it('handles empty objects', () => {
    const data = encodeMessage(MESSAGE_AUTH_RESPONSE, {});

    expect(data[0]).toBe(MESSAGE_AUTH_RESPONSE);
    expect(JSON.parse(new TextDecoder().decode(data.slice(1)))).toEqual({});
  });

  it('handles null values in payload', () => {
    const payload = { requestId: 'req-1', error: null };
    const data = encodeMessage(MESSAGE_ERROR, payload);

    const decoded = JSON.parse(new TextDecoder().decode(data.slice(1)));
    expect(decoded.error).toBeNull();
  });
});

describe('decodeMessageType', () => {
  it('decodes message type from Uint8Array', () => {
    const data = encodeMessage(MESSAGE_AUTH_RESPONSE, { success: true });
    expect(decodeMessageType(data)).toBe(MESSAGE_AUTH_RESPONSE);
  });

  it('decodes message type from ArrayBuffer', () => {
    const data = encodeMessage(MESSAGE_AUTH_RESPONSE, { success: true });
    expect(decodeMessageType(new Uint8Array(data.buffer))).toBe(MESSAGE_AUTH_RESPONSE);
  });

  it('returns null for empty data', () => {
    expect(decodeMessageType(new Uint8Array(0))).toBeNull();
    expect(decodeMessageType(new ArrayBuffer(0))).toBeNull();
  });

  it('handles all live message types', () => {
    const types = [
      MESSAGE_SYNC,
      MESSAGE_AWARENESS,
      MESSAGE_AUTH,
      MESSAGE_DOC_EVENT,
      MESSAGE_ERROR,
      MESSAGE_AUTH_RESPONSE,
      MESSAGE_JOIN_DOC,
    ];

    for (const type of types) {
      const data = encodeMessage(type, {});
      expect(decodeMessageType(data)).toBe(type);
    }
  });
});

describe('decodePayload', () => {
  it('decodes string payload', () => {
    const data = encodeMessage(MESSAGE_AUTH, 'my-token');
    const payload = decodePayload<string>(data);
    expect(payload).toBe('my-token');
  });

  it('decodes AuthResponse object', () => {
    const original: AuthResponse = {
      success: true,
      userId: 'user-1',
      username: 'testuser',
      role: 'admin',
      token: 'jwt-token',
      tokenExpiresAt: 1234567890,
    };
    const data = encodeMessage(MESSAGE_AUTH_RESPONSE, original);
    const payload = decodePayload<AuthResponse>(data);

    expect(payload.success).toBe(true);
    expect(payload.userId).toBe('user-1');
    expect(payload.username).toBe('testuser');
    expect(payload.role).toBe('admin');
    expect(payload.token).toBe('jwt-token');
    expect(payload.tokenExpiresAt).toBe(1234567890);
  });

  it('decodes from ArrayBuffer', () => {
    const original: JoinDocRequest = { docId: 'doc-1' };
    const data = encodeMessage(MESSAGE_JOIN_DOC, original);
    const payload = decodePayload<JoinDocRequest>(new Uint8Array(data.buffer));

    expect(payload.docId).toBe('doc-1');
  });

  it('decodes document event', () => {
    const original: DocEvent = {
      eventType: 'updated',
      docId: 'doc-1',
      userId: 'user-1',
      metadata: {
        id: 'doc-1',
        name: 'Updated Doc',
        createdAt: 1000,
        modifiedAt: 5000,
        ownerId: 'user-1',
        ownerName: 'User 1',
        pageCount: 1,
      },
    };
    const data = encodeMessage(MESSAGE_DOC_EVENT, original);
    const payload = decodePayload<DocEvent>(data);

    expect(payload.eventType).toBe('updated');
    expect(payload.docId).toBe('doc-1');
    expect(payload.metadata?.name).toBe('Updated Doc');
  });

  it('throws for message too short', () => {
    expect(() => decodePayload(new Uint8Array(0))).toThrow('Message too short');
    expect(() => decodePayload(new Uint8Array(1))).toThrow('Message too short');
  });

  it('throws for invalid JSON', () => {
    const invalidData = new Uint8Array([MESSAGE_AUTH_RESPONSE, 0x7b, 0x7b]); // "{{"
    expect(() => decodePayload(invalidData)).toThrow();
  });
});

describe('generateRequestId', () => {
  it('generates unique IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateRequestId());
    }
    expect(ids.size).toBe(100);
  });

  it('starts with req- prefix', () => {
    const id = generateRequestId();
    expect(id.startsWith('req-')).toBe(true);
  });

  it('contains timestamp component', () => {
    const beforeTime = Date.now();
    const id = generateRequestId();
    const afterTime = Date.now();

    const parts = id.split('-');
    const timestamp = parseInt(parts[1]!, 10);

    expect(timestamp).toBeGreaterThanOrEqual(beforeTime);
    expect(timestamp).toBeLessThanOrEqual(afterTime);
  });
});

describe('Error Code Helpers', () => {
  describe('hasErrorCode', () => {
    it('detects error code at start of string', () => {
      expect(hasErrorCode('ERR_ACCESS_DENIED: You do not have access', ERR_ACCESS_DENIED)).toBe(true);
      expect(hasErrorCode('ERR_DOC_NOT_FOUND', ERR_DOC_NOT_FOUND)).toBe(true);
    });

    it('returns false when code not at start', () => {
      expect(hasErrorCode('Error: ERR_ACCESS_DENIED', ERR_ACCESS_DENIED)).toBe(false);
      expect(hasErrorCode('Some other error', ERR_ACCESS_DENIED)).toBe(false);
    });

    it('handles empty strings', () => {
      expect(hasErrorCode('', ERR_ACCESS_DENIED)).toBe(false);
    });
  });

  describe('isPermissionError', () => {
    it('detects all permission error types', () => {
      expect(isPermissionError('ERR_ACCESS_DENIED: No access')).toBe(true);
      expect(isPermissionError('ERR_DELETE_FORBIDDEN: Cannot delete')).toBe(true);
      expect(isPermissionError('ERR_EDIT_FORBIDDEN: Cannot edit')).toBe(true);
      expect(isPermissionError('ERR_VIEW_FORBIDDEN: Cannot view')).toBe(true);
      expect(isPermissionError('ERR_NOT_AUTHENTICATED: Please login')).toBe(true);
    });

    it('returns false for non-permission errors', () => {
      expect(isPermissionError('ERR_DOC_NOT_FOUND')).toBe(false);
      expect(isPermissionError('Network error')).toBe(false);
      expect(isPermissionError('Timeout')).toBe(false);
    });
  });

  describe('isUnknownDocError', () => {
    it('detects a rejected JOIN_DOC (ERR_UNKNOWN_DOC)', () => {
      expect(isUnknownDocError('ERR_UNKNOWN_DOC')).toBe(true);
      expect(isUnknownDocError('ERR_UNKNOWN_DOC: no such doc')).toBe(true);
    });

    it('returns false for other errors', () => {
      expect(isUnknownDocError('ERR_DOC_NOT_FOUND')).toBe(false);
      expect(isUnknownDocError('ERR_ACCESS_DENIED')).toBe(false);
      expect(isUnknownDocError('')).toBe(false);
    });
  });

  describe('isDeletedDocError', () => {
    it('detects a tombstoned-doc rejection (ERR_DELETED)', () => {
      expect(isDeletedDocError('ERR_DELETED')).toBe(true);
      expect(isDeletedDocError('ERR_DELETED: tombstoned')).toBe(true);
    });

    it('returns false for other errors (incl. the unknown-doc code)', () => {
      expect(isDeletedDocError('ERR_UNKNOWN_DOC')).toBe(false);
      expect(isDeletedDocError('ERR_ACCESS_DENIED')).toBe(false);
      expect(isDeletedDocError('')).toBe(false);
    });
  });
});

describe('Message Classification', () => {
  describe('isCRDTMessage', () => {
    it('returns true for CRDT messages', () => {
      expect(isCRDTMessage(MESSAGE_SYNC)).toBe(true);
      expect(isCRDTMessage(MESSAGE_AWARENESS)).toBe(true);
    });

    it('returns false for non-CRDT messages', () => {
      expect(isCRDTMessage(MESSAGE_AUTH)).toBe(false);
      expect(isCRDTMessage(MESSAGE_DOC_EVENT)).toBe(false);
      expect(isCRDTMessage(MESSAGE_JOIN_DOC)).toBe(false);
    });
  });
});

describe('getMessageTypeName', () => {
  it('returns human-readable names for all live types', () => {
    expect(getMessageTypeName(MESSAGE_SYNC)).toBe('SYNC');
    expect(getMessageTypeName(MESSAGE_AWARENESS)).toBe('AWARENESS');
    expect(getMessageTypeName(MESSAGE_AUTH)).toBe('AUTH');
    expect(getMessageTypeName(MESSAGE_DOC_EVENT)).toBe('DOC_EVENT');
    expect(getMessageTypeName(MESSAGE_ERROR)).toBe('ERROR');
    expect(getMessageTypeName(MESSAGE_AUTH_RESPONSE)).toBe('AUTH_RESPONSE');
    expect(getMessageTypeName(MESSAGE_JOIN_DOC)).toBe('JOIN_DOC');
  });

  it('returns UNKNOWN for unknown types (including the reserved E.3 slots)', () => {
    expect(getMessageTypeName(3)).toBe('UNKNOWN(3)'); // formerly DOC_LIST
    expect(getMessageTypeName(11)).toBe('UNKNOWN(11)'); // formerly AUTH_LOGIN
    expect(getMessageTypeName(99)).toBe('UNKNOWN(99)');
    expect(getMessageTypeName(255)).toBe('UNKNOWN(255)');
  });
});

describe('Round-trip Encoding/Decoding', () => {
  it('preserves data through encode/decode cycle', () => {
    const payloads = [
      { docId: 'doc-1' },
      { success: true, token: 'jwt-abc123' },
      { eventType: 'created', docId: 'doc-2', userId: 'user-1' },
      { requestId: 'req-x', error: 'something failed' },
    ];

    for (const payload of payloads) {
      const encoded = encodeMessage(MESSAGE_DOC_EVENT, payload);
      const decoded = decodePayload(encoded);
      expect(decoded).toEqual(payload);
    }
  });

  it('preserves arrays correctly', () => {
    const payload = { items: [1, 2, 3, 'a', 'b', { nested: true }] };
    const encoded = encodeMessage(MESSAGE_ERROR, payload);
    const decoded = decodePayload<typeof payload>(encoded);

    expect(decoded.items).toEqual([1, 2, 3, 'a', 'b', { nested: true }]);
  });

  it('preserves special number values', () => {
    const payload = { zero: 0, negative: -100, float: 3.14159 };
    const encoded = encodeMessage(MESSAGE_ERROR, payload);
    const decoded = decodePayload<typeof payload>(encoded);

    expect(decoded.zero).toBe(0);
    expect(decoded.negative).toBe(-100);
    expect(decoded.float).toBeCloseTo(3.14159);
  });

  it('preserves boolean values', () => {
    const payload = { trueVal: true, falseVal: false };
    const encoded = encodeMessage(MESSAGE_AUTH_RESPONSE, payload);
    const decoded = decodePayload<typeof payload>(encoded);

    expect(decoded.trueVal).toBe(true);
    expect(decoded.falseVal).toBe(false);
  });
});

describe('Message Size Validation', () => {
  describe('validateMessageSize', () => {
    it('validates small messages as OK', () => {
      const data = new Uint8Array(100);
      const result = validateMessageSize(data);

      expect(result.valid).toBe(true);
      expect(result.size).toBe(100);
      expect(result.warning).toBeUndefined();
      expect(result.error).toBeUndefined();
    });

    it('returns warning for messages over threshold but under limit', () => {
      const data = new Uint8Array(MESSAGE_SIZE_WARNING_THRESHOLD + 1);
      const result = validateMessageSize(data);

      expect(result.valid).toBe(true);
      expect(result.size).toBe(MESSAGE_SIZE_WARNING_THRESHOLD + 1);
      expect(result.warning).toBeDefined();
      expect(result.warning).toContain('Large message');
      expect(result.error).toBeUndefined();
    });

    it('rejects messages over max size', () => {
      const data = new Uint8Array(MAX_MESSAGE_SIZE + 1);
      const result = validateMessageSize(data);

      expect(result.valid).toBe(false);
      expect(result.size).toBe(MAX_MESSAGE_SIZE + 1);
      expect(result.error).toBeDefined();
      expect(result.error).toContain(ERR_MESSAGE_TOO_LARGE);
      expect(result.warning).toBeUndefined();
    });
  });

  describe('encodeMessage with size limits', () => {
    it('throws MessageTooLargeError for oversized messages', () => {
      const largeString = 'x'.repeat(MAX_MESSAGE_SIZE);
      const payload = { data: largeString };

      expect(() => encodeMessage(MESSAGE_DOC_EVENT, payload)).toThrow(MessageTooLargeError);
    });

    it('MessageTooLargeError has correct properties', () => {
      const error = new MessageTooLargeError(20_000_000, MAX_MESSAGE_SIZE);

      expect(error.name).toBe('MessageTooLargeError');
      expect(error.size).toBe(20_000_000);
      expect(error.limit).toBe(MAX_MESSAGE_SIZE);
      expect(error.message).toContain(ERR_MESSAGE_TOO_LARGE);
    });
  });

  describe('encodeMessageSafe', () => {
    it('returns warning for large messages within limit', () => {
      const mediumString = 'x'.repeat(MESSAGE_SIZE_WARNING_THRESHOLD);
      const payload = { data: mediumString };

      const result = encodeMessageSafe(MESSAGE_DOC_EVENT, payload);

      expect(result.data.length).toBeGreaterThan(MESSAGE_SIZE_WARNING_THRESHOLD);
      expect(result.size).toBe(result.data.length);
      expect(result.warning).toBeDefined();
      expect(result.warning).toContain('Large message');
    });

    it('returns data without warning for small messages', () => {
      const payload = { id: 'test', name: 'Small payload' };

      const result = encodeMessageSafe(MESSAGE_DOC_EVENT, payload);

      expect(result.data.length).toBeLessThan(MESSAGE_SIZE_WARNING_THRESHOLD);
      expect(result.warning).toBeUndefined();
    });

    it('throws MessageTooLargeError for oversized messages', () => {
      const largeString = 'x'.repeat(MAX_MESSAGE_SIZE);
      const payload = { data: largeString };

      expect(() => encodeMessageSafe(MESSAGE_DOC_EVENT, payload)).toThrow(MessageTooLargeError);
    });
  });
});

describe('Document Size Validation', () => {
  describe('validateDocumentSize', () => {
    it('returns undefined for small documents', () => {
      const doc = { id: 'test', name: 'Test Doc', pages: [] };
      const error = validateDocumentSize(doc);
      expect(error).toBeUndefined();
    });

    it('returns error message for oversized documents', () => {
      const largeData = 'x'.repeat(MAX_DOCUMENT_SIZE);
      const doc = { id: 'test', data: largeData };
      const error = validateDocumentSize(doc);

      expect(error).toBeDefined();
      expect(error).toContain('exceeds limit');
    });
  });

  describe('getDocumentSize', () => {
    it('returns correct byte size for document', () => {
      const doc = { test: 'value' };
      const expectedSize = new TextEncoder().encode(JSON.stringify(doc)).length;
      expect(getDocumentSize(doc)).toBe(expectedSize);
    });

    it('accounts for unicode characters correctly', () => {
      const doc = { name: '测试文档 📝' };
      const expectedSize = new TextEncoder().encode(JSON.stringify(doc)).length;
      expect(getDocumentSize(doc)).toBe(expectedSize);
      expect(getDocumentSize(doc)).toBeGreaterThan(doc.name.length);
    });
  });
});
