/**
 * Notification Toast Component
 *
 * Displays toast notifications from the notification store.
 *
 * Phase 14.9.2 - Error Handling & Resilience
 */

import { Info, CircleCheck, TriangleAlert, CircleX, X } from 'lucide-react';
import { useNotificationStore, type Notification } from '../store/notificationStore';
import { Icon } from './icons';
import './NotificationToast.css';

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

  return (
    <div
      className={`notification-toast notification-toast--${notification.severity}`}
      role="alert"
      aria-live={notification.severity === 'error' ? 'assertive' : 'polite'}
    >
      <div className="notification-toast__icon">
        {notification.severity === 'info' && <Icon icon={Info} size={20} />}
        {notification.severity === 'success' && <Icon icon={CircleCheck} size={20} />}
        {notification.severity === 'warning' && <Icon icon={TriangleAlert} size={20} />}
        {notification.severity === 'error' && <Icon icon={CircleX} size={20} />}
      </div>

      <div className="notification-toast__content">
        <p className="notification-toast__message">{notification.message}</p>
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

  if (notifications.length === 0) {
    return null;
  }

  return (
    <div className="notification-container" aria-label="Notifications">
      {notifications.map((notification) => (
        <Toast key={notification.id} notification={notification} />
      ))}
    </div>
  );
}

// Toast severity + dismiss icons now come from lucide (see imports).
