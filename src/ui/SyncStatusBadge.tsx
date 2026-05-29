/**
 * SyncStatusBadge component
 *
 * Visual indicator for document synchronization state.
 * Shows sync status (synced, syncing, pending, error, offline) with appropriate icons and colors.
 */

import { useMemo } from 'react';
import {
  AlertTriangle,
  Check,
  Circle,
  Clock,
  CloudOff,
  RefreshCw,
  type LucideIcon,
} from 'lucide-react';
import type { SyncState } from '../types/DocumentRegistry';
import './SyncStatusBadge.css';

export type ExtendedSyncState = SyncState | 'local' | 'offline';

interface SyncStatusBadgeProps {
  /** Sync state to display */
  state: ExtendedSyncState;
  /** Show text label next to icon */
  showLabel?: boolean;
  /** Size variant */
  size?: 'small' | 'medium';
  /** Additional CSS class */
  className?: string;
}

interface SyncStateConfig {
  Icon: LucideIcon;
  label: string;
  className: string;
  title: string;
}

const SYNC_STATE_CONFIGS: Record<ExtendedSyncState, SyncStateConfig> = {
  synced: {
    Icon: Check,
    label: 'Synced',
    className: 'sync-status--synced',
    title: 'Document is synced with the host',
  },
  syncing: {
    Icon: RefreshCw,
    label: 'Syncing',
    className: 'sync-status--syncing',
    title: 'Document is currently syncing',
  },
  pending: {
    Icon: Clock,
    label: 'Pending',
    className: 'sync-status--pending',
    title: 'Document has pending changes waiting to sync',
  },
  error: {
    Icon: AlertTriangle,
    label: 'Error',
    className: 'sync-status--error',
    title: 'Failed to sync document',
  },
  local: {
    Icon: Circle,
    label: 'Local',
    className: 'sync-status--local',
    title: 'Personal document (not synced)',
  },
  offline: {
    Icon: CloudOff,
    label: 'Offline',
    className: 'sync-status--offline',
    title: 'Cached offline - changes will sync when reconnected',
  },
};

export function SyncStatusBadge({
  state,
  showLabel = false,
  size = 'small',
  className = '',
}: SyncStatusBadgeProps) {
  const config = useMemo(() => SYNC_STATE_CONFIGS[state], [state]);
  const { Icon } = config;

  return (
    <span
      className={`sync-status-badge sync-status--${size} ${config.className} ${className}`}
      title={config.title}
    >
      <span className="sync-status-icon">
        <Icon size={size === 'medium' ? 14 : 12} aria-hidden={true} />
      </span>
      {showLabel && <span className="sync-status-label">{config.label}</span>}
    </span>
  );
}

export default SyncStatusBadge;
