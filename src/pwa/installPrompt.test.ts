/**
 * Tests for the PWA install hint (src/pwa/installPrompt.ts).
 *
 * Verifies the one-time toast surfaces only when the browser reports the app as
 * installable, is suppressed once seen / when already installed standalone, and
 * that its action fires the browser's native install prompt.
 */

import { initInstallPrompt } from './installPrompt';
import { useNotificationStore } from '../store/notificationStore';
import { useUIPreferencesStore } from '../store/uiPreferencesStore';

interface FakePromptEvent extends Event {
  prompt: ReturnType<typeof vi.fn>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

/** Dispatch a fake `beforeinstallprompt` and return the event (with its spy). */
function fireBeforeInstallPrompt(outcome: 'accepted' | 'dismissed' = 'accepted'): FakePromptEvent {
  const event = new Event('beforeinstallprompt') as FakePromptEvent;
  event.prompt = vi.fn().mockResolvedValue(undefined);
  event.userChoice = Promise.resolve({ outcome, platform: 'web' });
  window.dispatchEvent(event);
  return event;
}

/** Toggle the legacy iOS standalone flag (matchMedia is stubbed always-false). */
function setStandalone(value: boolean): void {
  Object.defineProperty(window.navigator, 'standalone', { value, configurable: true });
}

describe('installPrompt', () => {
  let dispose: () => void;

  beforeEach(() => {
    useNotificationStore.getState().dismissAll();
    useUIPreferencesStore.setState({ installAppHintSeen: false });
    setStandalone(false);
    dispose = initInstallPrompt();
  });

  afterEach(() => {
    dispose();
    setStandalone(false);
  });

  it('surfaces a one-time Install toast when the browser reports installable', () => {
    fireBeforeInstallPrompt();

    const notes = useNotificationStore.getState().notifications;
    expect(notes).toHaveLength(1);
    expect(notes[0]?.actionLabel).toBe('Install');
    expect(notes[0]?.message).toContain('Install DocuShark');
    expect(notes[0]?.duration).toBe(0); // manual dismiss only
    // Marked seen so it won't nag again.
    expect(useUIPreferencesStore.getState().installAppHintSeen).toBe(true);
  });

  it('does not re-show after it has been seen', () => {
    useUIPreferencesStore.setState({ installAppHintSeen: true });
    fireBeforeInstallPrompt();
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });

  it('does not show when already running as an installed standalone PWA', () => {
    setStandalone(true);
    fireBeforeInstallPrompt();
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
    // Not marked seen — the user never saw a hint.
    expect(useUIPreferencesStore.getState().installAppHintSeen).toBe(false);
  });

  it('suppresses repeat prompts within a session', () => {
    fireBeforeInstallPrompt();
    fireBeforeInstallPrompt();
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
  });

  it('fires the native prompt when the Install action is invoked', async () => {
    const event = fireBeforeInstallPrompt();
    const note = useNotificationStore.getState().notifications[0];
    expect(note?.onAction).toBeTypeOf('function');

    note?.onAction?.();
    // onAction kicks off promptInstall() asynchronously.
    await Promise.resolve();
    await Promise.resolve();

    expect(event.prompt).toHaveBeenCalledTimes(1);
  });
});
