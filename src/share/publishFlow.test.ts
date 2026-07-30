/**
 * Publish orchestration pins (JP-464). The ORDER is the contract:
 *
 * - publish: relay artifact first, control-plane row second — a mint failure
 *   must report "published but link missing", never mint before the artifact
 *   exists (a link that 404s for readers);
 * - unpublish: row revoke first (the URL dies), relay delete second and
 *   best-effort (stale metered bytes are recoverable; a live URL after
 *   "turn off" is not).
 *
 * Failure mapping renders the SERVER's numbers (413 body) — no client copy
 * of the cap exists to drift.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  publishDocument,
  unpublishDocument,
  shareUrlFor,
  repointShareLink,
  stashPendingRepoint,
  readPendingRepoint,
  clearPendingRepoint,
} from './publishFlow';
import { RelayError } from '../api/relayClient';
import { WebClientError } from '../api/webClient';

const calls: string[] = [];

const provider: Record<string, unknown> = {};
vi.mock('../store/relayDocumentStore', () => ({
  getDocProvider: () => provider,
}));
vi.mock('../store/autoSaveGuard', () => ({
  flushAutoSaveNow: () => calls.push('flush'),
}));

const webMock = {
  mintShareLink: vi.fn(),
  revokeShareLink: vi.fn(),
};
vi.mock('../api/webClient', async (importOriginal) => {
  const original = await importOriginal<typeof import('../api/webClient')>();
  return {
    ...original,
    webClient: new Proxy(original.webClient, {
      get(target, prop: string) {
        if (prop in webMock) {
          return (...args: unknown[]) => {
            calls.push(prop);
            return (webMock as Record<string, ReturnType<typeof vi.fn>>)[prop]!(...args);
          };
        }
        return (target as Record<string, unknown>)[prop];
      },
    }),
  };
});

const ACK = {
  success: true,
  artifactKey: 'docs/ws/public/d1.json',
  manifestKey: 'docs/ws/public/d1.manifest.json',
  bytes: 1234,
  publishedAt: 1000,
};
const LINK = {
  token: 'A'.repeat(43),
  createdBy: 'u1',
  createdAt: 'now',
  publishedAt: 'now',
  revokedAt: null,
  viewCount: 0,
};

beforeEach(() => {
  calls.length = 0;
  provider['publishDocument'] = vi.fn(async () => {
    calls.push('relay-publish');
    return ACK;
  });
  provider['unpublishDocument'] = vi.fn(async () => {
    calls.push('relay-unpublish');
    return { success: true, removed: true };
  });
  webMock.mintShareLink.mockResolvedValue(LINK);
  webMock.revokeShareLink.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('publishDocument', () => {
  it('publishes relay-first, mints second, and flushes pending edits before either', async () => {
    const outcome = await publishDocument('d1');
    expect(outcome.ok).toBe(true);
    expect(calls).toEqual(['flush', 'relay-publish', 'mintShareLink']);
    if (outcome.ok) {
      expect(outcome.link.token).toBe(LINK.token);
      expect(outcome.bytes).toBe(1234);
    }
  });

  it('a mint failure reports link-mint-failed — the artifact half succeeded', async () => {
    webMock.mintShareLink.mockRejectedValue(new Error('network sad'));
    const outcome = await publishDocument('d1');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe('link-mint-failed');
    expect(calls).toContain('relay-publish');
  });

  it('renders the RELAY’s cap numbers on a 413 — no client-side copy', async () => {
    provider['publishDocument'] = vi.fn(async () => {
      throw new RelayError(413, 'u', 'Payload Too Large', {
        errorCode: 'PUBLISH_TOO_LARGE',
        sizeBytes: 999,
        maxBytes: 600,
      });
    });
    const outcome = await publishDocument('d1');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.kind === 'too-large') {
      expect(outcome.sizeBytes).toBe(999);
      expect(outcome.maxBytes).toBe(600);
    } else {
      throw new Error(`expected too-large, got ${JSON.stringify(outcome)}`);
    }
    expect(webMock.mintShareLink).not.toHaveBeenCalled();
  });

  it('maps 507 to quota and 403 to forbidden', async () => {
    for (const [status, kind] of [
      [507, 'quota'],
      [403, 'forbidden'],
    ] as const) {
      provider['publishDocument'] = vi.fn(async () => {
        throw new RelayError(status, 'u', 'nope');
      });
      const outcome = await publishDocument('d1');
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.kind).toBe(kind);
    }
  });

  it('a keyless ack (filesystem relay) never mints a dead link', async () => {
    provider['publishDocument'] = vi.fn(async () => ({ ...ACK, artifactKey: null, manifestKey: null }));
    const outcome = await publishDocument('d1');
    expect(outcome.ok).toBe(false);
    expect(webMock.mintShareLink).not.toHaveBeenCalled();
  });
});

describe('unpublishDocument', () => {
  it('revokes the row FIRST, then the relay artifact', async () => {
    const outcome = await unpublishDocument('d1');
    expect(outcome.ok).toBe(true);
    expect(calls).toEqual(['revokeShareLink', 'relay-unpublish']);
  });

  it('a relay-delete failure still counts as unpublished — the URL is already dark', async () => {
    provider['unpublishDocument'] = vi.fn(async () => {
      throw new Error('relay down');
    });
    const outcome = await unpublishDocument('d1');
    expect(outcome.ok).toBe(true);
  });

  it('a row-revoke failure fails the action — the URL would still be live', async () => {
    webMock.revokeShareLink.mockRejectedValue(new Error('db sad'));
    const outcome = await unpublishDocument('d1');
    expect(outcome.ok).toBe(false);
  });
});

describe('shareUrlFor', () => {
  it('is same-origin with the editor by construction', () => {
    expect(shareUrlFor('tok')).toBe(`${window.location.origin}/d/tok`);
  });
});

describe('repointShareLink + pending-repoint breadcrumb (JP-470)', () => {
  const KEYS = {
    artifactKey: 'docs/ws/public/d2.json',
    manifestKey: 'docs/ws/public/d2.manifest.json',
    publishedBytes: 1234,
  };

  it('moves the row by minting on the NEW id with previousDocId attached', async () => {
    webMock.mintShareLink.mockResolvedValue(LINK);
    const out = await repointShareLink('d1', 'd2', KEYS);
    expect(out.ok).toBe(true);
    expect(webMock.mintShareLink).toHaveBeenCalledWith('d2', {
      ...KEYS,
      previousDocId: 'd1',
    });
  });

  it('forbidden is terminal (retryable: false) — only creator/owner may retarget', async () => {
    webMock.mintShareLink.mockRejectedValue(new WebClientError(403, 'forbidden'));
    const out = await repointShareLink('d1', 'd2', KEYS);
    expect(out).toMatchObject({ ok: false, retryable: false });
  });

  it('transient failures are retryable — the breadcrumb path', async () => {
    webMock.mintShareLink.mockRejectedValue(new Error('network sad'));
    const out = await repointShareLink('d1', 'd2', KEYS);
    expect(out).toMatchObject({ ok: false, retryable: true });
  });

  it('breadcrumb round-trips through storage and clears', () => {
    const payload = { previousDocId: 'd1', ...KEYS };
    stashPendingRepoint('d2', payload);
    expect(readPendingRepoint('d2')).toEqual(payload);
    clearPendingRepoint('d2');
    expect(readPendingRepoint('d2')).toBeNull();
  });

  it('malformed or incomplete breadcrumbs read as null, never throw', () => {
    localStorage.setItem('docushark:pending-repoint:d3', 'not json');
    expect(readPendingRepoint('d3')).toBeNull();
    localStorage.setItem(
      'docushark:pending-repoint:d4',
      JSON.stringify({ previousDocId: 'd1' }), // keys missing
    );
    expect(readPendingRepoint('d4')).toBeNull();
  });
});
