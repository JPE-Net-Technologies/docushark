/**
 * Collaborative Cursors overlay component.
 *
 * Renders other users' cursor positions on the canvas as colored cursors
 * with their names. This creates the real-time collaborative experience
 * where you can see what other people are looking at.
 *
 * Phase 14.1.4 - Updated to use presenceStore for better performance.
 */

import { useMemo } from 'react';
import { useCollaborationStore } from '../collaboration';
import { usePresenceStore, type RemotePresence } from '../store/presenceStore';
import { useSessionStore } from '../store/sessionStore';
import './CollaborativeCursors.css';

/**
 * Generate a consistent color from a user ID.
 */
function getUserColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 50%)`;
}

interface CursorProps {
  user: RemotePresence;
  cameraX: number;
  cameraY: number;
  cameraZoom: number;
  containerWidth: number;
  containerHeight: number;
}

function Cursor({ user, cameraX, cameraY, cameraZoom, containerWidth, containerHeight }: CursorProps) {
  if (!user.cursor) return null;

  const color = user.color || getUserColor(user.userId);

  // Transform world → screen. Must mirror Camera.worldToScreen exactly (the
  // inverse of the screenToWorld used to capture the cursor): screen = viewport
  // center + (world − camera) * zoom. The container size IS the camera viewport,
  // so its half is the center offset. (Omitting this term shifted every remote
  // cursor by half the viewport — the off-by-half-screen bug.)
  const screenX = containerWidth / 2 + (user.cursor.x - cameraX) * cameraZoom;
  const screenY = containerHeight / 2 + (user.cursor.y - cameraY) * cameraZoom;

  // Skip if cursor is off-screen (with some margin)
  if (screenX < -50 || screenY < -50) return null;
  if (screenX > containerWidth + 50 || screenY > containerHeight + 50) return null;

  return (
    <div
      className="collab-cursor"
      style={{
        left: screenX,
        top: screenY,
        '--cursor-color': color,
      } as React.CSSProperties}
    >
      {/* Cursor arrow SVG */}
      <svg
        className="collab-cursor-icon"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
      >
        <path
          d="M1 1L6 14L8 8L14 6L1 1Z"
          fill={color}
          stroke="white"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>

      {/* User name label */}
      <span
        className="collab-cursor-label"
        style={{ backgroundColor: color }}
      >
        {user.name}
      </span>
    </div>
  );
}

export interface CollaborativeCursorsProps {
  /** Container width for bounds checking */
  width?: number;
  /** Container height for bounds checking */
  height?: number;
}

export function CollaborativeCursors({ width = 800, height = 600 }: CollaborativeCursorsProps) {
  const isActive = useCollaborationStore((state) => state.isActive);
  const presenceEnabled = usePresenceStore((state) => state.enabled);
  const remoteUsers = usePresenceStore((state) => state.remoteUsers);
  const cursorStaleThreshold = usePresenceStore((state) => state.cursorStaleThreshold);

  // Get camera state for coordinate transform
  const camera = useSessionStore((state) => state.camera);
  const cameraX = camera.x;
  const cameraY = camera.y;
  const cameraZoom = camera.zoom;

  // Filter to users with non-stale cursor positions
  const usersWithCursors = useMemo(() => {
    const now = Date.now();
    const result: RemotePresence[] = [];

    remoteUsers.forEach((user) => {
      if (user.cursor && now - user.lastUpdated < cursorStaleThreshold) {
        result.push(user);
      }
    });

    return result;
  }, [remoteUsers, cursorStaleThreshold]);

  // Don't render if collaboration not active or presence disabled or no cursors
  if (!isActive || !presenceEnabled || usersWithCursors.length === 0) {
    return null;
  }

  return (
    <div
      className="collab-cursors-overlay"
      style={{
        width: width,
        height: height,
      }}
    >
      {usersWithCursors.map((user) => (
        <Cursor
          key={user.clientId}
          user={user}
          cameraX={cameraX}
          cameraY={cameraY}
          cameraZoom={cameraZoom}
          containerWidth={width}
          containerHeight={height}
        />
      ))}
    </div>
  );
}

export default CollaborativeCursors;
