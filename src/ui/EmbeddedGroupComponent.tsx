/**
 * EmbeddedGroupComponent - React component for rendering embedded groups in Tiptap.
 *
 * Renders a canvas group as an image within the rich text editor.
 * The group is exported to PNG on demand and cached for performance.
 */

import { useEffect, useState, useCallback } from 'react';
import { NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { useDocumentStore } from '../store/documentStore';
import { useThemeStore } from '../store/themeStore';
import { isGroup, type GroupShape, type Shape, type ConnectorShape } from '../shapes/Shape';
import { exportToPng, type ExportData } from '../utils/exportUtils';
import { ContrastCache, preResolveAutoColors } from '../engine/ContrastResolver';
import { setRenderContext } from '../engine/RenderContext';
import './EmbeddedGroupComponent.css';

/**
 * Export scale for high-quality rendering.
 */
const EXPORT_SCALE = 2;

/**
 * Get all shape IDs within a group (recursive for nested groups).
 *
 * Also includes connectors whose endpoints are both attached to shapes in the
 * group, even if the connector itself isn't in `childIds` — those are visually
 * part of the group and dropping them creates gaps in the rendered preview.
 */
function getGroupShapeIds(groupId: string, shapes: Record<string, unknown>): string[] {
  const group = shapes[groupId] as GroupShape | undefined;
  if (!group || !isGroup(group)) return [];

  const ids: string[] = [];
  const collected = new Set<string>();

  const walk = (gid: string): void => {
    const g = shapes[gid] as GroupShape | undefined;
    if (!g || !isGroup(g)) return;
    for (const childId of g.childIds) {
      if (collected.has(childId)) continue;
      ids.push(childId);
      collected.add(childId);
      const child = shapes[childId];
      if (child && isGroup(child as GroupShape)) {
        walk(childId);
      }
    }
  };
  walk(groupId);

  const memberSet = new Set<string>([groupId, ...ids]);
  for (const id in shapes) {
    if (memberSet.has(id)) continue;
    const shape = shapes[id] as Shape | undefined;
    if (!shape || shape.type !== 'connector') continue;
    const conn = shape as ConnectorShape;
    if (
      conn.startShapeId &&
      conn.endShapeId &&
      memberSet.has(conn.startShapeId) &&
      memberSet.has(conn.endShapeId)
    ) {
      ids.push(id);
      memberSet.add(id);
    }
  }

  return ids;
}

export function EmbeddedGroupComponent({ node, updateAttributes, selected }: NodeViewProps) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const groupId = node.attrs['groupId'] as string;
  const groupName = node.attrs['groupName'] as string | undefined;

  // Get shape data from store
  const shapes = useDocumentStore((state) => state.shapes);
  const shapeOrder = useDocumentStore((state) => state.shapeOrder);

  // Get theme background color
  const themeBackground = useThemeStore((state) => state.colors.backgroundColor);

  // Export group to PNG
  const exportGroup = useCallback(async () => {
    if (!groupId) {
      setError('No group ID specified');
      setIsLoading(false);
      return;
    }

    const group = shapes[groupId];
    if (!group || !isGroup(group)) {
      setError('Group not found');
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);
      setError(null);

      // Get all shapes within this group (including nested)
      const groupShapeIds = new Set([groupId, ...getGroupShapeIds(groupId, shapes)]);

      // Filter shapes to only include those in this group
      const groupShapes: Record<string, Shape> = {};
      for (const id of groupShapeIds) {
        if (shapes[id]) {
          groupShapes[id] = shapes[id];
        }
      }

      // Order shapes according to shapeOrder (maintain z-order)
      const groupShapeOrder = shapeOrder.filter((id) => groupShapeIds.has(id));

      // Pre-resolve AUTO on non-connector/non-group shapes against the embed's
      // theme background; connectors and groups resolve at render time via the
      // render context published below.
      const resolvedShapes = preResolveAutoColors(
        groupShapes,
        groupShapeOrder,
        themeBackground
      );

      const exportData: ExportData = {
        shapes: resolvedShapes,
        shapeOrder: groupShapeOrder,
        selectedIds: [groupId], // Export the group
      };

      // Publish a render context so connector/group/text handlers resolve AUTO
      // against the embed's theme background — without this AUTO would fall
      // through to the null-context fallback (#000000) and dark-mode embeds
      // would render black-on-dark.
      setRenderContext({
        shapes: resolvedShapes,
        shapeOrder: groupShapeOrder,
        pageBackground: themeBackground,
        contrastCache: new ContrastCache(),
      });

      let blob: Blob;
      try {
        // Export as PNG with theme-aware background
        // Use larger padding to accommodate group labels that may be outside bounds
        blob = await exportToPng(exportData, {
          format: 'png',
          scope: 'selection',
          scale: EXPORT_SCALE,
          background: themeBackground,
          padding: 40,
          filename: 'group',
        });
      } finally {
        setRenderContext(null);
      }

      // Convert blob to object URL
      const url = URL.createObjectURL(blob);
      setImageUrl(url);

      // Update cached URL in node attributes for persistence
      updateAttributes({ cachedImageUrl: url });
    } catch (err) {
      console.error('Failed to export group:', err);
      setError('Failed to render group');
    } finally {
      setIsLoading(false);
    }
  }, [groupId, shapes, shapeOrder, themeBackground, updateAttributes]);

  // Export group on mount and when group changes
  useEffect(() => {
    exportGroup();

    // Cleanup object URL on unmount
    return () => {
      if (imageUrl) {
        URL.revokeObjectURL(imageUrl);
      }
    };
  }, [groupId]); // Re-export when groupId changes

  // Handle refresh button click
  const handleRefresh = useCallback(() => {
    exportGroup();
  }, [exportGroup]);

  // Render loading state
  if (isLoading) {
    return (
      <NodeViewWrapper className="embedded-group-wrapper">
        <div className="embedded-group embedded-group-loading">
          <div className="embedded-group-spinner" />
          <span>Loading group...</span>
        </div>
      </NodeViewWrapper>
    );
  }

  // Render error state
  if (error) {
    return (
      <NodeViewWrapper className="embedded-group-wrapper">
        <div className="embedded-group embedded-group-error">
          <span className="embedded-group-error-icon">⚠</span>
          <span>{error}</span>
          <button className="embedded-group-retry-btn" onClick={handleRefresh}>
            Retry
          </button>
        </div>
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper className="embedded-group-wrapper">
      <div className={`embedded-group ${selected ? 'embedded-group-selected' : ''}`}>
        {groupName && <div className="embedded-group-name">{groupName}</div>}
        <div className="embedded-group-image-container">
          <img
            src={imageUrl || ''}
            alt={groupName || 'Embedded diagram group'}
            className="embedded-group-image"
          />
        </div>
        <button
          className="embedded-group-refresh-btn"
          onClick={handleRefresh}
          title="Refresh group preview"
        >
          ↻
        </button>
      </div>
    </NodeViewWrapper>
  );
}
