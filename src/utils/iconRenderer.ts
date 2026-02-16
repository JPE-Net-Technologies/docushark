/**
 * Icon rendering utility for shapes.
 *
 * Centralizes icon rendering logic including:
 * - Inside mode (icon positioned in shape corner/center)
 * - Badge mode (icon wrapped in styled badge)
 * - Icon-only mode (shape renders only the icon)
 * - Multi-icon support
 */

import { drawIcon } from './iconCache';
import {
  IconPosition,
  IconDisplayMode,
  IconBadgeConfig,
  IconConfig,
  DEFAULT_BADGE_CONFIG,
} from '../shapes/Shape';

/**
 * Shape bounds for icon positioning calculations.
 */
export interface ShapeBounds {
  /** Half-width of the shape (from center to edge) */
  halfWidth: number;
  /** Half-height of the shape (from center to edge) */
  halfHeight: number;
}

/**
 * Resolved icon configuration with all defaults applied.
 */
interface ResolvedIconConfig {
  iconId: string;
  size: number;
  padding: number;
  color: string;
  position: IconPosition;
  displayMode: IconDisplayMode;
  badge: IconBadgeConfig;
}

/**
 * Direction for projecting multiple icons at the same position.
 * Corners project inward, edges project along the edge.
 */
type ProjectionDirection = 'right' | 'left' | 'down' | 'up' | 'none';

/**
 * Get the projection direction for a position when stacking multiple icons.
 */
function getProjectionDirection(position: IconPosition): ProjectionDirection {
  switch (position) {
    case 'top-left':
    case 'left':
    case 'bottom-left':
      return 'right'; // Project icons to the right
    case 'top-right':
    case 'right':
    case 'bottom-right':
      return 'left'; // Project icons to the left
    case 'top':
    case 'top-left-outer':
    case 'top-right-outer':
      return 'down'; // Project icons downward
    case 'bottom':
    case 'bottom-left-outer':
    case 'bottom-right-outer':
      return 'up'; // Project icons upward
    case 'center':
    default:
      return 'right'; // Default to right for center
  }
}

/**
 * Calculate icon position within shape bounds.
 *
 * @param bounds - Shape bounds (half-width and half-height from center)
 * @param position - Icon position identifier
 * @param size - Icon size in pixels
 * @param padding - Padding from shape edge
 * @param stackIndex - Index within same-position icons (for stacking)
 * @param stackGap - Gap between stacked icons (default: 4)
 */
function calculateIconPosition(
  bounds: ShapeBounds,
  position: IconPosition,
  size: number,
  padding: number,
  stackIndex: number = 0,
  stackGap: number = 4
): { x: number; y: number } {
  const { halfWidth, halfHeight } = bounds;

  // Calculate base position
  let x: number;
  let y: number;

  switch (position) {
    // Corner positions (inside)
    case 'top-right':
      x = halfWidth - padding - size;
      y = -halfHeight + padding;
      break;
    case 'bottom-left':
      x = -halfWidth + padding;
      y = halfHeight - padding - size;
      break;
    case 'bottom-right':
      x = halfWidth - padding - size;
      y = halfHeight - padding - size;
      break;
    case 'top-left':
      x = -halfWidth + padding;
      y = -halfHeight + padding;
      break;

    // Edge-center positions
    case 'left':
      x = -halfWidth + padding;
      y = -size / 2;
      break;
    case 'right':
      x = halfWidth - padding - size;
      y = -size / 2;
      break;
    case 'top':
      x = -size / 2;
      y = -halfHeight + padding;
      break;
    case 'bottom':
      x = -size / 2;
      y = halfHeight - padding - size;
      break;

    // Outer positions (badges outside shape bounds)
    case 'top-left-outer':
      x = -halfWidth - size / 2;
      y = -halfHeight - size / 2;
      break;
    case 'top-right-outer':
      x = halfWidth - size / 2;
      y = -halfHeight - size / 2;
      break;
    case 'bottom-left-outer':
      x = -halfWidth - size / 2;
      y = halfHeight - size / 2;
      break;
    case 'bottom-right-outer':
      x = halfWidth - size / 2;
      y = halfHeight - size / 2;
      break;

    // Center
    case 'center':
    default:
      x = -size / 2;
      y = -size / 2;
      break;
  }

  // Apply stack offset if there are multiple icons at this position
  if (stackIndex > 0) {
    const offset = stackIndex * (size + stackGap);
    const direction = getProjectionDirection(position);

    switch (direction) {
      case 'right':
        x += offset;
        break;
      case 'left':
        x -= offset;
        break;
      case 'down':
        y += offset;
        break;
      case 'up':
        y -= offset;
        break;
    }
  }

  return { x, y };
}

/**
 * Render a badge background.
 */
function renderBadge(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  iconSize: number,
  badge: IconBadgeConfig
): void {
  const badgePadding = badge.padding ?? 4;
  const badgeSize = iconSize + badgePadding * 2;
  const badgeCenterX = x + iconSize / 2;
  const badgeCenterY = y + iconSize / 2;

  ctx.save();

  // Draw shadow if enabled
  if (badge.shadow) {
    ctx.shadowColor = 'rgba(0, 0, 0, 0.2)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 2;
  }

  // Draw badge shape
  ctx.beginPath();

  switch (badge.shape) {
    case 'circle':
      ctx.arc(badgeCenterX, badgeCenterY, badgeSize / 2, 0, Math.PI * 2);
      break;

    case 'rounded-rect': {
      const radius = badgeSize * 0.2;
      const left = badgeCenterX - badgeSize / 2;
      const top = badgeCenterY - badgeSize / 2;
      ctx.roundRect(left, top, badgeSize, badgeSize, radius);
      break;
    }

    case 'square': {
      const left = badgeCenterX - badgeSize / 2;
      const top = badgeCenterY - badgeSize / 2;
      ctx.rect(left, top, badgeSize, badgeSize);
      break;
    }
  }

  ctx.closePath();

  // Fill background
  ctx.fillStyle = badge.backgroundColor;
  ctx.fill();

  // Reset shadow before stroke
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;

  // Draw border if specified
  if (badge.borderColor && (badge.borderWidth ?? 0) > 0) {
    ctx.strokeStyle = badge.borderColor;
    ctx.lineWidth = badge.borderWidth ?? 1;
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * Resolve icon configuration with defaults.
 */
function resolveIconConfig(
  config: IconConfig | {
    iconId: string;
    size?: number;
    padding?: number;
    color?: string;
    position?: IconPosition;
    displayMode?: IconDisplayMode;
    badge?: IconBadgeConfig;
  },
  defaultColor: string
): ResolvedIconConfig {
  return {
    iconId: config.iconId,
    size: config.size ?? 24,
    padding: config.padding ?? 8,
    color: config.color ?? defaultColor,
    position: config.position ?? 'top-left',
    displayMode: config.displayMode ?? 'inside',
    badge: config.badge ?? { ...DEFAULT_BADGE_CONFIG },
  };
}

/**
 * Render a single icon with its display mode.
 *
 * @param ctx - Canvas 2D context (should already have transforms applied)
 * @param config - Resolved icon configuration
 * @param bounds - Shape bounds for positioning
 * @param stackIndex - Index within same-position icons (for stacking offset)
 * @returns true if icon was drawn, false if not yet loaded
 */
function renderSingleIcon(
  ctx: CanvasRenderingContext2D,
  config: ResolvedIconConfig,
  bounds: ShapeBounds,
  stackIndex: number = 0
): boolean {
  const { iconId, size, padding, color, position, displayMode, badge } = config;

  // Calculate icon position with stack offset
  const pos = calculateIconPosition(bounds, position, size, padding, stackIndex);

  // Handle different display modes
  switch (displayMode) {
    case 'badge':
      // Draw badge background first
      renderBadge(ctx, pos.x, pos.y, size, badge);
      // Then draw icon
      return drawIcon(ctx, iconId, pos.x, pos.y, size, color);

    case 'icon-only':
      // Icon-only mode - shape handler should skip fill/stroke
      // Just draw the icon centered
      return drawIcon(ctx, iconId, -size / 2, -size / 2, size, color);

    case 'inside':
    default:
      // Standard inside positioning
      return drawIcon(ctx, iconId, pos.x, pos.y, size, color);
  }
}

/**
 * Render icons on a shape.
 *
 * Supports both legacy single-icon properties and new multi-icon array.
 * When multiple icons share the same position, they are projected horizontally
 * or vertically to avoid stacking on top of each other.
 *
 * @param ctx - Canvas 2D context (should already have shape transforms applied)
 * @param shape - Shape object with icon properties
 * @param bounds - Shape bounds for icon positioning
 * @param defaultColor - Default icon color (usually stroke color)
 * @returns true if all icons were drawn, false if any are still loading
 */
export function renderShapeIcons(
  ctx: CanvasRenderingContext2D,
  shape: {
    iconId?: string;
    iconSize?: number;
    iconPadding?: number;
    iconColor?: string;
    iconPosition?: IconPosition;
    iconDisplayMode?: IconDisplayMode;
    iconBadge?: IconBadgeConfig;
    icons?: IconConfig[];
  },
  bounds: ShapeBounds,
  defaultColor: string
): boolean {
  // Check for multi-icon array first
  if (shape.icons && shape.icons.length > 0) {
    let allDrawn = true;

    // Group icons by position to handle stacking
    const positionCounts = new Map<IconPosition, number>();

    for (const iconConfig of shape.icons) {
      const resolved = resolveIconConfig(iconConfig, defaultColor);
      const position = resolved.position;

      // Get current stack index for this position
      const stackIndex = positionCounts.get(position) || 0;
      positionCounts.set(position, stackIndex + 1);

      // Render with stack index
      const drawn = renderSingleIcon(ctx, resolved, bounds, stackIndex);
      if (!drawn) allDrawn = false;
    }

    return allDrawn;
  }

  // Fall back to legacy single-icon properties
  if (shape.iconId) {
    // Build config object, only including defined properties
    const legacyConfig: {
      iconId: string;
      size?: number;
      padding?: number;
      color?: string;
      position?: IconPosition;
      displayMode?: IconDisplayMode;
      badge?: IconBadgeConfig;
    } = { iconId: shape.iconId };

    if (shape.iconSize !== undefined) legacyConfig.size = shape.iconSize;
    if (shape.iconPadding !== undefined) legacyConfig.padding = shape.iconPadding;
    if (shape.iconColor !== undefined) legacyConfig.color = shape.iconColor;
    if (shape.iconPosition !== undefined) legacyConfig.position = shape.iconPosition;
    if (shape.iconDisplayMode !== undefined) legacyConfig.displayMode = shape.iconDisplayMode;
    if (shape.iconBadge !== undefined) legacyConfig.badge = shape.iconBadge;

    const resolved = resolveIconConfig(legacyConfig, defaultColor);
    return renderSingleIcon(ctx, resolved, bounds, 0);
  }

  // No icons to render
  return true;
}

/**
 * Check if a shape is in icon-only mode.
 * Shape handlers should skip fill/stroke rendering when this returns true.
 */
export function isIconOnlyMode(shape: {
  iconDisplayMode?: IconDisplayMode;
  icons?: IconConfig[];
}): boolean {
  // Check multi-icon array - if ANY icon is icon-only, the whole shape is
  if (shape.icons && shape.icons.length > 0) {
    return shape.icons.some((icon) => icon.displayMode === 'icon-only');
  }

  // Check legacy single-icon property
  return shape.iconDisplayMode === 'icon-only';
}

/**
 * Get the effective icon size for icon-only mode.
 * Used for hit testing and bounds calculations.
 */
export function getIconOnlySize(shape: {
  iconSize?: number;
  icons?: IconConfig[];
}): number {
  // Check multi-icon array
  if (shape.icons && shape.icons.length > 0) {
    const iconOnlyIcon = shape.icons.find((icon) => icon.displayMode === 'icon-only');
    if (iconOnlyIcon) {
      return iconOnlyIcon.size ?? 24;
    }
  }

  // Fall back to legacy property
  return shape.iconSize ?? 24;
}
