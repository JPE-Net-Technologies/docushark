/**
 * Selection Highlight component.
 *
 * Renders highlights around shapes that other users have selected.
 * Shows a colored border matching the user's cursor color with their name.
 *
 * Phase 14.1.4 Collaboration Overhaul
 */

import { useMemo } from 'react';
import { useCollaborationStore } from '../collaboration';
import { usePresenceStore, type RemotePresence } from '../store/presenceStore';
import { useSessionStore } from '../store/sessionStore';
import { useDocumentStore } from '../store/documentStore';
import { shapeRegistry } from '../shapes/ShapeRegistry';
import type { Shape } from '../shapes/Shape';
import './SelectionHighlight.css';

interface SelectionBoxProps {
  user: RemotePresence;
  shapeId: string;
  cameraX: number;
  cameraY: number;
  cameraZoom: number;
  containerWidth: number;
  containerHeight: number;
  shapes: Record<string, Shape>;
}

function SelectionBox({
  user,
  shapeId,
  cameraX,
  cameraY,
  cameraZoom,
  containerWidth,
  containerHeight,
  shapes,
}: SelectionBoxProps) {
  const shape = shapes[shapeId];
  if (!shape) return null;

  // Get shape bounds using registry
  let bounds;
  try {
    const handler = shapeRegistry.getHandlerForShape(shape);
    bounds = handler.getBounds(shape);
  } catch {
    // Shape type not registered
    return null;
  }

  // World to screen, as Camera.worldToScreen does: the camera is the viewport's
  // centre, and the container is the viewport (DSK-231).
  const screenX = containerWidth / 2 + (bounds.minX - cameraX) * cameraZoom;
  const screenY = containerHeight / 2 + (bounds.minY - cameraY) * cameraZoom;
  const screenWidth = bounds.width * cameraZoom;
  const screenHeight = bounds.height * cameraZoom;

  // Add some padding around the shape
  const padding = 4;

  return (
    <div
      className="collab-selection-box"
      style={{
        left: screenX - padding,
        top: screenY - padding,
        width: screenWidth + padding * 2,
        height: screenHeight + padding * 2,
        borderColor: user.color,
        '--selection-color': user.color,
      } as React.CSSProperties}
    >
      <span
        className="collab-selection-label"
        style={{ backgroundColor: user.color }}
      >
        {user.name}
      </span>
    </div>
  );
}

export interface SelectionHighlightProps {
  /** Container width: the camera's viewport */
  width?: number;
  /** Container height: the camera's viewport */
  height?: number;
}

export function SelectionHighlight({ width = 800, height = 600 }: SelectionHighlightProps) {
  const isActive = useCollaborationStore((state) => state.isActive);
  const presenceEnabled = usePresenceStore((state) => state.enabled);
  const remoteUsers = usePresenceStore((state) => state.remoteUsers);

  // Get shapes for bounds calculation
  const shapes = useDocumentStore((state) => state.shapes);

  // Get camera state for coordinate transform
  const camera = useSessionStore((state) => state.camera);
  const cameraX = camera.x;
  const cameraY = camera.y;
  const cameraZoom = camera.zoom;

  // Get users with selections (excluding empty selections)
  const usersWithSelections = useMemo(() => {
    const result: Array<{ user: RemotePresence; shapeIds: string[] }> = [];

    remoteUsers.forEach((user) => {
      if (user.selection && user.selection.length > 0) {
        // Filter to shapes that exist
        const validShapes = user.selection.filter((id) => shapes[id]);
        if (validShapes.length > 0) {
          result.push({ user, shapeIds: validShapes });
        }
      }
    });

    return result;
  }, [remoteUsers, shapes]);

  // Don't render if collaboration not active or presence disabled or no selections
  if (!isActive || !presenceEnabled || usersWithSelections.length === 0) {
    return null;
  }

  return (
    <div
      className="collab-selection-overlay"
      style={{
        width: width,
        height: height,
      }}
    >
      {usersWithSelections.flatMap(({ user, shapeIds }) =>
        shapeIds.map((shapeId) => (
          <SelectionBox
            key={`${user.clientId}-${shapeId}`}
            user={user}
            shapeId={shapeId}
            cameraX={cameraX}
            cameraY={cameraY}
            cameraZoom={cameraZoom}
            containerWidth={width}
            containerHeight={height}
            shapes={shapes}
          />
        ))
      )}
    </div>
  );
}

export default SelectionHighlight;
