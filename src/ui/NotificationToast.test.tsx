import { beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { NotificationToast } from './NotificationToast';
import { useNotificationStore } from '../store/notificationStore';

describe('NotificationToast', () => {
  beforeEach(() => {
    act(() => useNotificationStore.getState().dismissAll());
  });

  afterEach(() => {
    // Unmount before clearing the store: draining notifications while a toast
    // is still mounted is a state update outside act(), which React reports as
    // a warning on every test in the file.
    cleanup();
    act(() => useNotificationStore.getState().dismissAll());
  });

  it('renders nothing when there are no notifications', () => {
    const { container } = render(<NotificationToast />);
    expect(container.querySelector('.notification-container')).toBeNull();
  });

  it('renders one toast per notification, tagged with its severity', () => {
    act(() => {
      useNotificationStore.getState().info('one', { duration: 0 });
      useNotificationStore.getState().error('two', { duration: 0 });
    });
    const { container } = render(<NotificationToast />);
    expect(container.querySelectorAll('.notification-toast')).toHaveLength(2);
    expect(container.querySelector('.notification-toast--info')).not.toBeNull();
    expect(container.querySelector('.notification-toast--error')).not.toBeNull();
  });

  it('gives every toast a severity spine', () => {
    act(() => {
      useNotificationStore.getState().warning('careful', { duration: 0 });
    });
    const { container } = render(<NotificationToast />);
    expect(container.querySelector('.notification-toast__spine')).not.toBeNull();
  });

  it('renders a title when one is supplied, and steps the message back', () => {
    act(() => {
      useNotificationStore.getState().notify({
        title: 'Import finished',
        message: '12 pages added.',
        severity: 'success',
        duration: 0,
      });
    });
    const { container } = render(<NotificationToast />);
    expect(screen.getByText('Import finished')).toBeTruthy();
    expect(container.querySelector('.notification-toast__message--secondary')).not.toBeNull();
  });

  it('renders no title element when none is supplied', () => {
    // The path every existing caller takes — the toast must look like it always
    // did, not sprout an empty headline.
    act(() => {
      useNotificationStore.getState().success('Saved', { duration: 0 });
    });
    const { container } = render(<NotificationToast />);
    expect(container.querySelector('.notification-toast__title')).toBeNull();
    expect(container.querySelector('.notification-toast__message--secondary')).toBeNull();
    expect(screen.getByText('Saved')).toBeTruthy();
  });

  it('renders exactly the hooks the stylesheet targets', () => {
    // The CSS was verified against hand-built markup in a real browser (the MCP
    // console evaluates in an isolated world, so the live store can't be driven
    // from it, and every real toast trigger in the app mutates a document).
    // This pins the other half of that: if a class name here drifts, the
    // treatment silently stops applying and nothing else would catch it.
    act(() => {
      useNotificationStore.getState().notify({
        title: 'Titled',
        message: 'Body',
        severity: 'warning',
        category: 'transient',
        duration: 0,
        actionLabel: 'Retry',
        onAction: () => {},
        progress: { current: 1, total: 4 },
      });
    });
    const { container } = render(<NotificationToast />);
    for (const selector of [
      '.notification-container',
      '.notification-toast',
      '.notification-toast--warning',
      '.notification-toast__spine',
      '.notification-toast__icon',
      '.notification-toast__content',
      '.notification-toast__title',
      '.notification-toast__message--secondary',
      '.notification-toast__hint',
      '.notification-toast__actions',
      '.notification-toast__action-btn',
      '.notification-toast__dismiss-btn',
      '.notification-toast__progress',
      '.notification-toast__progress-fill',
    ]) {
      expect(container.querySelector(selector), selector).not.toBeNull();
    }
  });

  it('escalates aria-live for errors only', () => {
    act(() => {
      useNotificationStore.getState().error('broke', { duration: 0 });
      useNotificationStore.getState().info('fyi', { duration: 0 });
    });
    const { container } = render(<NotificationToast />);
    expect(
      container.querySelector('.notification-toast--error')?.getAttribute('aria-live'),
    ).toBe('assertive');
    expect(
      container.querySelector('.notification-toast--info')?.getAttribute('aria-live'),
    ).toBe('polite');
  });

  it('dismisses when the dismiss button is pressed', () => {
    act(() => {
      useNotificationStore.getState().info('bye', { duration: 0 });
    });
    render(<NotificationToast />);
    fireEvent.click(screen.getByLabelText('Dismiss notification'));
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });

  it('runs the action and dismisses in one press', () => {
    const onAction = vi.fn();
    act(() => {
      useNotificationStore
        .getState()
        .error('failed', { duration: 0, actionLabel: 'Retry', onAction });
    });
    render(<NotificationToast />);
    fireEvent.click(screen.getByText('Retry'));
    expect(onAction).toHaveBeenCalledOnce();
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });

  describe('hover holds the countdown', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('pauses every toast in the stack, not just the hovered one', () => {
      // Pausing only the hovered toast would let its neighbours expire
      // underneath it, sliding the one being read out from under the cursor.
      act(() => {
        useNotificationStore.getState().info('first', { duration: 1000 });
        useNotificationStore.getState().info('second', { duration: 1000 });
      });
      const { container } = render(<NotificationToast />);
      const stack = container.querySelector('.notification-container')!;

      fireEvent.mouseEnter(stack);
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(useNotificationStore.getState().notifications).toHaveLength(2);

      fireEvent.mouseLeave(stack);
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
    });

    it('also holds while focus is inside the stack, for keyboard users', () => {
      act(() => {
        useNotificationStore.getState().info('focus me', { duration: 1000 });
      });
      const { container } = render(<NotificationToast />);
      const stack = container.querySelector('.notification-container')!;

      fireEvent.focus(screen.getByLabelText('Dismiss notification'));
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(useNotificationStore.getState().notifications).toHaveLength(1);

      fireEvent.blur(stack);
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(useNotificationStore.getState().notifications).toHaveLength(0);
    });
  });
});
