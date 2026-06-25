import { describe, it, expect } from 'vitest';
import { inviteToken } from './WorkspaceMembersSection';

// JP-370: revoking an invite parses the opaque token out of the invite URL.
// A naive last-segment split breaks when the URL carries a query/fragment —
// the token would then carry `?...`/`#...` and the server-side revoke misses.
describe('inviteToken', () => {
  it('extracts the token from a plain invite URL', () => {
    expect(inviteToken('https://app.docushark.app/invite/abc123')).toBe('abc123');
  });

  it('ignores a query string and fragment', () => {
    expect(inviteToken('https://app.docushark.app/invite/abc123?ref=x')).toBe('abc123');
    expect(inviteToken('https://app.docushark.app/invite/abc123#frag')).toBe('abc123');
    expect(inviteToken('https://app.docushark.app/invite/abc123?a=1#b')).toBe('abc123');
  });

  it('url-decodes a percent-encoded token', () => {
    expect(inviteToken('https://app.docushark.app/invite/a%2Bb')).toBe('a+b');
  });

  it('falls back to a path split for a non-absolute URL', () => {
    expect(inviteToken('/invite/tok-9?x=1')).toBe('tok-9');
  });

  it('returns empty for a URL with no path', () => {
    expect(inviteToken('https://app.docushark.app')).toBe('');
  });
});
