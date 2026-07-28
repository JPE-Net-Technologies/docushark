import { describe, it, expect } from 'vitest';
import {
  blobSyncMessage,
  integrityFailureMessage,
  BLOB_SYNC_DONE_MESSAGE,
} from './blobSyncMessages';

describe('blobSyncMessage', () => {
  it('formats upload progress as n/total', () => {
    expect(blobSyncMessage({ kind: 'upload', current: 3, total: 8 })).toBe('Syncing files 3/8');
  });

  it('clamps upload current to total', () => {
    expect(blobSyncMessage({ kind: 'upload', current: 9, total: 8 })).toBe('Syncing files 8/8');
  });

  it('pluralizes download counts', () => {
    expect(blobSyncMessage({ kind: 'download', current: 1, total: 0 })).toBe('Downloading 1 file');
    expect(blobSyncMessage({ kind: 'download', current: 4, total: 0 })).toBe('Downloading 4 files');
  });
});

describe('integrityFailureMessage', () => {
  it('pluralizes correctly', () => {
    expect(integrityFailureMessage(1)).toBe(
      '1 file failed integrity verification and was not saved',
    );
    expect(integrityFailureMessage(3)).toBe(
      '3 files failed integrity verification and were not saved',
    );
  });
});

describe('BLOB_SYNC_DONE_MESSAGE', () => {
  it('is a short completion message', () => {
    expect(BLOB_SYNC_DONE_MESSAGE.length).toBeLessThan(30);
  });
});
