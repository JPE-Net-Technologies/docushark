/**
 * Notification Store
 *
 * Centralized notification system for user-facing messages.
 * Supports toast notifications with different severity levels.
 *
 * Phase 14.9.2 - Error Handling & Resilience
 */

import { create } from 'zustand';

// ============ Types ============

/** Notification severity levels */
export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error';

/** Whether the error is transient (retry-able) or permanent */
export type NotificationCategory = 'transient' | 'permanent' | 'info';

/** A notification message */
export interface Notification {
  /** Unique ID */
  id: string;
  /**
   * Optional short headline above the message (JP-479).
   *
   * Deliberately optional: every existing caller passes a message only, and a
   * titled toast is a different shape — a headline you can scan plus a sentence
   * you can read. Adding one where the message is already a single short
   * sentence would just say the same thing twice, so most toasts shouldn't
   * have one.
   */
  title?: string;
  /** Message to display */
  message: string;
  /** Severity level */
  severity: NotificationSeverity;
  /** Category for error handling hints */
  category: NotificationCategory;
  /** Optional action button label */
  actionLabel?: string;
  /** Optional action callback */
  onAction?: () => void;
  /** Auto-dismiss duration in ms (0 = manual dismiss only) */
  duration: number;
  /** Determinate progress (renders a progress bar when present). */
  progress?: { current: number; total: number };
  /** Timestamp when created */
  createdAt: number;
}

/** Notification creation options */
export interface NotificationOptions {
  /** Optional short headline above the message (JP-479). */
  title?: string;
  /** Message to display */
  message: string;
  /** Severity level (default: 'info') */
  severity?: NotificationSeverity;
  /** Category (default: 'info') */
  category?: NotificationCategory;
  /** Optional action button label */
  actionLabel?: string;
  /** Optional action callback */
  onAction?: () => void;
  /** Auto-dismiss duration in ms (default: 5000, 0 = manual) */
  duration?: number;
  /** Determinate progress (renders a progress bar when present). */
  progress?: { current: number; total: number };
}

// ============ Store ============

interface NotificationState {
  /** Active notifications */
  notifications: Notification[];
  /** Maximum notifications to show (oldest auto-dismissed) */
  maxNotifications: number;

  /** Add a notification */
  notify: (options: NotificationOptions) => string;

  /** Convenience methods */
  info: (message: string, options?: Partial<NotificationOptions>) => string;
  success: (message: string, options?: Partial<NotificationOptions>) => string;
  warning: (message: string, options?: Partial<NotificationOptions>) => string;
  error: (message: string, options?: Partial<NotificationOptions>) => string;

  /**
   * Update an existing notification's message/severity in place (no-op if the
   * id is gone). Used for live progress toasts — e.g. a long-running import
   * ticking its count up — so we update one toast instead of spamming new
   * ones. Does not change the auto-dismiss timer.
   */
  update: (
    id: string,
    changes: Partial<Pick<Notification, 'title' | 'message' | 'severity' | 'progress'>>,
  ) => void;

  /**
   * Hold a toast's auto-dismiss countdown where it is (JP-479).
   *
   * Called while the pointer is over the toast stack: a timer that keeps
   * running while you're reading is a timer that deletes the thing you're
   * reading, and on a toast carrying an action button it can retract the button
   * out from under the cursor. Idempotent, and a no-op for a toast with no
   * countdown (`duration: 0`) or one already paused.
   */
  pauseDismiss: (id: string) => void;

  /** Resume a paused countdown from wherever it stopped. */
  resumeDismiss: (id: string) => void;

  /** Dismiss a notification by ID */
  dismiss: (id: string) => void;

  /** Dismiss all notifications */
  dismissAll: () => void;
}

/** Generate unique notification ID */
const generateId = (): string => {
  return `notif-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
};

/**
 * Live auto-dismiss countdowns, keyed by notification id (JP-479).
 *
 * Held outside the store: they're host timers, not rendered state, and putting
 * them in the store would re-render every toast each time one is paused. A
 * timer is removed the moment its notification leaves, so an evicted or
 * hand-dismissed toast can't fire a stale dismissal later.
 */
interface DismissTimer {
  handle: ReturnType<typeof setTimeout>;
  /** Wall-clock ms when the current run began. */
  startedAt: number;
  /** Ms left to run when this run began. */
  remaining: number;
}

const timers = new Map<string, DismissTimer>();

function armTimer(id: string, ms: number, onFire: (id: string) => void): void {
  timers.set(id, {
    handle: setTimeout(() => {
      timers.delete(id);
      onFire(id);
    }, ms),
    startedAt: Date.now(),
    remaining: ms,
  });
}

function clearTimer(id: string): void {
  const timer = timers.get(id);
  if (!timer) return;
  clearTimeout(timer.handle);
  timers.delete(id);
}

/** Paused countdowns, keyed by id → ms still owed. */
const paused = new Map<string, number>();

/**
 * Default durations by severity. Bumped (JP-237) so toasts linger long enough to
 * read/act on (~10–15s) rather than flashing past; callers can still override per
 * toast, and a `duration: 0` toast (e.g. the reconnecting toast) never auto-dismisses.
 */
const DEFAULT_DURATIONS: Record<NotificationSeverity, number> = {
  info: 10000,
  success: 6000,
  warning: 15000,
  error: 12000,
};

export const useNotificationStore = create<NotificationState>((set, get) => ({
  notifications: [],
  maxNotifications: 5,

  notify: (options) => {
    const id = generateId();
    const severity = options.severity ?? 'info';
    const notification: Notification = {
      id,
      message: options.message,
      severity,
      category: options.category ?? 'info',
      duration: options.duration ?? DEFAULT_DURATIONS[severity],
      createdAt: Date.now(),
      ...(options.title !== undefined ? { title: options.title } : {}),
      ...(options.actionLabel !== undefined ? { actionLabel: options.actionLabel } : {}),
      ...(options.onAction !== undefined ? { onAction: options.onAction } : {}),
      ...(options.progress !== undefined ? { progress: options.progress } : {}),
    };

    set((state) => {
      let notifications = [...state.notifications, notification];

      // Enforce max notifications limit
      if (notifications.length > state.maxNotifications) {
        const evicted = notifications.slice(0, notifications.length - state.maxNotifications);
        // Drop the evicted toasts' countdowns with them — otherwise a timer
        // outlives the toast it belonged to and fires into an empty id.
        for (const gone of evicted) {
          clearTimer(gone.id);
          paused.delete(gone.id);
        }
        notifications = notifications.slice(-state.maxNotifications);
      }

      return { notifications };
    });

    // Auto-dismiss if duration > 0
    if (notification.duration > 0) {
      armTimer(id, notification.duration, (expired) => get().dismiss(expired));
    }

    return id;
  },

  info: (message, options = {}) => {
    return get().notify({ ...options, message, severity: 'info', category: 'info' });
  },

  success: (message, options = {}) => {
    return get().notify({ ...options, message, severity: 'success', category: 'info' });
  },

  warning: (message, options = {}) => {
    return get().notify({
      ...options,
      message,
      severity: 'warning',
      category: options.category ?? 'transient',
    });
  },

  error: (message, options = {}) => {
    return get().notify({
      ...options,
      message,
      severity: 'error',
      category: options.category ?? 'permanent',
    });
  },

  update: (id, changes) => {
    set((state) => ({
      notifications: state.notifications.map((n) => (n.id === id ? { ...n, ...changes } : n)),
    }));
  },

  pauseDismiss: (id) => {
    const timer = timers.get(id);
    // No timer means either no countdown (duration 0) or already paused.
    if (!timer) return;
    clearTimeout(timer.handle);
    timers.delete(id);
    const elapsed = Date.now() - timer.startedAt;
    // Floor at a beat rather than 0: a toast whose countdown expired under the
    // cursor should still get a moment on screen after the pointer leaves,
    // instead of vanishing the instant it moves away.
    paused.set(id, Math.max(400, timer.remaining - elapsed));
  },

  resumeDismiss: (id) => {
    const remaining = paused.get(id);
    if (remaining === undefined) return;
    paused.delete(id);
    // The toast may have been dismissed while paused; don't resurrect a timer
    // for something that's gone.
    if (!get().notifications.some((n) => n.id === id)) return;
    armTimer(id, remaining, (expired) => get().dismiss(expired));
  },

  dismiss: (id) => {
    clearTimer(id);
    paused.delete(id);
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    }));
  },

  dismissAll: () => {
    for (const id of [...timers.keys()]) clearTimer(id);
    paused.clear();
    set({ notifications: [] });
  },
}));

// ============ Utility Functions ============

/**
 * Notify about an error with appropriate severity and category.
 * Distinguishes between network/transient errors and permanent failures.
 */
export function notifyError(error: unknown, context?: string): string {
  const store = useNotificationStore.getState();

  // Determine if error is transient (network, timeout) or permanent
  const isTransient = isTransientError(error);
  const category: NotificationCategory = isTransient ? 'transient' : 'permanent';

  // Build message
  let message = context ? `${context}: ` : '';
  if (error instanceof Error) {
    message += error.message;
  } else if (typeof error === 'string') {
    message += error;
  } else {
    message += 'An unexpected error occurred';
  }

  return store.error(message, {
    category,
    ...(isTransient ? { actionLabel: 'Retry' } : {}),
  });
}

/**
 * Check if an error is likely transient (retry-able).
 */
function isTransientError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    const transientPatterns = [
      'network',
      'timeout',
      'connection',
      'econnrefused',
      'enotfound',
      'socket',
      'abort',
      'offline',
      'unavailable',
      'too many requests',
      '429',
      '502',
      '503',
      '504',
    ];
    return transientPatterns.some((pattern) => message.includes(pattern));
  }
  return false;
}
