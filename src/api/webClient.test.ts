import { describe, it, expect, vi } from 'vitest';
import { webClient, WebClientError } from './webClient';

const BASE = 'https://cloud.test';
const TOKEN = 'relay.jwt.token';
const WS = 'ws-123';

/** A fetch stub that records the last call and returns a canned JSON response. */
function stubFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const deps = (impl: typeof fetch) => ({ fetchImpl: impl, baseUrl: BASE, token: TOKEN });

describe('webClient', () => {
  it('getWorkspaceMembers hits /members with the bearer token and unwraps the list', async () => {
    const { impl, calls } = stubFetch(200, {
      members: [{ userId: 'u1', email: 'a@b.c', displayName: 'Alice', role: 'owner' }],
    });
    const members = await webClient.getWorkspaceMembers(WS, deps(impl));

    expect(members).toHaveLength(1);
    expect(members[0]?.displayName).toBe('Alice');
    expect(calls[0]?.url).toBe(`${BASE}/api/v1/workspace/${WS}/members`);
    expect((calls[0]?.init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('createInvite POSTs the role and returns the invite', async () => {
    const { impl, calls } = stubFetch(201, {
      id: 'inv1',
      url: `${BASE}/invite/abc`,
      role: 'viewer',
      expiresAt: 'x',
      createdAt: 'y',
    });
    const invite = await webClient.createInvite('viewer', WS, deps(impl));

    expect(invite.url).toBe(`${BASE}/invite/abc`);
    expect(calls[0]?.url).toBe(`${BASE}/api/v1/workspace/${WS}/invites`);
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ role: 'viewer' });
  });

  it('listWorkspaces unwraps the workspaces array', async () => {
    const { impl } = stubFetch(200, {
      workspaces: [{ id: WS, name: 'Acme', slug: 'acme', region: 'yyz', role: 'owner' }],
    });
    const out = await webClient.listWorkspaces(deps(impl));
    expect(out[0]?.name).toBe('Acme');
  });

  it('throws WebClientError with the server error code on a non-2xx', async () => {
    const { impl } = stubFetch(403, { error: 'owner_required' });
    await expect(webClient.createInvite('member', WS, deps(impl))).rejects.toMatchObject({
      name: 'WebClientError',
      status: 403,
      code: 'owner_required',
    });
  });

  it('surfaces the server `detail` as the error message, not the machine code', async () => {
    // `detail` used to be parsed and dropped here, so an import that failed on
    // a Notion 429 reached the user as a toast reading "fetch_failed" — a
    // machine code that names no cause and points at the wrong layer entirely
    // (2026-09-07). The toast renders `.message`, so this IS the user-visible
    // string.
    const { impl } = stubFetch(502, {
      error: 'fetch_failed',
      code: 'provider_429',
      detail: 'notion is rate-limiting this import. Wait a moment and try again.',
      retryable: true,
    });

    const err = (await webClient
      .fetchIntegrationResource('notion', 'p1', WS, deps(impl))
      .catch((e: unknown) => e)) as WebClientError;

    expect(err.message).toContain('rate-limiting');
    expect(err.code).toBe('fetch_failed');
    expect(err.retryable).toBe(true);
  });

  it('falls back to the code when the server sends no detail', async () => {
    const { impl } = stubFetch(409, { error: 'not_connected' });

    const err = (await webClient
      .fetchIntegrationResource('notion', 'p1', WS, deps(impl))
      .catch((e: unknown) => e)) as WebClientError;

    expect(err.message).toBe('not_connected');
    expect(err.retryable).toBe(false);
  });

  it('treats a non-retryable failure as non-retryable even with a detail', async () => {
    const { impl } = stubFetch(502, {
      error: 'fetch_failed',
      detail: 'notion could not find this page.',
      retryable: false,
    });

    const err = (await webClient
      .fetchIntegrationResource('notion', 'p1', WS, deps(impl))
      .catch((e: unknown) => e)) as WebClientError;

    expect(err.message).toContain('could not find');
    expect(err.retryable).toBe(false);
  });

  it('ignores a non-string detail rather than rendering [object Object]', async () => {
    const { impl } = stubFetch(502, { error: 'fetch_failed', detail: { nested: 'oops' } });

    const err = (await webClient
      .fetchIntegrationResource('notion', 'p1', WS, deps(impl))
      .catch((e: unknown) => e)) as WebClientError;

    expect(err.message).toBe('fetch_failed');
  });

  it('survives a non-JSON error body', async () => {
    const impl = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('not json');
      },
    })) as unknown as typeof fetch;

    const err = (await webClient
      .fetchIntegrationResource('notion', 'p1', WS, deps(impl))
      .catch((e: unknown) => e)) as WebClientError;

    expect(err.code).toBe('http_502');
    expect(err.retryable).toBe(false);
  });

  it('refuses to call without a token', async () => {
    const { impl, calls } = stubFetch(200, { members: [] });
    await expect(
      webClient.getWorkspaceMembers(WS, { fetchImpl: impl, baseUrl: BASE, token: null }),
    ).rejects.toBeInstanceOf(WebClientError);
    expect(calls).toHaveLength(0); // never hit the network
  });

  it('revokeInvite issues a DELETE to the token path', async () => {
    const { impl, calls } = stubFetch(200, { ok: true });
    await webClient.revokeInvite('tok-xyz', WS, deps(impl));
    expect(calls[0]?.init.method).toBe('DELETE');
    expect(calls[0]?.url).toBe(`${BASE}/api/v1/workspace/${WS}/invites/tok-xyz`);
  });
});
