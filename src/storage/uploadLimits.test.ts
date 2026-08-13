/**
 * The shared upload gate (JP-496).
 *
 * Both halves of it are load-bearing and fail differently: without the ceiling
 * `BlobStorage.computeHash` pulls the whole file into memory and OOMs the tab;
 * without the quota check the write fails late with an IndexedDB error instead
 * of an explanation. Before this gate existed, each of the six user-pick paths
 * enforced a different subset, and one (`LogoPicker`) enforced neither.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAX_UPLOAD_BYTES,
  UploadRejectedError,
  assertUploadable,
  uploadRejectionReason,
} from './uploadLimits';
import { hasSpaceForBlob } from './StorageQuotaMonitor';

vi.mock('./StorageQuotaMonitor', () => ({
  hasSpaceForBlob: vi.fn(async () => true),
}));

const mockHasSpace = vi.mocked(hasSpaceForBlob);

beforeEach(() => {
  mockHasSpace.mockClear();
  mockHasSpace.mockResolvedValue(true);
});

describe('uploadRejectionReason', () => {
  it('accepts an ordinary file', async () => {
    expect(await uploadRejectionReason({ size: 3_300_000 })).toBeNull();
  });

  it('rejects a file over the ceiling, naming the real limit', async () => {
    const reason = await uploadRejectionReason({ size: MAX_UPLOAD_BYTES + 1 });
    expect(reason).toContain('150.0 MB');
  });

  it('accepts a file exactly at the ceiling', async () => {
    // An off-by-one here would refuse a file the relay would have accepted.
    expect(await uploadRejectionReason({ size: MAX_UPLOAD_BYTES })).toBeNull();
  });

  it('checks the ceiling before consulting storage', async () => {
    // Not a micro-optimization: `hasSpaceForBlob` does a
    // `navigator.storage.estimate()` round-trip AND raises a user-facing
    // notification of its own. An oversized file must be refused for being
    // oversized, not reported as a quota problem it may not have.
    await uploadRejectionReason({ size: MAX_UPLOAD_BYTES * 10 });
    expect(mockHasSpace).not.toHaveBeenCalled();
  });

  it('rejects when there is no room, even for a small file', async () => {
    mockHasSpace.mockResolvedValue(false);
    expect(await uploadRejectionReason({ size: 1024 })).toContain('storage space');
  });
});

describe('assertUploadable', () => {
  it('resolves for an acceptable file', async () => {
    await expect(assertUploadable({ size: 1024 })).resolves.toBeUndefined();
  });

  it('throws UploadRejectedError carrying the reason', async () => {
    await expect(assertUploadable({ size: MAX_UPLOAD_BYTES + 1 })).rejects.toThrow(
      UploadRejectedError,
    );
    await expect(assertUploadable({ size: MAX_UPLOAD_BYTES + 1 })).rejects.toThrow(/150\.0 MB/);
  });
});

describe('the ceiling agrees with the relay', () => {
  it('matches DEFAULT_MAX_BLOB_BYTES in relay/src/config.rs', () => {
    // A client ceiling above the relay's means a file stores locally and then
    // 413s forever on sync — the user sees an attachment that never syncs and
    // no explanation. Read from the Rust source so the two cannot drift
    // silently; if the relay's default moves, this fails and someone decides.
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const config = readFileSync(resolve(__dirname, '../../relay/src/config.rs'), 'utf8');
    const match = /DEFAULT_MAX_BLOB_BYTES:\s*usize\s*=\s*([0-9_]+)/.exec(config);
    expect(match, 'DEFAULT_MAX_BLOB_BYTES not found in relay/src/config.rs').not.toBeNull();
    expect(Number(match![1]!.replace(/_/g, ''))).toBe(MAX_UPLOAD_BYTES);
  });
});

describe('every user-pick path uses the gate', () => {
  // The gate deliberately does NOT live inside `saveBlob`: most of that
  // function's callers move bytes that already exist and are already the
  // user's (backup restore, archive unpack, peer blob sync), and a ceiling
  // there would refuse to restore a document the app had happily created.
  //
  // The cost of that choice is that a new pick path can forget the gate — which
  // is exactly how the six paths drifted apart in the first place. This list is
  // the mitigation.
  const PICK_PATHS = [
    '../ui/proseFileUpload.ts',
    '../ui/proseImageUpload.ts',
    '../ui/GalleryUploadButton.tsx',
    '../ui/LogoPicker.tsx',
    '../services/FileImportService.ts',
    '../services/FileReplaceService.ts',
  ];

  const __dirname = dirname(fileURLToPath(import.meta.url));

  /**
   * Source with `import` lines removed.
   *
   * The first version of this guard tested the whole file for the gate's name,
   * which the *import statement* satisfies — so deleting the actual call left
   * it green. Checking the body for a call is the difference between "this file
   * mentions the gate" and "this file uses it".
   */
  function body(rel: string): string {
    return readFileSync(resolve(__dirname, rel), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*import\b/.test(line))
      .join('\n');
  }

  for (const rel of PICK_PATHS) {
    it(`${rel.split('/').pop()} gates its picked file`, () => {
      expect(
        /\b(assertUploadable|uploadRejectionReason)\s*\(/.test(body(rel)),
        `${rel} takes a user-picked file to blob storage without calling the shared gate. ` +
          `Without the ceiling, computeHash buffers the whole file and OOMs the tab; without ` +
          `the quota check the write fails late with an IndexedDB error.`,
      ).toBe(true);
    });
  }

  it('no pick path still calls hasSpaceForBlob directly', () => {
    // Half the gate is the state this slice removed. A direct call means that
    // path has the quota check and not the ceiling — which is what
    // FileImportService, FileReplaceService and proseFileUpload each had.
    const offenders = PICK_PATHS.filter((rel) =>
      readFileSync(resolve(__dirname, rel), 'utf8').includes('hasSpaceForBlob'),
    );
    expect(offenders, 'these paths use the quota check without the size ceiling').toEqual([]);
  });
});
