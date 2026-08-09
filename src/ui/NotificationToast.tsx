/**
 * Notification Toast Component
 *
 * Displays toast notifications from the notification store.
 *
 * Phase 14.9.2 — Error Handling & Resilience.
 * JP-479: the drafting-card treatment. A toast arrives like a plate set on a
 * table — one settle-pulse of its severity colour, then it rests: translucent
 * over the app surface, ruled with the same grid the canvas is ruled with.
 * Severity lives on a spine at the leading edge rather than tinting the whole
 * card, which is what lets the surface actually match the surface behind it.
 */

import { useCallback } from 'react';
import { Info, CircleCheck, TriangleAlert, CircleX, X } from 'lucide-react';
import { useNotificationStore, type Notification } from '../store/notificationStore';
import { Icon } from './icons';
import './NotificationToast.css';

const SEVERITY_ICON = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  error: CircleX,
} as const;

/** Single toast notification */
function Toast({ notification }: { notification: Notification }) {
  const dismiss = useNotificationStore((state) => state.dismiss);

  const handleDismiss = () => {
    dismiss(notification.id);
  };

  const handleAction = () => {
    if (notification.onAction) {
      notification.onAction();
    }
    dismiss(notification.id);
  };

  const SeverityIcon = SEVERITY_ICON[notification.severity];

  return (
    <div
      className={`notification-toast notification-toast--${notification.severity}`}
      role="alert"
      aria-live={notification.severity === 'error' ? 'assertive' : 'polite'}
    >
      {/* Severity spine — the whole colour signal, so the card body can stay
          the app's own surface. Decorative: the icon and role="alert" already
          carry the meaning for assistive tech. */}
      <span className="notification-toast__spine" aria-hidden="true" />

      <div className="notification-toast__icon">
        <Icon icon={SeverityIcon} size={20} />
      </div>

      <div className="notification-toast__content">
        {notification.title && (
          <p className="notification-toast__title">{notification.title}</p>
        )}
        <p
          className={`notification-toast__message${
            notification.title ? ' notification-toast__message--secondary' : ''
          }`}
        >
          {notification.message}
        </p>
        {notification.progress && notification.progress.total > 0 && (
          <div
            className="notification-toast__progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={notification.progress.total}
            aria-valuenow={Math.min(notification.progress.current, notification.progress.total)}
          >
            <div
              className="notification-toast__progress-fill"
              style={{
                width: `${Math.min(
                  100,
                  Math.round((notification.progress.current / notification.progress.total) * 100),
                )}%`,
              }}
            />
          </div>
        )}
        {notification.category === 'transient' && (
          <span className="notification-toast__hint">This may be temporary</span>
        )}
      </div>

      <div className="notification-toast__actions">
        {notification.actionLabel && notification.onAction && (
          <button
            className="notification-toast__action-btn"
            onClick={handleAction}
            type="button"
          >
            {notification.actionLabel}
          </button>
        )}
        <button
          className="notification-toast__dismiss-btn"
          onClick={handleDismiss}
          type="button"
          aria-label="Dismiss notification"
        >
          <Icon icon={X} size={16} />
        </button>
      </div>
    </div>
  );
}

/** Notification container - renders all active toasts */
export function NotificationToast() {
  const notifications = useNotificationStore((state) => state.notifications);
  const pauseDismiss = useNotificationStore((state) => state.pauseDismiss);
  const resumeDismiss = useNotificationStore((state) => state.resumeDismiss);

  // Hovering (or tabbing into) the stack holds EVERY countdown, not just the
  // one under the pointer (JP-479). Pausing only the hovered toast would let
  // its neighbours expire underneath it, collapsing the stack and sliding the
  // toast you were reading — or its action button — out from under the cursor.
  const pauseAll = useCallback(() => {
    for (const n of notifications) pauseDismiss(n.id);
  }, [notifications, pauseDismiss]);

  const resumeAll = useCallback(() => {
    for (const n of notifications) resumeDismiss(n.id);
  }, [notifications, resumeDismiss]);

  if (notifications.length === 0) {
    return null;
  }

  return (
    <div
      className="notification-container"
      aria-label="Notifications"
      onMouseEnter={pauseAll}
      onMouseLeave={resumeAll}
      onFocusCapture={pauseAll}
      onBlurCapture={resumeAll}
    >
      {notifications.map((notification) => (
        <Toast key={notification.id} notification={notification} />
      ))}
    </div>
  );
}

// Toast severity + dismiss icons now come from lucide (see imports).
