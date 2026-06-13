/**
 * ERD (Entity-Relationship Diagram) shape definitions using Crow's Foot notation.
 *
 * This module defines shapes for creating ER diagrams:
 * - Entity (rectangle with header for name)
 * - Weak Entity (double-bordered rectangle)
 * - Relationship (diamond)
 * - Attribute (ellipse)
 * - Key Attribute (ellipse with underline indicator)
 * - Cardinality indicators (One, Many, Zero-One, Zero-Many, One-Many)
 */

import type { LibraryShapeDefinition, CustomRenderFunction, AnchorDefinition, DynamicAnchorsFunction } from './ShapeLibraryTypes';
import { createStandardAnchors, createDiamondAnchors } from './ShapeLibraryTypes';
import { createStandardProperties } from '../ShapeMetadata';
import type { PropertyDefinition } from '../ShapeMetadata';
import type { LibraryShape } from '../Shape';

/**
 * Create ellipse anchors with 8 points on the ellipse edge.
 * Anchors are placed at cardinal and intercardinal positions.
 */
function createEllipseAnchors(): AnchorDefinition[] {
  return [
    { position: 'center', x: () => 0, y: () => 0 },
    { position: 'top', x: () => 0, y: (_, h) => -h / 2 },
    { position: 'right', x: (w) => w / 2, y: () => 0 },
    { position: 'bottom', x: () => 0, y: (_, h) => h / 2 },
    { position: 'left', x: (w) => -w / 2, y: () => 0 },
    // Intercardinal anchors on ellipse edge
    // For ellipse: x = a*cos(θ), y = b*sin(θ) where a=w/2, b=h/2
    // At 45°: cos(45°) = sin(45°) = √2/2 ≈ 0.707
    { position: 'top', x: (w) => w / 2 * 0.707, y: (_, h) => -h / 2 * 0.707 },     // top-right
    { position: 'bottom', x: (w) => w / 2 * 0.707, y: (_, h) => h / 2 * 0.707 },   // bottom-right
    { position: 'bottom', x: (w) => -w / 2 * 0.707, y: (_, h) => h / 2 * 0.707 },  // bottom-left
    { position: 'top', x: (w) => -w / 2 * 0.707, y: (_, h) => -h / 2 * 0.707 },    // top-left
  ];
}

/**
 * ERD entity member (attribute).
 */
export interface ERDEntityMember {
  name: string;
  type: string;
  isPrimaryKey: boolean;
}

/**
 * Custom properties for ERD entity shapes.
 * Includes entity data and table styling options.
 */
export interface ERDEntityCustomProps {
  /** Entity name displayed in the header */
  entityTitle?: string;
  /** List of entity attributes/members */
  members?: ERDEntityMember[];
  /** Whether to show row separator lines (default: true) */
  rowSeparatorEnabled?: boolean;
  /** Color for row separator lines */
  rowSeparatorColor?: string;
  /** Background color for rows */
  rowBackgroundColor?: string;
  /** Alternate background color for zebra-striping */
  rowAlternateColor?: string;
  /** Horizontal padding for attribute text (default: 8) */
  attributePaddingHorizontal?: number;
  /** Vertical padding between attributes (default: 2) */
  attributePaddingVertical?: number;
}

/**
 * Helper to calculate a row's Y position for anchor placement.
 * Uses the same logic as renderERDEntity for consistency.
 */
function calculateAttributeRowY(height: number, memberCount: number, rowIndex: number, gap: number = 0): number {
  const headerHeight = Math.min(30, height * 0.35);
  const hh = height / 2;
  const bodyTop = -hh + headerHeight + 5;
  const bodyHeight = height - headerHeight - 10 - gap;
  const memberFontSize = memberCount > 0 ? Math.min(12, bodyHeight / memberCount * 0.8) : 12;
  const lineHeight = memberFontSize * 1.4;
  return bodyTop + (rowIndex + 0.5) * lineHeight;
}

/**
 * Create dynamic anchors for ERD entity shapes.
 * Includes standard anchors plus per-attribute row anchors on left and right sides.
 */
const createERDEntityAnchors: DynamicAnchorsFunction = (shape: LibraryShape, _width: number, _height: number): AnchorDefinition[] => {
  const anchors = [...createStandardAnchors()]; // Start with standard anchors

  const customProps = shape.customProperties as ERDEntityCustomProps | undefined;
  const members = customProps?.members || [];

  if (members.length === 0) return anchors;

  const memberCount = members.length;

  // Add left and right anchors for each attribute row
  // Use height parameter in the y function to ensure proper recalculation
  for (let index = 0; index < memberCount; index++) {
    const idx = index; // Capture index for closure
    const count = memberCount; // Capture count for closure

    anchors.push({
      position: `attr-${idx}-left`,
      x: (w) => -w / 2,
      y: (_, h) => calculateAttributeRowY(h, count, idx, 0),
    });

    anchors.push({
      position: `attr-${idx}-right`,
      x: (w) => w / 2,
      y: (_, h) => calculateAttributeRowY(h, count, idx, 0),
    });
  }

  return anchors;
};

/**
 * Create dynamic anchors for ERD weak entity shapes.
 * Same as entity anchors but accounts for the double-border gap.
 */
const createERDWeakEntityAnchors: DynamicAnchorsFunction = (shape: LibraryShape, _width: number, _height: number): AnchorDefinition[] => {
  const anchors = [...createStandardAnchors()]; // Start with standard anchors

  const customProps = shape.customProperties as ERDEntityCustomProps | undefined;
  const members = customProps?.members || [];
  const gap = 4; // Same gap as used in pathBuilder

  if (members.length === 0) return anchors;

  const memberCount = members.length;

  // Add left and right anchors for each attribute row
  // Use height parameter in the y function to ensure proper recalculation
  for (let index = 0; index < memberCount; index++) {
    const idx = index; // Capture index for closure
    const count = memberCount; // Capture count for closure

    anchors.push({
      position: `attr-${idx}-left`,
      x: (w) => -w / 2,
      y: (_, h) => calculateAttributeRowY(h, count, idx, gap),
    });

    anchors.push({
      position: `attr-${idx}-right`,
      x: (w) => w / 2,
      y: (_, h) => calculateAttributeRowY(h, count, idx, gap),
    });
  }

  return anchors;
};

/**
 * Custom render function for ERD entities.
 * Renders title in header, members in body, with optional table styling.
 */
const renderERDEntity: CustomRenderFunction = (ctx, shape) => {
  const { width, height, stroke } = shape;
  const hw = width / 2;
  const hh = height / 2;
  const headerHeight = Math.min(30, height * 0.35);

  // Get custom properties with table styling
  const customProps = shape.customProperties as ERDEntityCustomProps | undefined;

  const title = customProps?.entityTitle || shape.label || 'Entity';
  const members = customProps?.members || [];

  // Table styling options
  const rowSeparatorEnabled = customProps?.rowSeparatorEnabled ?? true;
  const rowSeparatorColor = customProps?.rowSeparatorColor || stroke || '#cccccc';
  const rowBgColor = customProps?.rowBackgroundColor;
  const rowAltColor = customProps?.rowAlternateColor;

  // Padding options
  const paddingH = customProps?.attributePaddingHorizontal ?? 8;
  const paddingV = customProps?.attributePaddingVertical ?? 2;

  // Draw title in header
  const titleFontSize = Math.min(14, headerHeight * 0.6);
  ctx.font = `bold ${titleFontSize}px sans-serif`;
  ctx.fillStyle = shape.labelColor || stroke || '#000000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(title, 0, -hh + headerHeight / 2, width - 10);

  // Draw members in body
  if (members.length > 0) {
    const bodyTop = -hh + headerHeight + 5;
    const bodyHeight = height - headerHeight - 10;
    const memberFontSize = Math.min(12, bodyHeight / members.length * 0.8);
    // Add vertical padding to line height for spacing between rows
    const baseLineHeight = memberFontSize * 1.4;
    const lineHeight = baseLineHeight + paddingV * 2;

    // Draw row backgrounds (if configured)
    if (rowBgColor || rowAltColor) {
      members.forEach((_, index) => {
        const rowTop = bodyTop + index * lineHeight;
        const bgColor = (index % 2 === 0) ? rowBgColor : (rowAltColor || rowBgColor);
        if (bgColor) {
          ctx.fillStyle = bgColor;
          ctx.fillRect(-hw + paddingH / 2, rowTop, width - paddingH, lineHeight);
        }
      });
    }

    // Draw row separator lines (if enabled)
    if (rowSeparatorEnabled && members.length > 1) {
      ctx.strokeStyle = rowSeparatorColor;
      ctx.lineWidth = 0.5;
      for (let i = 1; i < members.length; i++) {
        const y = bodyTop + i * lineHeight;
        ctx.beginPath();
        ctx.moveTo(-hw + paddingH / 2, y);
        ctx.lineTo(hw - paddingH / 2, y);
        ctx.stroke();
      }
    }

    // Draw member text - centered vertically in each row with padding
    ctx.font = `${memberFontSize}px sans-serif`;
    ctx.textAlign = 'left';

    members.forEach((member, index) => {
      // Position text in center of row
      const y = bodyTop + index * lineHeight + lineHeight / 2 + memberFontSize * 0.1;
      if (y > hh - 5) return; // Don't overflow

      const text = member.type ? `${member.name}: ${member.type}` : member.name;
      const x = -hw + paddingH;

      ctx.fillStyle = shape.labelColor || stroke || '#000000';

      // Underline for primary key
      if (member.isPrimaryKey) {
        ctx.fillText(text, x, y);
        const metrics = ctx.measureText(text);
        ctx.beginPath();
        ctx.moveTo(x, y + memberFontSize * 0.3);
        ctx.lineTo(x + metrics.width, y + memberFontSize * 0.3);
        ctx.strokeStyle = shape.labelColor || stroke || '#000000';
        ctx.lineWidth = 1;
        ctx.stroke();
      } else {
        ctx.fillText(text, x, y);
      }
    });
  }
};

/**
 * Custom render function for ERD weak entities.
 * Similar to entity but with double border consideration and table styling.
 */
const renderERDWeakEntity: CustomRenderFunction = (ctx, shape) => {
  const { width, height, stroke } = shape;
  const hw = width / 2;
  const hh = height / 2;
  const gap = 4;
  const headerHeight = Math.min(30, height * 0.35);

  // Get custom properties with table styling
  const customProps = shape.customProperties as ERDEntityCustomProps | undefined;

  const title = customProps?.entityTitle || shape.label || 'Weak Entity';
  const members = customProps?.members || [];

  // Table styling options
  const rowSeparatorEnabled = customProps?.rowSeparatorEnabled ?? true;
  const rowSeparatorColor = customProps?.rowSeparatorColor || stroke || '#cccccc';
  const rowBgColor = customProps?.rowBackgroundColor;
  const rowAltColor = customProps?.rowAlternateColor;

  // Padding options
  const paddingH = customProps?.attributePaddingHorizontal ?? 8;
  const paddingV = customProps?.attributePaddingVertical ?? 2;

  // Draw title in header (inside inner rectangle)
  const titleFontSize = Math.min(14, (headerHeight - gap) * 0.6);
  ctx.font = `bold ${titleFontSize}px sans-serif`;
  ctx.fillStyle = shape.labelColor || stroke || '#000000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(title, 0, -hh + headerHeight / 2, width - gap * 2 - 10);

  // Draw members in body
  if (members.length > 0) {
    const bodyTop = -hh + headerHeight + 5;
    const bodyHeight = height - headerHeight - 10;
    const memberFontSize = Math.min(12, bodyHeight / members.length * 0.8);
    // Add vertical padding to line height for spacing between rows
    const baseLineHeight = memberFontSize * 1.4;
    const lineHeight = baseLineHeight + paddingV * 2;

    // Draw row backgrounds (if configured)
    if (rowBgColor || rowAltColor) {
      members.forEach((_, index) => {
        const rowTop = bodyTop + index * lineHeight;
        const bgColor = (index % 2 === 0) ? rowBgColor : (rowAltColor || rowBgColor);
        if (bgColor) {
          ctx.fillStyle = bgColor;
          ctx.fillRect(-hw + gap + paddingH / 2, rowTop, width - gap * 2 - paddingH, lineHeight);
        }
      });
    }

    // Draw row separator lines (if enabled)
    if (rowSeparatorEnabled && members.length > 1) {
      ctx.strokeStyle = rowSeparatorColor;
      ctx.lineWidth = 0.5;
      for (let i = 1; i < members.length; i++) {
        const y = bodyTop + i * lineHeight;
        ctx.beginPath();
        ctx.moveTo(-hw + gap + paddingH / 2, y);
        ctx.lineTo(hw - gap - paddingH / 2, y);
        ctx.stroke();
      }
    }

    // Draw member text - centered vertically in each row with padding
    ctx.font = `${memberFontSize}px sans-serif`;
    ctx.textAlign = 'left';

    members.forEach((member, index) => {
      // Position text in center of row
      const y = bodyTop + index * lineHeight + lineHeight / 2 + memberFontSize * 0.1;
      if (y > hh - gap - 5) return; // Don't overflow

      const text = member.type ? `${member.name}: ${member.type}` : member.name;
      const x = -hw + gap + paddingH;

      ctx.fillStyle = shape.labelColor || stroke || '#000000';

      // Underline for primary key
      if (member.isPrimaryKey) {
        ctx.fillText(text, x, y);
        const metrics = ctx.measureText(text);
        ctx.beginPath();
        ctx.moveTo(x, y + memberFontSize * 0.3);
        ctx.lineTo(x + metrics.width, y + memberFontSize * 0.3);
        ctx.strokeStyle = shape.labelColor || stroke || '#000000';
        ctx.lineWidth = 1;
        ctx.stroke();
      } else {
        ctx.fillText(text, x, y);
      }
    });
  }
};

/**
 * ERD entity properties with custom fields.
 * Note: Entity name is edited via the custom ERDEntityProperties component.
 */
const erdEntityProperties: PropertyDefinition[] = [
  ...createStandardProperties({ includeLabel: false }),
  {
    // `labelColor` is a top-level BaseShape field (the renderer reads
    // `shape.labelColor`), so it must live in a section whose editor binds to
    // the top-level field. 'custom' routes through `customProperties`, which the
    // renderer never reads — that made the Text Color control a no-op.
    key: 'labelColor',
    label: 'Text Color',
    type: 'color',
    section: 'appearance',
  },
];

/**
 * Entity shape - rectangle with header divider.
 * Used to represent database tables or domain entities.
 */
export const erdEntityShape: LibraryShapeDefinition = {
  type: 'erd-entity',
  metadata: {
    type: 'erd-entity',
    name: 'Entity',
    category: 'erd',
    icon: '▭',
    properties: erdEntityProperties,
    supportsLabel: false, // Custom rendering handles text
    supportsIcon: false,
    defaultWidth: 140,
    defaultHeight: 100,
    description: 'Database table or domain entity',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    const hw = width / 2;
    const hh = height / 2;
    const headerHeight = Math.min(30, height * 0.35);

    // Main rectangle
    path.rect(-hw, -hh, width, height);

    // Header divider line
    path.moveTo(-hw, -hh + headerHeight);
    path.lineTo(hw, -hh + headerHeight);

    return path;
  },
  anchors: createStandardAnchors(),
  dynamicAnchors: createERDEntityAnchors,
  customRender: renderERDEntity,
  customLabelRendering: true,
};

/**
 * Weak Entity shape - double-bordered rectangle.
 * Represents an entity that depends on another entity for identification.
 */
export const erdWeakEntityShape: LibraryShapeDefinition = {
  type: 'erd-weak-entity',
  metadata: {
    type: 'erd-weak-entity',
    name: 'Weak Entity',
    category: 'erd',
    icon: '▣',
    properties: erdEntityProperties,
    supportsLabel: false, // Custom rendering handles text
    supportsIcon: false,
    defaultWidth: 140,
    defaultHeight: 100,
    description: 'Entity dependent on another for identification',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    const hw = width / 2;
    const hh = height / 2;
    const gap = 4; // Gap between inner and outer rectangles
    const headerHeight = Math.min(30, height * 0.35);

    // Outer rectangle
    path.rect(-hw, -hh, width, height);

    // Inner rectangle
    path.rect(-hw + gap, -hh + gap, width - gap * 2, height - gap * 2);

    // Header divider line (on inner rectangle)
    path.moveTo(-hw + gap, -hh + headerHeight);
    path.lineTo(hw - gap, -hh + headerHeight);

    return path;
  },
  anchors: createStandardAnchors(),
  dynamicAnchors: createERDWeakEntityAnchors,
  customRender: renderERDWeakEntity,
  customLabelRendering: true,
};

/**
 * Relationship shape - diamond.
 * Represents relationships between entities.
 */
export const erdRelationshipShape: LibraryShapeDefinition = {
  type: 'erd-relationship',
  metadata: {
    type: 'erd-relationship',
    name: 'Relationship',
    category: 'erd',
    icon: '◇',
    properties: createStandardProperties({ includeLabel: true }),
    supportsLabel: true,
    supportsIcon: false,
    defaultWidth: 100,
    defaultHeight: 60,
    description: 'Relationship between entities',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    const hw = width / 2;
    const hh = height / 2;

    path.moveTo(0, -hh);      // Top
    path.lineTo(hw, 0);       // Right
    path.lineTo(0, hh);       // Bottom
    path.lineTo(-hw, 0);      // Left
    path.closePath();

    return path;
  },
  anchors: createDiamondAnchors(),
};

/**
 * Attribute shape - ellipse.
 * Represents entity attributes/fields.
 */
export const erdAttributeShape: LibraryShapeDefinition = {
  type: 'erd-attribute',
  metadata: {
    type: 'erd-attribute',
    name: 'Attribute',
    category: 'erd',
    icon: '⬭',
    properties: createStandardProperties({ includeLabel: true }),
    supportsLabel: true,
    supportsIcon: false,
    defaultWidth: 100,
    defaultHeight: 50,
    description: 'Entity attribute or field',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    const hw = width / 2;
    const hh = height / 2;

    // Ellipse using bezier curves
    const kappa = 0.5522848;
    const ox = hw * kappa;
    const oy = hh * kappa;

    path.moveTo(0, -hh);
    path.bezierCurveTo(ox, -hh, hw, -oy, hw, 0);
    path.bezierCurveTo(hw, oy, ox, hh, 0, hh);
    path.bezierCurveTo(-ox, hh, -hw, oy, -hw, 0);
    path.bezierCurveTo(-hw, -oy, -ox, -hh, 0, -hh);
    path.closePath();

    return path;
  },
  anchors: createEllipseAnchors(),
};

/**
 * Key Attribute shape - ellipse with underline indicator.
 * Represents primary key attributes.
 */
export const erdKeyAttributeShape: LibraryShapeDefinition = {
  type: 'erd-key-attribute',
  metadata: {
    type: 'erd-key-attribute',
    name: 'Key Attribute',
    category: 'erd',
    icon: '🔑',
    properties: createStandardProperties({ includeLabel: true }),
    supportsLabel: true,
    supportsIcon: false,
    defaultWidth: 100,
    defaultHeight: 50,
    description: 'Primary key attribute (underlined)',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    const hw = width / 2;
    const hh = height / 2;

    // Ellipse using bezier curves
    const kappa = 0.5522848;
    const ox = hw * kappa;
    const oy = hh * kappa;

    path.moveTo(0, -hh);
    path.bezierCurveTo(ox, -hh, hw, -oy, hw, 0);
    path.bezierCurveTo(hw, oy, ox, hh, 0, hh);
    path.bezierCurveTo(-ox, hh, -hw, oy, -hw, 0);
    path.bezierCurveTo(-hw, -oy, -ox, -hh, 0, -hh);
    path.closePath();

    // Underline indicator in center
    const underlineWidth = width * 0.5;
    path.moveTo(-underlineWidth / 2, hh * 0.3);
    path.lineTo(underlineWidth / 2, hh * 0.3);

    return path;
  },
  anchors: createEllipseAnchors(),
};

/**
 * All ERD shape definitions.
 * Note: Cardinality notation is handled via connector properties (ERD Cardinality),
 * not standalone shapes.
 */
export const erdShapes: LibraryShapeDefinition[] = [
  erdEntityShape,
  erdWeakEntityShape,
  erdRelationshipShape,
  erdAttributeShape,
  erdKeyAttributeShape,
];
