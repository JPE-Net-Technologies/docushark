import { describe, it, expect, beforeEach } from 'vitest';
import { useUploadStatusStore } from './uploadStatusStore';

describe('uploadStatusStore', () => {
  beforeEach(() => useUploadStatusStore.getState().clear());

  it('report sets active state from a progress event', () => {
    useUploadStatusStore.getState().report({ phase: 'uploading', current: 2, total: 5 });
    expect(useUploadStatusStore.getState()).toMatchObject({
      active: true,
      phase: 'uploading',
      current: 2,
      total: 5,
    });
  });

  it('clear resets to idle', () => {
    useUploadStatusStore.getState().report({ phase: 'uploading', current: 1, total: 3 });
    useUploadStatusStore.getState().clear();
    expect(useUploadStatusStore.getState()).toMatchObject({
      active: false,
      phase: null,
      current: 0,
      total: 0,
    });
  });
});
