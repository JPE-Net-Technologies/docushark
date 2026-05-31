import { describe, it, expect, beforeEach } from 'vitest';
import { showStorageInfoToastOnce } from './storageInfoToast';
import { useNotificationStore } from '../store/notificationStore';
import { useUIPreferencesStore } from '../store/uiPreferencesStore';

describe('showStorageInfoToastOnce', () => {
  beforeEach(() => {
    useNotificationStore.getState().dismissAll();
    useUIPreferencesStore.setState({ storageInfoToastSeen: false });
  });

  it('shows the storage explainer the first time and marks it seen', () => {
    showStorageInfoToastOnce();
    const notifications = useNotificationStore.getState().notifications;
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.message).toContain('metered by total size');
    expect(useUIPreferencesStore.getState().storageInfoToastSeen).toBe(true);
  });

  it('does nothing on subsequent connects', () => {
    showStorageInfoToastOnce();
    useNotificationStore.getState().dismissAll();
    showStorageInfoToastOnce();
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });
});
