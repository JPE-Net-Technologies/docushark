/**
 * LayoutThumbnail — tiny SVG preview of a layout's panel arrangement, used in
 * the LayoutSelector dropdown and (later) the Settings → Layout editor.
 *
 * Pure read of `LAYOUT_PRESETS` — does not honor user overrides, since the
 * point of the thumbnail is to show what a layout *looks like by default*.
 * Once a user has customized, the selector still uses the preset preview to
 * keep the four thumbnails comparable at a glance.
 */

import { LAYOUT_PRESETS } from './modes';
import type { LayoutMode, PanelId } from './types';

interface LayoutThumbnailProps {
  mode: LayoutMode;
  width?: number;
  height?: number;
  active?: boolean;
}

const STROKE = '#9ca3af';
const FILL_CANVAS = '#1f2937';
const FILL_PANEL = '#4b5563';
const FILL_PANEL_HIDDEN = 'transparent';
const FILL_FLYOUT_RAIL = '#374151';

export function LayoutThumbnail({
  mode,
  width = 56,
  height = 36,
  active = false,
}: LayoutThumbnailProps) {
  const preset = LAYOUT_PRESETS[mode];
  const flyoutMode = mode === 'designer' || mode === 'technician';

  // Slot widths: document on the left, properties on the right, layers as a
  // tiny chip in the bottom-right of canvas. Hidden panels collapse to 0.
  const docVisible = preset.document.visible;
  const propsVisible = preset.properties.visible;
  const layersVisible = preset.layers.visible;

  const docW = docVisible ? Math.round(width * 0.28) : 0;
  const propsW = propsVisible ? (flyoutMode && !preset.properties.pinned ? 4 : Math.round(width * 0.22)) : 0;
  const canvasX = docW;
  const canvasW = width - docW - propsW;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${mode} layout thumbnail`}
      style={{
        borderRadius: 4,
        border: active ? '1.5px solid var(--color-primary, #2196f3)' : '1px solid var(--border-color, #d1d5db)',
        background: '#0f172a',
        flexShrink: 0,
      }}
    >
      {/* Title bar strip */}
      <rect x={0} y={0} width={width} height={3} fill={STROKE} opacity={0.5} />

      {/* Document panel */}
      {docVisible && (
        <rect x={0} y={3} width={docW} height={height - 3} fill={FILL_PANEL} />
      )}

      {/* Canvas */}
      <rect x={canvasX} y={3} width={canvasW} height={height - 3} fill={FILL_CANVAS} />

      {/* Properties panel — rail-thin if fly-out, full-width if pinned/docked */}
      {propsVisible && (
        <rect
          x={width - propsW}
          y={3}
          width={propsW}
          height={height - 3}
          fill={flyoutMode && !preset.properties.pinned ? FILL_FLYOUT_RAIL : FILL_PANEL}
        />
      )}

      {/* Layers chip in bottom-left of canvas */}
      {layersVisible && (
        <rect
          x={canvasX + 3}
          y={height - 7}
          width={10}
          height={4}
          rx={1}
          fill={FILL_PANEL}
          opacity={0.85}
        />
      )}

      {/* Hide the hidden marker explicitly for the linter (no-op visual) */}
      {!propsVisible && <rect width={0} height={0} fill={FILL_PANEL_HIDDEN} />}
    </svg>
  );
}

/** Keep the panel keys discoverable from one place — handy in tests. */
export const THUMBNAIL_PANELS: readonly PanelId[] = ['document', 'properties', 'layers'];
