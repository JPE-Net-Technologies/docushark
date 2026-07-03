import { describe, it, expect } from 'vitest';
import { collabIdbRoom } from './collabRoom';

describe('collabIdbRoom', () => {
  it('keys on host:port + doc id, ignoring scheme and path', () => {
    // The live session builds the room from its WS serverUrl; the offline
    // prefetch builds it from restUrlToWsUrl(relayUrl). Both must land on the
    // SAME key, so scheme (ws/wss/http/https) and path must not change it.
    const doc = 'doc-abc';
    const ws = collabIdbRoom('wss://relay.example.com/ws', doc);
    expect(ws).toBe('relay.example.com:doc-abc');
    // http/ws/https forms of the same host all match.
    expect(collabIdbRoom('https://relay.example.com', doc)).toBe(ws);
    expect(collabIdbRoom('ws://relay.example.com/ws?x=1', doc)).toBe(ws);
  });

  it('preserves an explicit port in the key', () => {
    expect(collabIdbRoom('ws://localhost:9876/ws', 'd1')).toBe('localhost:9876:d1');
  });

  it('separates docs on the same host', () => {
    const a = collabIdbRoom('wss://r.example.com/ws', 'a');
    const b = collabIdbRoom('wss://r.example.com/ws', 'b');
    expect(a).not.toBe(b);
  });
});
