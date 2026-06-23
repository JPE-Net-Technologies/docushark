import { describe, it, expect, beforeEach } from 'vitest';
import { useCloudSignInStore, openCloudSignIn } from './cloudSignInStore';

describe('cloudSignInStore', () => {
  beforeEach(() => {
    useCloudSignInStore.setState({ isOpen: false });
  });

  it('starts closed', () => {
    expect(useCloudSignInStore.getState().isOpen).toBe(false);
  });

  it('open() opens, close() closes', () => {
    useCloudSignInStore.getState().open();
    expect(useCloudSignInStore.getState().isOpen).toBe(true);
    useCloudSignInStore.getState().close();
    expect(useCloudSignInStore.getState().isOpen).toBe(false);
  });

  it('openCloudSignIn() helper opens the modal', () => {
    openCloudSignIn();
    expect(useCloudSignInStore.getState().isOpen).toBe(true);
  });
});
