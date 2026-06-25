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
