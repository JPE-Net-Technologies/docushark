/**
 * Shape types and interfaces for the diagramming application.
 *
 * Shapes are plain data objects with no methods. All behavior is implemented
 * externally via the ShapeRegistry pattern, which provides handlers for
 * rendering, hit testing, bounds calculation, and handle positions.
 */

import type { LabelOverflow } from './label/LabelSpec';

/**
 * Standard handle types for resize/rotate operations.
 */
export const STANDARD_HANDLE_TYPES = [
  'top-left',
  'top',
  'top-right',
  'right',
  'bottom-right',
  'bottom',
  'bottom-left',
  'left',
  'rotation',
] as const;

export type StandardHandleType = (typeof STANDARD_HANDLE_TYPES)[number];

/**
 * Handle type - string to allow custom handle types beyond standard resize/rotate.
 * Standard types: 'top-left', 'top', 'top-right', 'right', 'bottom-right', 'bottom', 'bottom-left', 'left', 'rotation'
 * Custom types: 'lane-divider-{n}', 'header-resize', etc.
 */
export type HandleType = string;

/**
 * Metadata for custom handle behavior.
 */
export interface HandleMetadata {
  /** Shape-specific data (e.g., lane index for lane dividers) */
  data?: unknown;
  /** Visual style hint for rendering */
  style?: 'square' | 'line';
  /** Whether this is a standard resize/rotate handle */
  isStandard?: boolean;
}

/**
 * A handle represents a control point for resizing, rotating, or custom shape operations.
 */
export interface Handle {
  /** Handle identifier */
  type: HandleType;
  /** Position in world coordinates */
  x: number;
  y: number;
  /** Cursor to show when hovering */
  cursor: string;
  /** Optional metadata for custom handle behavior */
  metadata?: HandleMetadata;
}

/** File category for embedded file shapes */
export type FileCategory = 'pdf' | 'spreadsheet' | 'image' | 'text' | 'generic';

/**
 * Core shape type discriminator.
 * These are the built-in shape types that have dedicated handlers.
 */
export type CoreShapeType = 'rectangle' | 'ellipse' | 'line' | 'text' | 'connector' | 'group' | 'file';

/**
 * Array of core shape types for runtime checking.
 */
export const CORE_SHAPE_TYPES: readonly CoreShapeType[] = [
  'rectangle',
  'ellipse',
  'line',
  'text',
  'connector',
  'group',
  'file',
] as const;

/**
 * Shape type - includes core types and any library shape type.
 * Library shapes use dynamic string types like 'diamond', 'terminator', etc.
 */
export type ShapeType = CoreShapeType | string;

/**
 * Anchor position identifier on a shape for connectors.
 *
 * Well-known values: 'top', 'right', 'bottom', 'left', 'center'
 * Custom values for per-attribute anchors: 'attr-{index}-left', 'attr-{index}-right'
 *
 * String type allows shapes to define custom anchor positions beyond the standard 5.
 */
export type AnchorPosition = string;

/**
 * Standard anchor positions available on most shapes.
 */
export type StandardAnchorPosition = (typeof STANDARD_ANCHOR_POSITIONS)[number];

/**
 * Well-known anchor positions.
 * These are the standard positions available on most shapes.
 */
export const STANDARD_ANCHOR_POSITIONS = ['top', 'right', 'bottom', 'left', 'center'] as const;

/**
 * Check if a string is a valid standard anchor position.
 */
export function isStandardAnchorPosition(position: string): position is StandardAnchorPosition {
  return STANDARD_ANCHOR_POSITIONS.includes(position as StandardAnchorPosition);
}

/**
 * Validate an anchor position string.
 * Returns true for standard positions and valid custom patterns (e.g., 'attr-0-left').
 */
export function isValidAnchorPosition(position: string): boolean {
  if (isStandardAnchorPosition(position)) {
    return true;
  }
  // Custom attribute anchors: 'attr-{index}-{side}'
  const attrAnchorPattern = /^attr-\d+-(?:left|right|top|bottom)$/;
  if (attrAnchorPattern.test(position)) {
    return true;
  }
  // Allow any non-empty string for custom shapes (extensibility)
  return position.length > 0;
}

/**
 * Anchor point on a shape.
 */
export interface Anchor {
  /** Position identifier */
  position: AnchorPosition;
  /** World X coordinate */
  x: number;
  /** World Y coordinate */
  y: number;
}

/**
 * Base interface for all shapes.
 * All shape types extend this with their specific properties.
 */
export interface BaseShape {
  /** Unique identifier */
  id: string;
  /** Shape type discriminator */
  type: ShapeType;
  /** World X position (center for rect/ellipse, start for line) */
  x: number;
  /** World Y position */
  y: number;
  /** Rotation in radians */
  rotation: number;
  /** Opacity from 0 (transparent) to 1 (opaque) */
  opacity: number;
  /** Whether the shape is fully locked from all editing */
  locked: boolean;
  /** Whether the shape position is locked (can still resize) */
  lockedPosition?: boolean;
  /** Whether the shape size is locked (can still move) */
  lockedSize?: boolean;
  /** Whether the shape is visible (hidden shapes are not rendered) */
  visible: boolean;

  // Style properties
  /** Fill color (CSS color string) or null for no fill */
  fill: string | null;
  /** Stroke color (CSS color string) or null for no stroke */
  stroke: string | null;
  /** Stroke width in world units */
  strokeWidth: number;
}

/**
 * Rectangle shape with optional rounded corners.
 */
export interface RectangleShape extends BaseShape {
  type: 'rectangle';
  /** Width in world units */
  width: number;
  /** Height in world units */
  height: number;
  /** Corner radius for rounded rectangles (0 for sharp corners) */
  cornerRadius: number;
  /** Optional inline text label */
  label?: string;
  /** Label font size in world units (default: 14) */
  labelFontSize?: number;
  /** Label text color (default: inherits from stroke or '#000000') */
  labelColor?: string;
  /** Label background color (default: transparent) */
  labelBackground?: string;
  /** Label horizontal offset from center (default: 0) */
  labelOffsetX?: number;
  /** Label vertical offset from center (default: 0) */
  labelOffsetY?: number;
  /** How the label behaves when it overflows the shape (default: 'overflow') */
  labelOverflow?: LabelOverflow;
  /** Icon ID (reference to icon library: 'builtin:name' or blob ID) */
  iconId?: string;
  /** Icon size in pixels (default: 24) */
  iconSize?: number;
  /** Icon padding from corner (default: 8) */
  iconPadding?: number;
  /** Icon color override (default: uses original icon colors) */
  iconColor?: string;
  /** Icon position (default: 'top-left') */
  iconPosition?: IconPosition;
  /** Icon display mode (default: 'inside') */
  iconDisplayMode?: IconDisplayMode;
  /** Badge configuration (only used when iconDisplayMode = 'badge') */
  iconBadge?: IconBadgeConfig;
  /** Multiple icons configuration (overrides single icon properties when present) */
  icons?: IconConfig[];
}

/**
 * Icon position options.
 *
 * Corner positions: top-left, top-right, bottom-left, bottom-right
 * Edge-center positions: left, right, top, bottom
 * Center: center
 * Outer positions (for badges): top-left-outer, top-right-outer, bottom-left-outer, bottom-right-outer
 */
export type IconPosition =
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | 'center'
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'top-left-outer'
  | 'top-right-outer'
  | 'bottom-left-outer'
  | 'bottom-right-outer';

/**
 * Icon display mode options.
 */
export type IconDisplayMode = 'inside' | 'badge' | 'icon-only';

/**
 * Badge shape options for icon badges.
 */
export type IconBadgeShape = 'circle' | 'rounded-rect' | 'square';

/**
 * Configuration for icon badge styling.
 */
export interface IconBadgeConfig {
  /** Badge shape (default: 'circle') */
  shape: IconBadgeShape;
  /** Badge background color (default: '#ffffff') */
  backgroundColor: string;
  /** Badge border color (null = no border) */
  borderColor?: string;
  /** Badge border width (default: 0) */
  borderWidth?: number;
  /** Internal padding between badge edge and icon (default: 4) */
  padding?: number;
  /** Whether to show drop shadow (default: false) */
  shadow?: boolean;
}

/**
 * Configuration for a single icon on a shape.
 * Used in the icons[] array for multi-icon support.
 */
export interface IconConfig {
  /** Icon ID (reference to icon library: 'builtin:name' or blob ID) */
  iconId: string;
  /** Icon size in pixels (default: 24) */
  size?: number;
  /** Icon padding from shape edge (default: 8) */
  padding?: number;
  /** Icon color override (default: uses stroke color) */
  color?: string;
  /** Icon position on shape (default: 'top-left') */
  position: IconPosition;
  /** Display mode (default: 'inside') */
  displayMode?: IconDisplayMode;
  /** Badge configuration (only used when displayMode = 'badge') */
  badge?: IconBadgeConfig;
}

/**
 * Default badge configuration.
 */
export const DEFAULT_BADGE_CONFIG: IconBadgeConfig = {
  shape: 'circle',
  backgroundColor: '#ffffff',
  borderWidth: 0,
  padding: 4,
  shadow: false,
};

/**
 * Ellipse shape (circle when radiusX === radiusY).
 */
export interface EllipseShape extends BaseShape {
  type: 'ellipse';
  /** Horizontal radius in world units */
  radiusX: number;
  /** Vertical radius in world units */
  radiusY: number;
  /** Optional inline text label */
  label?: string;
  /** Label font size in world units (default: 14) */
  labelFontSize?: number;
  /** Label text color (default: inherits from stroke or '#000000') */
  labelColor?: string;
  /** Label background color (default: transparent) */
  labelBackground?: string;
  /** Label horizontal offset from center (default: 0) */
  labelOffsetX?: number;
  /** Label vertical offset from center (default: 0) */
  labelOffsetY?: number;
  /** How the label behaves when it overflows the shape (default: 'overflow') */
  labelOverflow?: LabelOverflow;
  /** Icon ID (reference to icon library: 'builtin:name' or blob ID) */
  iconId?: string;
  /** Icon size in pixels (default: 24) */
  iconSize?: number;
  /** Icon padding from corner (default: 8) */
  iconPadding?: number;
  /** Icon color override (default: uses original icon colors) */
  iconColor?: string;
  /** Icon position (default: 'top-left') */
  iconPosition?: IconPosition;
  /** Icon display mode (default: 'inside') */
  iconDisplayMode?: IconDisplayMode;
  /** Badge configuration (only used when iconDisplayMode = 'badge') */
  iconBadge?: IconBadgeConfig;
  /** Multiple icons configuration (overrides single icon properties when present) */
  icons?: IconConfig[];
}

/**
 * Line shape with optional arrows.
 */
export interface LineShape extends BaseShape {
  type: 'line';
  /** End point X coordinate in world units */
  x2: number;
  /** End point Y coordinate in world units */
  y2: number;
  /** Whether to draw an arrow at the start point */
  startArrow: boolean;
  /** Whether to draw an arrow at the end point */
  endArrow: boolean;
  /** Optional inline text label, rendered at the line's midpoint */
  label?: string;
  /** Label font size in world units (default: 12) */
  labelFontSize?: number;
  /** Label text color (default: inherits from stroke or '#000000') */
  labelColor?: string;
  /** Label background color (default: transparent) */
  labelBackground?: string;
  /** Label horizontal offset from the midpoint (default: 0) */
  labelOffsetX?: number;
  /** Label vertical offset from the midpoint (default: 0) */
  labelOffsetY?: number;
  /** How the label behaves when it overflows (default: 'overflow') */
  labelOverflow?: LabelOverflow;
}

/**
 * Routing mode for connectors.
 */
export type RoutingMode = 'straight' | 'orthogonal' | 'curved';

/**
 * ERD (Entity-Relationship Diagram) cardinality notation.
 * Used for Crow's Foot notation on connector endpoints.
 */
export type ERDCardinality =
  | 'none'      // No cardinality symbol (default arrow behavior)
  | 'one'       // Single vertical line (exactly one)
  | 'many'      // Crow's foot (many)
  | 'zero-one'  // Circle + line (zero or one)
  | 'zero-many' // Circle + crow's foot (zero or many)
  | 'one-many'; // Line + crow's foot (one or many)

/**
 * Connector type for diagram-specific connector behavior.
 * Determines which marker/cardinality systems are available.
 */
export type ConnectorType =
  | 'default'       // Standard connector with arrows
  | 'erd'           // ERD Crow's Foot notation
  | 'uml-class'     // UML Class Diagram relationships
  | 'uml-sequence'; // Future: UML Sequence Diagram

/**
 * Line style for connectors.
 */
export type LineStyle = 'solid' | 'dashed';

/**
 * Flow type for activity diagram connectors.
 * Control flow is solid line, object flow is dashed.
 */
export type FlowType = 'control' | 'object';

/**
 * UML Class Diagram marker styles for connector endpoints.
 * Used for start and end markers on UML class connectors.
 */
export type UMLClassMarker =
  | 'none'              // No marker
  | 'arrow'             // Open arrow (V shape) - for navigable association
  | 'triangle'          // Hollow triangle - for inheritance/generalization
  | 'triangle-filled'   // Filled triangle - rarely used, but available
  | 'diamond'           // Hollow diamond - for aggregation
  | 'diamond-filled'    // Filled diamond - for composition
  | 'circle'            // Small circle - for interface ball notation
  | 'socket';           // Arc/socket - for interface socket notation

/**
 * UML Sequence Diagram marker styles for connector endpoints.
 * Used for message arrows in sequence diagrams.
 */
export type UMLSequenceMarker =
  | 'none'              // No marker
  | 'sync'              // Filled triangle arrow - synchronous call
  | 'async'             // Open arrow (V shape) - asynchronous message
  | 'reply'             // Open arrow with dashed line - return message
  | 'create'            // Dashed line with filled arrow - object creation
  | 'destroy'           // X marker - object destruction
  | 'lost'              // Filled circle - lost message
  | 'found';            // Filled circle at start - found message

/**
 * Per-endpoint arrowhead style for plain (non-UML/ERD) connectors.
 * 'none' means no arrowhead is drawn at that endpoint.
 */
export type ArrowStyle = 'none' | 'triangle' | 'open' | 'diamond';

/**
 * Resolve a connector endpoint's arrow style, honouring the legacy boolean
 * fields (`startArrow` / `endArrow`) when the new `*ArrowStyle` field is
 * absent. Older documents predate per-endpoint styles, so without this
 * fallback they would silently lose their arrowheads.
 */
export function resolveArrowStyle(
  shape: Pick<ConnectorShape, 'startArrow' | 'endArrow' | 'startArrowStyle' | 'endArrowStyle'>,
  end: 'start' | 'end',
): ArrowStyle {
  const style = end === 'start' ? shape.startArrowStyle : shape.endArrowStyle;
  if (style !== undefined) return style;
  const bool = end === 'start' ? shape.startArrow : shape.endArrow;
  return bool ? 'triangle' : 'none';
}

/**
 * Connector shape that connects two shapes.
 */
export interface ConnectorShape extends BaseShape {
  type: 'connector';
  /** ID of the shape at the start, or null for floating endpoint */
  startShapeId: string | null;
  /** Anchor position on the start shape */
  startAnchor: AnchorPosition;
  /** ID of the shape at the end, or null for floating endpoint */
  endShapeId: string | null;
  /** Anchor position on the end shape */
  endAnchor: AnchorPosition;
  /** End point X coordinate (used when endShapeId is null, or cached position) */
  x2: number;
  /** End point Y coordinate (used when endShapeId is null, or cached position) */
  y2: number;
  /**
   * Whether to draw an arrow at the start point.
   * @deprecated Use {@link startArrowStyle}. Kept so older documents still
   * render their arrowheads through {@link resolveArrowStyle}.
   */
  startArrow: boolean;
  /**
   * Whether to draw an arrow at the end point.
   * @deprecated Use {@link endArrowStyle}.
   */
  endArrow: boolean;
  /** Arrowhead style at the start endpoint (overrides {@link startArrow}). */
  startArrowStyle?: ArrowStyle;
  /** Arrowhead style at the end endpoint (overrides {@link endArrow}). */
  endArrowStyle?: ArrowStyle;
  /** Routing mode: straight line, orthogonal (right-angle), or curved (smoothed) path */
  routingMode?: RoutingMode;
  /** Waypoints for orthogonal/curved routing (intermediate points between start and end) */
  waypoints?: Array<{ x: number; y: number }>;
  /** Text label displayed on the connector */
  label?: string;
  /** Font size for the label (default: 12) */
  labelFontSize?: number;
  /** Color for the label (default: stroke color or black) */
  labelColor?: string;
  /** Outline (stroke) color drawn around the label text for legibility. Unset = no outline. */
  labelStrokeColor?: string;
  /** Label background color (default: transparent) */
  labelBackground?: string;
  /** Position of label along the path, 0-1 (default: 0.5 = midpoint) */
  labelPosition?: number;
  /** Label horizontal offset from calculated position (default: 0) */
  labelOffsetX?: number;
  /** Label vertical offset from calculated position (default: 0) */
  labelOffsetY?: number;
  /** How the label behaves when it overflows (default: 'overflow') */
  labelOverflow?: LabelOverflow;
  /** ERD cardinality notation at start point (overrides startArrow) */
  startCardinality?: ERDCardinality;
  /** ERD cardinality notation at end point (overrides endArrow) */
  endCardinality?: ERDCardinality;
  /** Connector type for diagram-specific behavior */
  connectorType?: ConnectorType;
  /** Line style: solid or dashed */
  lineStyle?: LineStyle;
  /** UML Class marker at start point (used when connectorType is 'uml-class') */
  startUMLMarker?: UMLClassMarker;
  /** UML Class marker at end point (used when connectorType is 'uml-class') */
  endUMLMarker?: UMLClassMarker;
  /** UML Sequence marker at start point (used when connectorType is 'uml-sequence') */
  startSequenceMarker?: UMLSequenceMarker;
  /** UML Sequence marker at end point (used when connectorType is 'uml-sequence') */
  endSequenceMarker?: UMLSequenceMarker;
  /** Guard condition label (shown as [condition]) for activity diagrams */
  guardCondition?: string;
  /** Guard condition position along path, 0-1 (default: 0.2 = near start) */
  guardPosition?: number;
  /** Flow type for activity diagrams: control (solid) or object (dashed) */
  flowType?: FlowType;
  /** Message number for sequence diagrams (e.g., "1", "2.1") */
  messageNumber?: string;
  /** Self-message loop width when startShapeId === endShapeId (default: 30) */
  selfMessageWidth?: number;
}

/**
 * Horizontal text alignment options.
 */
export type TextAlign = 'left' | 'center' | 'right';

/**
 * Vertical text alignment options.
 */
export type VerticalAlign = 'top' | 'middle' | 'bottom';

/**
 * Text shape for displaying text blocks.
 */
export interface TextShape extends BaseShape {
  type: 'text';
  /** Text content */
  text: string;
  /** Font size in world units */
  fontSize: number;
  /** Font family (CSS font-family) */
  fontFamily: string;
  /** Horizontal text alignment within the text box */
  textAlign: TextAlign;
  /** Vertical text alignment within the text box */
  verticalAlign: VerticalAlign;
  /** Text box width for text wrapping */
  width: number;
  /** Text box height for vertical alignment */
  height: number;
}

/**
 * Group shape that contains other shapes.
 * Groups allow multiple shapes to be selected, moved, and transformed as a unit.
 * Groups can optionally have visual styling (background, border, labels, shadows).
 */
export interface GroupShape extends BaseShape {
  type: 'group';
  /** IDs of child shapes (can include other groups for nesting) */
  childIds: string[];
  /** Optional name for the group (displayed in layer panel) */
  name?: string;
  /** Optional color badge for visual organization in LayerPanel (not rendered on canvas) */
  layerColor?: string;

  // Ownership fields (Phase 14.1 - Team mode)
  /** User ID who owns this group (null = SYSTEM owned, no restrictions) */
  ownerId?: string | null;
  /** Whether the group is locked by the owner (only owner can modify) */
  ownerLocked?: boolean;

  // Background styling
  /** Whether to render a visible background (default: false for invisible container) */
  showBackground?: boolean;
  /** Background fill color */
  backgroundColor?: string;
  /** Pattern configuration for background (stripes, hazard, gradients) */
  patternConfig?: import('./GroupStyles').PatternConfig;
  /** Padding around children in pixels (default: 10) */
  backgroundPadding?: number;

  // Border styling
  /** Border stroke color */
  borderColor?: string;
  /** Border stroke width in pixels (default: 0 = no border) */
  borderWidth?: number;
  /** Border dash pattern (e.g., [8, 4] for dashed) */
  borderDashArray?: number[];
  /** Corner radius for rounded background/border (default: 0) */
  cornerRadius?: number;

  // Label support
  /** Optional text label for the group */
  label?: string;
  /** Label font size in pixels (default: 14) */
  labelFontSize?: number;
  /** Label text color (default: '#000000') */
  labelColor?: string;
  /** Label background color (default: transparent) */
  labelBackground?: string;
  /** Label horizontal offset from position (default: 0) */
  labelOffsetX?: number;
  /** Label vertical offset from position (default: 0) */
  labelOffsetY?: number;
  /** How the label behaves when it overflows (default: 'overflow') */
  labelOverflow?: LabelOverflow;
  /** Label position anchor (default: 'top') */
  labelPosition?: import('./GroupStyles').GroupLabelPosition;

  // Shadow/Glow effects
  /** Shadow configuration */
  shadowConfig?: import('./GroupStyles').ShadowConfig;
}

/**
 * Embedded file shape — displays as a thumbnail + filename on canvas.
 * Content viewed in modal on double-click.
 */
export interface FileShape extends BaseShape {
  type: 'file';
  /** Width in world units */
  width: number;
  /** Height in world units */
  height: number;
  /** Blob storage reference (SHA-256 hash) */
  blobRef: string;
  /** Original filename */
  fileName: string;
  /** MIME type of the embedded file */
  mimeType: string;
  /** File size in bytes */
  fileSize: number;
  /** File category for viewer dispatch */
  fileCategory: FileCategory;
  /** Preview metadata */
  preview?: {
    /** Cached thumbnail as base64 data URL (JPEG) */
    thumbnail?: string;
    /** Number of pages (PDFs, multi-page docs) */
    pageCount?: number;
    /** Original content dimensions in pixels */
    dimensions?: { width: number; height: number };
  };
  /** Optional user-set display label (defaults to fileName) */
  label?: string;
  /** Label font size in world units (default: 12) */
  labelFontSize?: number;
  /** Label text color */
  labelColor?: string;
}

/**
 * Library shape - a generic shape type for shape library extensions.
 *
 * Library shapes use a dynamic type string (e.g., 'diamond', 'terminator')
 * and share common properties: width, height, optional label and icon.
 * The actual rendering is handled by the shape's registered handler.
 */
export interface LibraryShape extends Omit<BaseShape, 'type'> {
  /** Dynamic shape type (e.g., 'diamond', 'terminator', 'parallelogram') */
  type: string;
  /** Width in world units */
  width: number;
  /** Height in world units */
  height: number;
  /** Optional inline text label */
  label?: string;
  /** Label font size in world units (default: 14) */
  labelFontSize?: number;
  /** Label text color (default: inherits from stroke or '#000000') */
  labelColor?: string;
  /** Label background color (default: transparent) */
  labelBackground?: string;
  /** Label horizontal offset from center (default: 0) */
  labelOffsetX?: number;
  /** Label vertical offset from center (default: 0) */
  labelOffsetY?: number;
  /** How the label behaves when it overflows the shape (default: 'overflow') */
  labelOverflow?: LabelOverflow;
  /** Icon ID (reference to icon library: 'builtin:name' or blob ID) */
  iconId?: string;
  /** Icon size in pixels (default: 24) */
  iconSize?: number;
  /** Icon padding from corner (default: 8) */
  iconPadding?: number;
  /** Icon color override (default: uses original icon colors) */
  iconColor?: string;
  /** Icon position (default: 'top-left') */
  iconPosition?: IconPosition;
  /** Icon display mode (default: 'inside') */
  iconDisplayMode?: IconDisplayMode;
  /** Badge configuration (only used when iconDisplayMode = 'badge') */
  iconBadge?: IconBadgeConfig;
  /** Multiple icons configuration (overrides single icon properties when present) */
  icons?: IconConfig[];
  /** Custom properties for specialized shapes (e.g., UML-specific data) */
  customProperties?: Record<string, unknown>;
}

/**
 * Union type of all shape types.
 * Includes core shapes and library shapes.
 */
export type Shape =
  | RectangleShape
  | EllipseShape
  | LineShape
  | TextShape
  | ConnectorShape
  | GroupShape
  | FileShape
  | LibraryShape;

// ============ Type Guards ============

/**
 * Check if a shape is a rectangle.
 */
export function isRectangle(shape: Shape): shape is RectangleShape {
  return shape.type === 'rectangle';
}

/**
 * Check if a shape is an ellipse.
 */
export function isEllipse(shape: Shape): shape is EllipseShape {
  return shape.type === 'ellipse';
}

/**
 * Check if a shape is a line.
 */
export function isLine(shape: Shape): shape is LineShape {
  return shape.type === 'line';
}

/**
 * Check if a shape is a text block.
 */
export function isText(shape: Shape): shape is TextShape {
  return shape.type === 'text';
}

/**
 * Check if a shape is a connector.
 */
export function isConnector(shape: Shape): shape is ConnectorShape {
  return shape.type === 'connector';
}

/**
 * Check if a shape is a group.
 */
export function isGroup(shape: Shape): shape is GroupShape {
  return shape.type === 'group';
}

/**
 * Check if a shape is an embedded file.
 */
export function isFile(shape: Shape): shape is FileShape {
  return shape.type === 'file';
}

/**
 * Check if a shape is a library shape (not a core shape type).
 */
export function isLibraryShape(shape: Shape): shape is LibraryShape {
  return !CORE_SHAPE_TYPES.includes(shape.type as CoreShapeType);
}

/**
 * Check if a type string is a core shape type.
 */
export function isCoreShapeType(type: string): type is CoreShapeType {
  return CORE_SHAPE_TYPES.includes(type as CoreShapeType);
}

// ============ Factory Defaults ============

/**
 * Default style values for new shapes.
 */
export const DEFAULT_SHAPE_STYLE = {
  fill: '#4a90d9',
  stroke: '#2c5282',
  strokeWidth: 2,
  opacity: 1,
  rotation: 0,
  locked: false,
  visible: true,
} as const;

/**
 * Default values for rectangle shapes.
 */
export const DEFAULT_RECTANGLE = {
  ...DEFAULT_SHAPE_STYLE,
  width: 100,
  height: 80,
  cornerRadius: 0,
} as const;

/**
 * Default values for ellipse shapes.
 */
export const DEFAULT_ELLIPSE = {
  ...DEFAULT_SHAPE_STYLE,
  radiusX: 50,
  radiusY: 40,
} as const;

/**
 * Default values for line shapes.
 */
export const DEFAULT_LINE = {
  ...DEFAULT_SHAPE_STYLE,
  fill: null,
  stroke: 'auto',
  strokeWidth: 2,
  startArrow: false,
  endArrow: true,
} as const;

/**
 * Default values for text shapes.
 */
export const DEFAULT_TEXT = {
  ...DEFAULT_SHAPE_STYLE,
  fill: null,
  stroke: null,
  strokeWidth: 0,
  fontSize: 16,
  fontFamily: 'sans-serif',
  textAlign: 'left' as TextAlign,
  verticalAlign: 'top' as VerticalAlign,
  width: 200,
  height: 50,
} as const;

/**
 * Default values for connector shapes.
 */
export const DEFAULT_CONNECTOR = {
  ...DEFAULT_SHAPE_STYLE,
  fill: null,
  stroke: 'auto',
  strokeWidth: 2,
  startShapeId: null,
  startAnchor: 'center' as AnchorPosition,
  endShapeId: null,
  endAnchor: 'center' as AnchorPosition,
  startArrow: false,
  endArrow: true,
  startArrowStyle: 'none' as ArrowStyle,
  endArrowStyle: 'triangle' as ArrowStyle,
  routingMode: 'straight' as RoutingMode,
  connectorType: 'default' as ConnectorType,
  lineStyle: 'solid' as LineStyle,
} as const;

/**
 * Default values for file shapes.
 */
export const DEFAULT_FILE_SHAPE = {
  width: 200,
  height: 160,
  fill: '#f8fafc',
  stroke: '#cbd5e1',
  strokeWidth: 1,
  labelFontSize: 12,
  labelColor: '#475569',
} as const;

/**
 * Default values for group shapes.
 * By default, groups are invisible containers. Enable showBackground for visual styling.
 */
export const DEFAULT_GROUP = {
  ...DEFAULT_SHAPE_STYLE,
  fill: null,
  stroke: null,
  strokeWidth: 0,
  childIds: [] as string[],
  // Background defaults
  showBackground: false,
  backgroundColor: '#ffffff',
  backgroundPadding: 10,
  // Border defaults
  borderWidth: 0,
  cornerRadius: 0,
  // Label defaults
  labelFontSize: 14,
  labelColor: '#000000',
  labelPosition: 'top' as import('./GroupStyles').GroupLabelPosition,
} as const;

/**
 * Default values for library shapes.
 * Library shapes share common properties with rectangles.
 */
export const DEFAULT_LIBRARY_SHAPE = {
  ...DEFAULT_SHAPE_STYLE,
  width: 100,
  height: 80,
  labelFontSize: 14,
  iconSize: 24,
  iconPadding: 8,
} as const;
