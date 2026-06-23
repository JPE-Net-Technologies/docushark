import { describe, it, expect } from 'vitest';
import { decodeJwtPayload, userFromRelayToken } from './relayTokenUser';

/** Build an unsigned JWT (`header.payload.sig`) with a base64url payload. */
function makeToken(payload: unknown): string {
  const b64url = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(payload)}.sig`;
}

describe('decodeJwtPayload', () => {
  it('decodes a base64url payload', () => {
    expect(decodeJwtPayload(makeToken({ sub: 'u1', n: 2 }))).toEqual({ sub: 'u1', n: 2 });
  });

  it('returns null for malformed tokens', () => {
    expect(decodeJwtPayload('')).toBeNull();
    expect(decodeJwtPayload('only-one-segment')).toBeNull();
    expect(decodeJwtPayload('a..c')).toBeNull(); // empty payload segment
    expect(decodeJwtPayload('a.not-base64-$$$.c')).toBeNull();
  });
});

describe('userFromRelayToken', () => {
  it('maps sub → id + username, and wsp[0].role → role', () => {
    const token = makeToken({ sub: 'user-123', wsp: [{ role: 'admin', id: 'ws1' }] });
    expect(userFromRelayToken(token)).toEqual({ id: 'user-123', username: 'user-123', role: 'admin' });
  });

  it('omits role when there is no workspace claim', () => {
    expect(userFromRelayToken(makeToken({ sub: 'user-123' }))).toEqual({
      id: 'user-123',
      username: 'user-123',
    });
  });

  it('returns null without a usable subject', () => {
    expect(userFromRelayToken(makeToken({ wsp: [{ role: 'user' }] }))).toBeNull();
    expect(userFromRelayToken(makeToken({ sub: '' }))).toBeNull();
    expect(userFromRelayToken('garbage')).toBeNull();
  });
});
