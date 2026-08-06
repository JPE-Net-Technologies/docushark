/**
 * JP-301 — the storage meter's share breakdown (editor side).
 *
 * The counterpart to `docushark-web`'s test of the same rule on the account
 * portal. Both surfaces render the same three shares from the same relay
 * response, and both have to obey the same constraint: only draw the stacked
 * bar when its segments genuinely add up to the headline number printed beside
 * them. Relays roll out independently of either client, so a partial set of
 * shares is a normal state — and a bar that visibly falls short of its own
 * label reads as a broken meter rather than as missing data.
 *
 * Tested on both sides deliberately: the logic can't be shared across the
 * AGPL/proprietary boundary, so the only thing keeping the two copies honest is
 * that each is pinned to the same behaviour.
 */

import { describe, it, expect } from 'vitest';
import { resolveShares } from './DocumentsHome';
import type { RelayUsage } from '../../api/relayClient';

const base = { storageQuota: 1_000_000, activeEditors: 0, editorLimit: null };

function usage(over: Partial<RelayUsage> & { storageBytes: number }): RelayUsage {
  return { ...base, ...over };
}

describe('resolveShares', () => {
  it('returns the three shares when they sum to the total', () => {
    expect(
      resolveShares(usage({ storageBytes: 600, docBytes: 400, blobBytes: 150, configBytes: 50 })),
    ).toEqual({ docBytes: 400, blobBytes: 150, configBytes: 50 });
  });

  it('treats a missing configBytes as zero — a pre-JP-301 relay still splits', () => {
    // Documents and files predate configuration, so a relay reporting only
    // those two is consistent rather than broken: config really is zero there.
    expect(resolveShares(usage({ storageBytes: 550, docBytes: 400, blobBytes: 150 }))).toEqual({
      docBytes: 400,
      blobBytes: 150,
      configBytes: 0,
    });
  });

  it('refuses to split when the shares fall short of the total', () => {
    // The regression this guards: config lands in `storageBytes` on the relay
    // while a client still sums only two shares, drawing a bar that stops short
    // of its own "X / Y" label.
    expect(resolveShares(usage({ storageBytes: 600, docBytes: 400, blobBytes: 150 }))).toBeNull();
  });

  it('refuses to split when the shares exceed the total', () => {
    expect(
      resolveShares(usage({ storageBytes: 100, docBytes: 400, blobBytes: 150, configBytes: 50 })),
    ).toBeNull();
  });

  it('refuses to split on a pre-JP-443 relay that reports no shares at all', () => {
    expect(resolveShares(usage({ storageBytes: 600 }))).toBeNull();
  });

  it('handles an empty workspace', () => {
    expect(
      resolveShares(usage({ storageBytes: 0, docBytes: 0, blobBytes: 0, configBytes: 0 })),
    ).toEqual({ docBytes: 0, blobBytes: 0, configBytes: 0 });
  });

  it('returns null when there is no usage yet', () => {
    expect(resolveShares(null)).toBeNull();
  });
});
