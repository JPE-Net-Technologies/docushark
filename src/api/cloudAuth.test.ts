import { describe, it, expect, vi } from 'vitest';
import { beginCloudSignIn, DEVICE_CLIENT_ID, DEVICE_GRANT_TYPE } from './cloudAuth';

/** Minimal Response stub — cloudAuth only touches `ok`, `status`, `json()`. */
function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const CODE_BODY = {
  device_code: 'DEV-CODE',
  user_code: 'WXYZ-1234',
  verification_uri: 'http://web/auth/device',
  verification_uri_complete: 'http://web/auth/device?user_code=WXYZ-1234',
  interval: 5,
  expires_in: 900,
};

const noopSleep = (): Promise<void> => Promise.resolve();

interface MockOpts {
  code?: Response;
  tokenQueue: Response[];
}

function mockFetch({ code = jsonRes(CODE_BODY), tokenQueue }: MockOpts) {
  const calls: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];
  let tokenIdx = 0;
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    calls.push({ url: u, body });
    if (u.endsWith('/api/v1/auth/device/code')) return code;
    if (u.endsWith('/api/v1/auth/device/token')) {
      const res = tokenQueue[Math.min(tokenIdx, tokenQueue.length - 1)]!;
      tokenIdx += 1;
      return res;
    }
    throw new Error(`unexpected url ${u}`);
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    calls,
    tokenCallCount: () => tokenIdx,
  };
}

describe('beginCloudSignIn', () => {
  it('issues a code, opens the browser, and resolves once approved', async () => {
    const { fetchImpl, calls } = mockFetch({
      tokenQueue: [
        jsonRes({ error: 'authorization_pending' }, 400),
        jsonRes({ token: 'RELAY.JWT', jti: 'j1', expires_at: 1000, token_type: 'Bearer' }),
      ],
    });
    const openExternal = vi.fn(async () => {});

    const handle = await beginCloudSignIn('http://web', {
      fetchImpl,
      openExternal,
      sleep: noopSleep,
    });

    expect(handle.userCode).toBe('WXYZ-1234');
    expect(openExternal).toHaveBeenCalledWith('http://web/auth/device?user_code=WXYZ-1234');

    const result = await handle.result;
    // expires_at is epoch seconds on the wire → ms in the result.
    expect(result).toEqual({ token: 'RELAY.JWT', expiresAt: 1000 * 1000 });

    const tokenCall = calls.find((c) => c.url.endsWith('/token'));
    expect(tokenCall?.body).toMatchObject({
      grant_type: DEVICE_GRANT_TYPE,
      device_code: 'DEV-CODE',
      client_id: DEVICE_CLIENT_ID,
    });
  });

  it('surfaces the region-resolved relay_url (and workspace identity) when present', async () => {
    const { fetchImpl } = mockFetch({
      tokenQueue: [
        jsonRes({
          token: 'RELAY.JWT',
          jti: 'j1',
          expires_at: 1000,
          token_type: 'Bearer',
          relay_url: 'https://relay.example.com',
          workspace_name: 'Acme',
          workspace_slug: 'acme',
        }),
      ],
    });

    const handle = await beginCloudSignIn('http://web', {
      fetchImpl,
      openExternal: async () => {},
      sleep: noopSleep,
    });

    const result = await handle.result;
    expect(result).toEqual({
      token: 'RELAY.JWT',
      expiresAt: 1000 * 1000,
      relayUrl: 'https://relay.example.com',
      workspaceName: 'Acme',
      workspaceSlug: 'acme',
    });
  });

  it('omits relayUrl when the response has none (older relay)', async () => {
    const { fetchImpl } = mockFetch({
      tokenQueue: [
        jsonRes({ token: 'T', jti: 'j', expires_at: 5, token_type: 'Bearer' }),
      ],
    });

    const handle = await beginCloudSignIn('http://web', {
      fetchImpl,
      openExternal: async () => {},
      sleep: noopSleep,
    });

    const result = await handle.result;
    expect(result).toEqual({ token: 'T', expiresAt: 5000 });
    expect('relayUrl' in result).toBe(false);
  });

  it('keeps polling through slow_down and still resolves', async () => {
    const { fetchImpl, tokenCallCount } = mockFetch({
      tokenQueue: [
        jsonRes({ error: 'slow_down' }, 400),
        jsonRes({ token: 'T', jti: 'j', expires_at: 5, token_type: 'Bearer' }),
      ],
    });

    const handle = await beginCloudSignIn('http://web', {
      fetchImpl,
      openExternal: async () => {},
      sleep: noopSleep,
    });

    const result = await handle.result;
    expect(result).toEqual({ token: 'T', expiresAt: 5000 });
    expect(tokenCallCount()).toBe(2);
  });

  it('rejects with access_denied when the user denies', async () => {
    const { fetchImpl } = mockFetch({
      tokenQueue: [jsonRes({ error: 'access_denied' }, 400)],
    });

    const handle = await beginCloudSignIn('http://web', {
      fetchImpl,
      openExternal: async () => {},
      sleep: noopSleep,
    });

    await expect(handle.result).rejects.toMatchObject({
      name: 'CloudAuthError',
      code: 'access_denied',
    });
  });

  it('rejects with expired_token when the relay reports the code expired', async () => {
    const { fetchImpl } = mockFetch({
      tokenQueue: [jsonRes({ error: 'expired_token' }, 400)],
    });

    const handle = await beginCloudSignIn('http://web', {
      fetchImpl,
      openExternal: async () => {},
      sleep: noopSleep,
    });

    await expect(handle.result).rejects.toMatchObject({ code: 'expired_token' });
  });

  it('enforces the local deadline (expires_in) without polling', async () => {
    const { fetchImpl, tokenCallCount } = mockFetch({
      code: jsonRes({ ...CODE_BODY, expires_in: 0 }),
      tokenQueue: [jsonRes({ token: 'unused', jti: 'x', expires_at: 1, token_type: 'Bearer' })],
    });

    const handle = await beginCloudSignIn('http://web', {
      fetchImpl,
      openExternal: async () => {},
      sleep: noopSleep,
      now: () => 1_000,
    });

    await expect(handle.result).rejects.toMatchObject({ code: 'expired_token' });
    expect(tokenCallCount()).toBe(0);
  });

  it('cancel() stops polling and rejects with cancelled', async () => {
    const { fetchImpl, tokenCallCount } = mockFetch({
      tokenQueue: [jsonRes({ error: 'authorization_pending' }, 400)],
    });

    // Gate the (initial) sleep so we can cancel before the first poll.
    let releaseSleep: () => void = () => {};
    const gatedSleep = (): Promise<void> =>
      new Promise((resolve) => {
        releaseSleep = () => resolve();
      });

    const handle = await beginCloudSignIn('http://web', {
      fetchImpl,
      openExternal: async () => {},
      sleep: gatedSleep,
    });

    handle.cancel();
    releaseSleep();

    await expect(handle.result).rejects.toMatchObject({ code: 'cancelled' });
    expect(tokenCallCount()).toBe(0);
  });

  it('rejects if the code endpoint fails', async () => {
    const fetchImpl = (async () =>
      jsonRes({ error: 'device_code_persist_failed' }, 500)) as unknown as typeof fetch;

    await expect(
      beginCloudSignIn('http://web', {
        fetchImpl,
        openExternal: async () => {},
        sleep: noopSleep,
      }),
    ).rejects.toMatchObject({ name: 'CloudAuthError', code: 'device_code_persist_failed' });
  });
});
