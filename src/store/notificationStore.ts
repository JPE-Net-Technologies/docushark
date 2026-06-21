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
  /** Timestamp when created */
  createdAt: number;
}

/** Notification creation options */
export interface NotificationOptions {
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
  update: (id: string, changes: Partial<Pick<Notification, 'message' | 'severity'>>) => void;

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
      ...(options.actionLabel !== undefined ? { actionLabel: options.actionLabel } : {}),
      ...(options.onAction !== undefined ? { onAction: options.onAction } : {}),
    };

    set((state) => {
      let notifications = [...state.notifications, notification];

      // Enforce max notifications limit
      if (notifications.length > state.maxNotifications) {
        notifications = notifications.slice(-state.maxNotifications);
      }

      return { notifications };
    });

    // Auto-dismiss if duration > 0
    if (notification.duration > 0) {
      setTimeout(() => {
        get().dismiss(id);
      }, notification.duration);
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

  dismiss: (id) => {
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    }));
  },

  dismissAll: () => {
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
