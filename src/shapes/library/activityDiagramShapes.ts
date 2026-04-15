/**
 * UML Activity Diagram shape definitions.
 *
 * This module defines shapes for creating UML activity diagrams:
 * - Action (rounded rectangle for activities)
 * - Initial node (filled black circle)
 * - Final node (double circle with filled inner)
 * - Flow final (circle with X)
 * - Fork/Join bar (thick horizontal/vertical bar)
 * - Decision/Merge (reuse diamond from flowchart)
 */

import type { LibraryShapeDefinition, CustomRenderFunction, AnchorDefinition } from './ShapeLibraryTypes';
import { createStandardAnchors } from './ShapeLibraryTypes';
import { createStandardProperties } from '../ShapeMetadata';
import type { PropertyDefinition } from '../ShapeMetadata';
import type { LibraryShape } from '../Shape';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Action type variants for different UML action types.
 */
export type ActionType = 'simple' | 'callBehavior' | 'callOperation';

/**
 * Action custom properties interface.
 */
export interface ActionProperties {
  actionType?: ActionType;
  behaviorName?: string;      // For callBehavior actions
  operationName?: string;     // For callOperation actions
  showRake?: boolean;         // Show rake symbol for callBehavior
  precondition?: string;      // UML precondition constraint
  postcondition?: string;     // UML postcondition constraint
}

/**
 * Fork/Join custom properties interface.
 */
export interface ForkJoinProperties {
  joinSpec?: string;          // Join specification condition text
}

// ============================================================================
// Action Shape (Rounded Rectangle)
// ============================================================================

/**
 * Draw rake (trident) symbol for call behavior actions.
 */
function drawRakeSymbol(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, stroke: string): void {
  const hw = size / 2;
  const hh = size / 2;
  const prongs = 3;
  const prongSpacing = size / (prongs + 1);

  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;

  // Draw handle (vertical line at bottom)
  ctx.beginPath();
  ctx.moveTo(x, y + hh);
  ctx.lineTo(x, y);
  ctx.stroke();

  // Draw prongs
  for (let i = 1; i <= prongs; i++) {
    const px = x - hw + i * prongSpacing;
    ctx.beginPath();
    ctx.moveTo(px, y);
    ctx.lineTo(px, y - hh);
    ctx.stroke();
  }
}

/**
 * Custom render function for activity action.
 * Rounded rectangle with label centered.
 * Supports call behavior (rake symbol), call operation, and constraints.
 */
const renderAction: CustomRenderFunction = (ctx, shape) => {
  const { width, height, stroke, fill } = shape;
  const hw = width / 2;
  const hh = height / 2;
  const radius = Math.min(hw, hh) * 0.3;

  // Get custom properties
  const customProps = shape.customProperties as ActionProperties | undefined;
  const actionType = customProps?.actionType || 'simple';
  const behaviorName = customProps?.behaviorName || '';
  const operationName = customProps?.operationName || '';
  const showRake = customProps?.showRake ?? (actionType === 'callBehavior');
  const precondition = customProps?.precondition || '';
  const postcondition = customProps?.postcondition || '';

  // Draw rounded rectangle
  ctx.beginPath();
  ctx.moveTo(-hw + radius, -hh);
  ctx.lineTo(hw - radius, -hh);
  ctx.arcTo(hw, -hh, hw, -hh + radius, radius);
  ctx.lineTo(hw, hh - radius);
  ctx.arcTo(hw, hh, hw - radius, hh, radius);
  ctx.lineTo(-hw + radius, hh);
  ctx.arcTo(-hw, hh, -hw, hh - radius, radius);
  ctx.lineTo(-hw, -hh + radius);
  ctx.arcTo(-hw, -hh, -hw + radius, -hh, radius);
  ctx.closePath();

  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = shape.strokeWidth || 1;
    ctx.stroke();
  }

  // Draw rake symbol for call behavior actions
  if (showRake && actionType === 'callBehavior') {
    const rakeSize = 14;
    drawRakeSymbol(ctx, hw - rakeSize - 5, hh - rakeSize - 3, rakeSize, stroke || '#000000');
  }

  // Determine label text based on action type
  let labelText = shape.label || '';
  if (actionType === 'callBehavior' && behaviorName) {
    labelText = behaviorName;
  } else if (actionType === 'callOperation' && operationName) {
    labelText = operationName;
  }

  // Draw label
  const fontSize = shape.labelFontSize || 14;
  ctx.fillStyle = shape.labelColor || stroke || '#000000';
  ctx.font = `${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (labelText) {
    // Offset label up if we have constraints below
    const hasConstraints = precondition || postcondition;
    const labelY = hasConstraints ? -height * 0.1 : 0;
    const labelMaxWidth = showRake ? width - 40 : width - 20;
    ctx.fillText(labelText, 0, labelY, labelMaxWidth);
  }

  // Draw precondition and postcondition as small annotations
  const constraintFontSize = Math.min(10, fontSize * 0.7);
  ctx.font = `${constraintFontSize}px sans-serif`;

  if (precondition) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`«precondition» ${precondition}`, -hw + 8, -hh - constraintFontSize - 4, width - 16);
  }

  if (postcondition) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`«postcondition» ${postcondition}`, -hw + 8, hh + constraintFontSize + 4, width - 16);
  }
};

/**
 * Action shape properties with call behavior/operation support.
 */
const actionProperties: PropertyDefinition[] = [
  ...createStandardProperties({ includeLabel: true }),
  {
    key: 'customProperties.actionType',
    label: 'Action Type',
    type: 'select',
    section: 'custom',
    options: [
      { value: 'simple', label: 'Simple Action' },
      { value: 'callBehavior', label: 'Call Behavior' },
      { value: 'callOperation', label: 'Call Operation' },
    ],
    default: 'simple',
  },
  {
    key: 'customProperties.behaviorName',
    label: 'Behavior Name',
    type: 'string',
    section: 'custom',
    placeholder: 'BehaviorName',
    helpText: 'Name of behavior to invoke (for Call Behavior)',
  },
  {
    key: 'customProperties.operationName',
    label: 'Operation Name',
    type: 'string',
    section: 'custom',
    placeholder: 'operationName()',
    helpText: 'Operation signature (for Call Operation)',
  },
  {
    key: 'customProperties.showRake',
    label: 'Show Rake Symbol',
    type: 'boolean',
    section: 'custom',
    default: true,
    helpText: 'Show rake (trident) symbol for Call Behavior',
  },
  {
    key: 'customProperties.precondition',
    label: 'Precondition',
    type: 'string',
    section: 'custom',
    placeholder: 'x > 0',
    helpText: 'UML precondition constraint',
  },
  {
    key: 'customProperties.postcondition',
    label: 'Postcondition',
    type: 'string',
    section: 'custom',
    placeholder: 'result != null',
    helpText: 'UML postcondition constraint',
  },
];

/**
 * Action shape - rounded rectangle for activity nodes.
 */
export const activityActionShape: LibraryShapeDefinition = {
  type: 'activity-action',
  metadata: {
    type: 'activity-action',
    name: 'Action',
    category: 'uml-activity',
    icon: '▢',
    properties: actionProperties,
    supportsLabel: true,
    supportsIcon: true,
    defaultWidth: 120,
    defaultHeight: 60,
    description: 'Activity action node with rounded corners',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    const hw = width / 2;
    const hh = height / 2;
    const radius = Math.min(hw, hh) * 0.3;

    path.moveTo(-hw + radius, -hh);
    path.lineTo(hw - radius, -hh);
    path.arcTo(hw, -hh, hw, -hh + radius, radius);
    path.lineTo(hw, hh - radius);
    path.arcTo(hw, hh, hw - radius, hh, radius);
    path.lineTo(-hw + radius, hh);
    path.arcTo(-hw, hh, -hw, hh - radius, radius);
    path.lineTo(-hw, -hh + radius);
    path.arcTo(-hw, -hh, -hw + radius, -hh, radius);
    path.closePath();

    return path;
  },
  anchors: createStandardAnchors(),
  customRender: renderAction,
  customLabelRendering: true,
  hitTestMode: 'path',
};

// ============================================================================
// Initial Node (Filled Circle)
// ============================================================================

/**
 * Custom render function for initial node.
 * Filled black circle.
 */
const renderInitialNode: CustomRenderFunction = (ctx, shape) => {
  const radius = Math.min(shape.width, shape.height) / 2;

  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fillStyle = shape.stroke || '#000000';
  ctx.fill();
};

/**
 * Initial node - filled black circle (start).
 */
export const activityInitialShape: LibraryShapeDefinition = {
  type: 'activity-initial',
  metadata: {
    type: 'activity-initial',
    name: 'Initial',
    category: 'uml-activity',
    icon: '●',
    properties: createStandardProperties({}),
    supportsLabel: false,
    supportsIcon: false,
    defaultWidth: 20,
    defaultHeight: 20,
    aspectRatioLocked: true,
    description: 'Initial node (filled circle) - activity start',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    const radius = Math.min(width, height) / 2;
    path.arc(0, 0, radius, 0, Math.PI * 2);
    return path;
  },
  anchors: createStandardAnchors(),
  customRender: renderInitialNode,
  hitTestMode: 'path',
};

// ============================================================================
// Final Node (Double Circle)
// ============================================================================

/**
 * Custom render function for final node.
 * Double circle with filled inner.
 */
const renderFinalNode: CustomRenderFunction = (ctx, shape) => {
  const outerRadius = Math.min(shape.width, shape.height) / 2;
  const innerRadius = outerRadius * 0.6;

  // Outer circle (ring)
  ctx.beginPath();
  ctx.arc(0, 0, outerRadius, 0, Math.PI * 2);
  ctx.strokeStyle = shape.stroke || '#000000';
  ctx.lineWidth = shape.strokeWidth || 2;
  ctx.stroke();

  // Inner filled circle
  ctx.beginPath();
  ctx.arc(0, 0, innerRadius, 0, Math.PI * 2);
  ctx.fillStyle = shape.stroke || '#000000';
  ctx.fill();
};

/**
 * Final node - double circle with filled inner (end).
 */
export const activityFinalShape: LibraryShapeDefinition = {
  type: 'activity-final',
  metadata: {
    type: 'activity-final',
    name: 'Final',
    category: 'uml-activity',
    icon: '◉',
    properties: createStandardProperties({}),
    supportsLabel: false,
    supportsIcon: false,
    defaultWidth: 24,
    defaultHeight: 24,
    aspectRatioLocked: true,
    description: 'Final node (double circle) - activity end',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    const radius = Math.min(width, height) / 2;
    path.arc(0, 0, radius, 0, Math.PI * 2);
    return path;
  },
  anchors: createStandardAnchors(),
  customRender: renderFinalNode,
  hitTestMode: 'path',
};

// ============================================================================
// Flow Final Node (Circle with X)
// ============================================================================

/**
 * Custom render function for flow final node.
 * Circle with X inside.
 */
const renderFlowFinalNode: CustomRenderFunction = (ctx, shape) => {
  const radius = Math.min(shape.width, shape.height) / 2;
  const xSize = radius * 0.5;

  // Circle
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.strokeStyle = shape.stroke || '#000000';
  ctx.lineWidth = shape.strokeWidth || 2;
  ctx.stroke();

  // X inside
  ctx.beginPath();
  ctx.moveTo(-xSize, -xSize);
  ctx.lineTo(xSize, xSize);
  ctx.moveTo(-xSize, xSize);
  ctx.lineTo(xSize, -xSize);
  ctx.stroke();
};

/**
 * Flow final node - circle with X (flow termination).
 */
export const activityFlowFinalShape: LibraryShapeDefinition = {
  type: 'activity-flow-final',
  metadata: {
    type: 'activity-flow-final',
    name: 'Flow Final',
    category: 'uml-activity',
    icon: '⊗',
    properties: createStandardProperties({}),
    supportsLabel: false,
    supportsIcon: false,
    defaultWidth: 24,
    defaultHeight: 24,
    aspectRatioLocked: true,
    description: 'Flow final node (circle with X) - flow termination',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    const radius = Math.min(width, height) / 2;
    path.arc(0, 0, radius, 0, Math.PI * 2);
    return path;
  },
  anchors: createStandardAnchors(),
  customRender: renderFlowFinalNode,
  hitTestMode: 'path',
};

// ============================================================================
// Fork/Join Bar
// ============================================================================

/**
 * Custom render function for fork/join bar.
 * Thick solid black bar with optional join specification.
 */
const renderForkJoinBar: CustomRenderFunction = (ctx, shape) => {
  const { width, height, stroke } = shape;
  const hw = width / 2;
  const hh = height / 2;

  // Get custom properties
  const customProps = shape.customProperties as ForkJoinProperties | undefined;
  const joinSpec = customProps?.joinSpec || '';

  ctx.fillStyle = stroke || '#000000';
  ctx.fillRect(-hw, -hh, width, height);

  // Draw join specification if present
  if (joinSpec) {
    const isHorizontal = width > height;
    const fontSize = 10;
    ctx.fillStyle = shape.labelColor || '#000000';
    ctx.font = `${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = isHorizontal ? 'top' : 'middle';

    // Position text below horizontal bar or to the right of vertical bar
    if (isHorizontal) {
      ctx.fillText(`{joinSpec = ${joinSpec}}`, 0, hh + 4, width);
    } else {
      ctx.textAlign = 'left';
      ctx.fillText(`{joinSpec = ${joinSpec}}`, hw + 4, 0, 100);
    }
  }
};

/**
 * Dynamic anchors for fork/join bar - multiple anchors along the bar.
 */
const createForkJoinAnchors = (
  _shape: LibraryShape,
  width: number,
  height: number
): AnchorDefinition[] => {
  const isHorizontal = width > height;
  const anchors: AnchorDefinition[] = [
    { position: 'center', x: () => 0, y: () => 0 },
  ];

  if (isHorizontal) {
    // Horizontal bar - anchors along top and bottom edges
    const numAnchors = 5;
    for (let i = 0; i < numAnchors; i++) {
      const t = (i / (numAnchors - 1)) - 0.5; // -0.5 to 0.5
      anchors.push({
        position: `top-${i}`,
        x: () => t * width,
        y: () => -height / 2,
      });
      anchors.push({
        position: `bottom-${i}`,
        x: () => t * width,
        y: () => height / 2,
      });
    }
  } else {
    // Vertical bar - anchors along left and right edges
    const numAnchors = 5;
    for (let i = 0; i < numAnchors; i++) {
      const t = (i / (numAnchors - 1)) - 0.5;
      anchors.push({
        position: `left-${i}`,
        x: () => -width / 2,
        y: () => t * height,
      });
      anchors.push({
        position: `right-${i}`,
        x: () => width / 2,
        y: () => t * height,
      });
    }
  }

  return anchors;
};

/**
 * Fork/Join bar properties with join specification support.
 */
const forkJoinProperties: PropertyDefinition[] = [
  ...createStandardProperties({}),
  {
    key: 'customProperties.joinSpec',
    label: 'Join Specification',
    type: 'string',
    section: 'custom',
    placeholder: 'and',
    helpText: 'Join condition (e.g., "and", "or", expression)',
  },
];

/**
 * Fork/Join bar - thick solid black bar for concurrent regions.
 */
export const activityForkJoinShape: LibraryShapeDefinition = {
  type: 'activity-fork-join',
  metadata: {
    type: 'activity-fork-join',
    name: 'Fork/Join',
    category: 'uml-activity',
    icon: '▬',
    properties: forkJoinProperties,
    supportsLabel: false,
    supportsIcon: false,
    defaultWidth: 100,
    defaultHeight: 8,
    description: 'Fork or join bar for concurrent regions',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    const hw = width / 2;
    const hh = height / 2;
    path.rect(-hw, -hh, width, height);
    return path;
  },
  anchors: createStandardAnchors(),
  dynamicAnchors: createForkJoinAnchors,
  customRender: renderForkJoinBar,
  hitTestMode: 'bounds',
};

// ============================================================================
// Send Signal Shape
// ============================================================================

/**
 * Custom render function for send signal.
 * Pentagon pointing right (convex polygon).
 */
const renderSendSignal: CustomRenderFunction = (ctx, shape) => {
  const { width, height, stroke, fill } = shape;
  const hw = width / 2;
  const hh = height / 2;
  const arrowIndent = width * 0.2;

  ctx.beginPath();
  ctx.moveTo(-hw, -hh);
  ctx.lineTo(hw - arrowIndent, -hh);
  ctx.lineTo(hw, 0);
  ctx.lineTo(hw - arrowIndent, hh);
  ctx.lineTo(-hw, hh);
  ctx.closePath();

  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = shape.strokeWidth || 1;
    ctx.stroke();
  }

  // Draw label
  const label = shape.label || '';
  if (label) {
    const fontSize = shape.labelFontSize || 12;
    ctx.fillStyle = shape.labelColor || stroke || '#000000';
    ctx.font = `${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, -arrowIndent / 2, 0, width - arrowIndent - 10);
  }
};

/**
 * Send signal shape - pentagon pointing right.
 */
export const activitySendSignalShape: LibraryShapeDefinition = {
  type: 'activity-send-signal',
  metadata: {
    type: 'activity-send-signal',
    name: 'Send Signal',
    category: 'uml-activity',
    icon: '▷',
    properties: createStandardProperties({ includeLabel: true }),
    supportsLabel: true,
    supportsIcon: false,
    defaultWidth: 100,
    defaultHeight: 50,
    description: 'Send signal action',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    const hw = width / 2;
    const hh = height / 2;
    const arrowIndent = width * 0.2;

    path.moveTo(-hw, -hh);
    path.lineTo(hw - arrowIndent, -hh);
    path.lineTo(hw, 0);
    path.lineTo(hw - arrowIndent, hh);
    path.lineTo(-hw, hh);
    path.closePath();

    return path;
  },
  anchors: createStandardAnchors(),
  customRender: renderSendSignal,
  customLabelRendering: true,
  hitTestMode: 'path',
};

// ============================================================================
// Receive Signal Shape
// ============================================================================

/**
 * Custom render function for receive signal.
 * Concave pentagon (notched rectangle).
 */
const renderReceiveSignal: CustomRenderFunction = (ctx, shape) => {
  const { width, height, stroke, fill } = shape;
  const hw = width / 2;
  const hh = height / 2;
  const notchIndent = width * 0.15;

  ctx.beginPath();
  ctx.moveTo(-hw + notchIndent, -hh);
  ctx.lineTo(hw, -hh);
  ctx.lineTo(hw, hh);
  ctx.lineTo(-hw + notchIndent, hh);
  ctx.lineTo(-hw, 0);
  ctx.closePath();

  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = shape.strokeWidth || 1;
    ctx.stroke();
  }

  // Draw label
  const label = shape.label || '';
  if (label) {
    const fontSize = shape.labelFontSize || 12;
    ctx.fillStyle = shape.labelColor || stroke || '#000000';
    ctx.font = `${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, notchIndent / 2, 0, width - notchIndent - 10);
  }
};

/**
 * Receive signal shape - concave pentagon.
 */
export const activityReceiveSignalShape: LibraryShapeDefinition = {
  type: 'activity-receive-signal',
  metadata: {
    type: 'activity-receive-signal',
    name: 'Receive Signal',
    category: 'uml-activity',
    icon: '◁',
    properties: createStandardProperties({ includeLabel: true }),
    supportsLabel: true,
    supportsIcon: false,
    defaultWidth: 100,
    defaultHeight: 50,
    description: 'Receive signal action',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    const hw = width / 2;
    const hh = height / 2;
    const notchIndent = width * 0.15;

    path.moveTo(-hw + notchIndent, -hh);
    path.lineTo(hw, -hh);
    path.lineTo(hw, hh);
    path.lineTo(-hw + notchIndent, hh);
    path.lineTo(-hw, 0);
    path.closePath();

    return path;
  },
  anchors: createStandardAnchors(),
  customRender: renderReceiveSignal,
  customLabelRendering: true,
  hitTestMode: 'path',
};

// ============================================================================
// Swimlane Shape
// ============================================================================

/**
 * Partition type for UML activity partitions.
 */
export type PartitionType = 'dimension' | 'external';

/**
 * Swimlane custom properties interface.
 */
export interface SwimlaneProperties {
  /** Orientation: 'horizontal' = vertical lanes (columns), 'vertical' = horizontal lanes (rows) */
  orientation?: 'horizontal' | 'vertical';
  /** Lane headers (array of strings) */
  laneHeaders?: string[];
  /** Header height for horizontal orientation / header width for vertical orientation */
  headerSize?: number;
  /** Header background color */
  headerBackground?: string;
  /** Lane separator color */
  separatorColor?: string;
  /** Lane separator width */
  separatorWidth?: number;
  /** Custom lane widths (proportional weights) */
  laneWidths?: number[];
  /** Per-lane background colors */
  laneColors?: string[];
  /** Partition type (dimension or external) */
  partitionType?: PartitionType;
  /** Show nested partition indicators */
  showNestedPartitions?: boolean;
}

/**
 * Default swimlane properties.
 */
const DEFAULT_SWIMLANE: Required<SwimlaneProperties> = {
  orientation: 'horizontal',
  laneHeaders: ['Lane 1', 'Lane 2'],
  headerSize: 30,
  headerBackground: '#e0e0e0',
  separatorColor: '#000000',
  separatorWidth: 1,
  laneWidths: [],
  laneColors: [],
  partitionType: 'dimension',
  showNestedPartitions: false,
};

/**
 * Get swimlane properties from shape, with defaults.
 */
function getSwimlaneProps(shape: LibraryShape): Required<SwimlaneProperties> {
  const props = shape.customProperties as SwimlaneProperties | undefined;
  return {
    orientation: props?.orientation ?? DEFAULT_SWIMLANE.orientation,
    laneHeaders: props?.laneHeaders ?? DEFAULT_SWIMLANE.laneHeaders,
    headerSize: props?.headerSize ?? DEFAULT_SWIMLANE.headerSize,
    headerBackground: props?.headerBackground ?? DEFAULT_SWIMLANE.headerBackground,
    separatorColor: props?.separatorColor ?? DEFAULT_SWIMLANE.separatorColor,
    separatorWidth: props?.separatorWidth ?? DEFAULT_SWIMLANE.separatorWidth,
    laneWidths: props?.laneWidths ?? DEFAULT_SWIMLANE.laneWidths,
    laneColors: props?.laneColors ?? DEFAULT_SWIMLANE.laneColors,
    partitionType: props?.partitionType ?? DEFAULT_SWIMLANE.partitionType,
    showNestedPartitions: props?.showNestedPartitions ?? DEFAULT_SWIMLANE.showNestedPartitions,
  };
}

/**
 * Calculate lane sizes based on weights or equal distribution.
 */
function calculateLaneSizes(totalSize: number, numLanes: number, weights: number[]): number[] {
  if (weights.length === 0 || weights.length !== numLanes) {
    // Equal distribution
    return Array(numLanes).fill(totalSize / numLanes);
  }
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  return weights.map(w => (w / totalWeight) * totalSize);
}

/**
 * Custom render function for swimlane.
 * Draws a container with labeled lanes.
 */
const renderSwimlane: CustomRenderFunction = (ctx, shape) => {
  const { width, height, stroke, fill } = shape;
  const hw = width / 2;
  const hh = height / 2;
  const props = getSwimlaneProps(shape);
  const numLanes = props.laneHeaders.length || 2;

  // Draw main border
  ctx.beginPath();
  ctx.rect(-hw, -hh, width, height);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  ctx.strokeStyle = stroke || '#000000';
  ctx.lineWidth = shape.strokeWidth || 1;
  ctx.stroke();

  // Draw partition type indicator for external partitions
  if (props.partitionType === 'external') {
    const fontSize = 10;
    ctx.fillStyle = shape.labelColor || stroke || '#000000';
    ctx.font = `italic ${fontSize}px sans-serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText('«external»', hw - 4, -hh + 2, width - 8);
  }

  if (props.orientation === 'horizontal') {
    // Vertical lanes (columns) with header row at top
    const headerHeight = props.headerSize;
    const laneSizes = calculateLaneSizes(width, numLanes, props.laneWidths);

    // Draw header background
    ctx.fillStyle = props.headerBackground;
    ctx.fillRect(-hw, -hh, width, headerHeight);

    // Draw header/content separator
    ctx.strokeStyle = props.separatorColor;
    ctx.lineWidth = props.separatorWidth;
    ctx.beginPath();
    ctx.moveTo(-hw, -hh + headerHeight);
    ctx.lineTo(hw, -hh + headerHeight);
    ctx.stroke();

    // Draw lane separators, backgrounds, and headers
    let laneX = -hw;
    for (let i = 0; i < numLanes; i++) {
      const laneWidth = laneSizes[i] ?? width / numLanes;

      // Draw lane background color if specified
      const laneColor = props.laneColors[i];
      if (laneColor) {
        ctx.fillStyle = laneColor;
        ctx.fillRect(laneX, -hh + headerHeight, laneWidth, height - headerHeight);
      }

      // Draw vertical separator (skip first)
      if (i > 0) {
        ctx.strokeStyle = props.separatorColor;
        ctx.lineWidth = props.separatorWidth;
        ctx.beginPath();
        ctx.moveTo(laneX, -hh);
        ctx.lineTo(laneX, hh);
        ctx.stroke();
      }

      // Draw header text
      const header = props.laneHeaders[i] || `Lane ${i + 1}`;
      ctx.fillStyle = shape.labelColor || stroke || '#000000';
      ctx.font = `${shape.labelFontSize || 12}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(header, laneX + laneWidth / 2, -hh + headerHeight / 2, laneWidth - 8);

      laneX += laneWidth;
    }

    // Draw nested partition indicator if enabled
    if (props.showNestedPartitions) {
      ctx.strokeStyle = props.separatorColor;
      ctx.setLineDash([4, 2]);
      ctx.beginPath();
      ctx.moveTo(-hw + 10, -hh + headerHeight + 10);
      ctx.lineTo(hw - 10, -hh + headerHeight + 10);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  } else {
    // Horizontal lanes (rows) with header column at left
    const headerWidth = props.headerSize;
    const laneSizes = calculateLaneSizes(height, numLanes, props.laneWidths);

    // Draw header background
    ctx.fillStyle = props.headerBackground;
    ctx.fillRect(-hw, -hh, headerWidth, height);

    // Draw header/content separator
    ctx.strokeStyle = props.separatorColor;
    ctx.lineWidth = props.separatorWidth;
    ctx.beginPath();
    ctx.moveTo(-hw + headerWidth, -hh);
    ctx.lineTo(-hw + headerWidth, hh);
    ctx.stroke();

    // Draw lane separators, backgrounds, and headers
    let laneY = -hh;
    for (let i = 0; i < numLanes; i++) {
      const laneHeight = laneSizes[i] ?? height / numLanes;

      // Draw lane background color if specified
      const laneColorV = props.laneColors[i];
      if (laneColorV) {
        ctx.fillStyle = laneColorV;
        ctx.fillRect(-hw + headerWidth, laneY, width - headerWidth, laneHeight);
      }

      // Draw horizontal separator (skip first)
      if (i > 0) {
        ctx.strokeStyle = props.separatorColor;
        ctx.lineWidth = props.separatorWidth;
        ctx.beginPath();
        ctx.moveTo(-hw, laneY);
        ctx.lineTo(hw, laneY);
        ctx.stroke();
      }

      // Draw header text
      const header = props.laneHeaders[i] || `Lane ${i + 1}`;
      ctx.fillStyle = shape.labelColor || stroke || '#000000';
      ctx.font = `${shape.labelFontSize || 12}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(header, -hw + headerWidth / 2, laneY + laneHeight / 2, headerWidth - 8);

      laneY += laneHeight;
    }

    // Draw nested partition indicator if enabled
    if (props.showNestedPartitions) {
      ctx.strokeStyle = props.separatorColor;
      ctx.setLineDash([4, 2]);
      ctx.beginPath();
      ctx.moveTo(-hw + headerWidth + 10, -hh + 10);
      ctx.lineTo(-hw + headerWidth + 10, hh - 10);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
};

/**
 * Dynamic anchors for swimlane - connection points at lane boundaries.
 */
const createSwimlaneAnchors = (
  shape: LibraryShape,
  width: number,
  height: number
): AnchorDefinition[] => {
  const props = getSwimlaneProps(shape);
  const numLanes = props.laneHeaders.length || 2;
  const anchors: AnchorDefinition[] = [
    // Corner anchors
    { position: 'top-left', x: () => -width / 2, y: () => -height / 2 },
    { position: 'top-right', x: () => width / 2, y: () => -height / 2 },
    { position: 'bottom-left', x: () => -width / 2, y: () => height / 2 },
    { position: 'bottom-right', x: () => width / 2, y: () => height / 2 },
    { position: 'center', x: () => 0, y: () => 0 },
  ];

  if (props.orientation === 'horizontal') {
    // Add anchors at lane centers (top and bottom)
    const laneWidth = width / numLanes;
    for (let i = 0; i < numLanes; i++) {
      const laneX = -width / 2 + (i + 0.5) * laneWidth;
      anchors.push({
        position: `lane-${i}-top`,
        x: () => laneX,
        y: () => -height / 2,
      });
      anchors.push({
        position: `lane-${i}-bottom`,
        x: () => laneX,
        y: () => height / 2,
      });
    }
  } else {
    // Add anchors at lane centers (left and right)
    const laneHeight = height / numLanes;
    for (let i = 0; i < numLanes; i++) {
      const laneY = -height / 2 + (i + 0.5) * laneHeight;
      anchors.push({
        position: `lane-${i}-left`,
        x: () => -width / 2,
        y: () => laneY,
      });
      anchors.push({
        position: `lane-${i}-right`,
        x: () => width / 2,
        y: () => laneY,
      });
    }
  }

  return anchors;
};

/**
 * Swimlane shape properties with enhanced customization.
 */
const swimlaneProperties: PropertyDefinition[] = [
  ...createStandardProperties({ includeLabel: false }),
  {
    key: 'customProperties.orientation',
    label: 'Orientation',
    type: 'select',
    section: 'custom',
    options: [
      { value: 'horizontal', label: 'Horizontal (columns)' },
      { value: 'vertical', label: 'Vertical (rows)' },
    ],
    default: 'horizontal',
  },
  {
    key: 'customProperties.partitionType',
    label: 'Partition Type',
    type: 'select',
    section: 'custom',
    options: [
      { value: 'dimension', label: 'Dimension (internal)' },
      { value: 'external', label: 'External' },
    ],
    default: 'dimension',
    helpText: 'UML partition classification',
  },
  {
    key: 'customProperties.headerSize',
    label: 'Header Size',
    type: 'number',
    section: 'custom',
    min: 20,
    max: 100,
    step: 5,
    default: 30,
  },
  {
    key: 'customProperties.headerBackground',
    label: 'Header Color',
    type: 'color',
    section: 'custom',
    default: '#e0e0e0',
  },
  {
    key: 'customProperties.separatorColor',
    label: 'Separator Color',
    type: 'color',
    section: 'custom',
    default: '#000000',
  },
  {
    key: 'customProperties.separatorWidth',
    label: 'Separator Width',
    type: 'number',
    section: 'custom',
    min: 1,
    max: 5,
    step: 1,
    default: 1,
  },
  {
    key: 'customProperties.showNestedPartitions',
    label: 'Show Nested Indicator',
    type: 'boolean',
    section: 'custom',
    default: false,
    helpText: 'Show visual indicator for nested partitions',
  },
];

/**
 * Swimlane shape - container with labeled vertical or horizontal lanes.
 */
export const activitySwimlaneShape: LibraryShapeDefinition = {
  type: 'activity-swimlane',
  metadata: {
    type: 'activity-swimlane',
    name: 'Swimlane',
    category: 'uml-activity',
    icon: '▤',
    properties: swimlaneProperties,
    supportsLabel: false,
    supportsIcon: false,
    defaultWidth: 400,
    defaultHeight: 300,
    description: 'Swimlane container for partitioning activity diagrams',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    path.rect(-width / 2, -height / 2, width, height);
    return path;
  },
  anchors: createStandardAnchors(),
  dynamicAnchors: createSwimlaneAnchors,
  customRender: renderSwimlane,
  customLabelRendering: true,
  hitTestMode: 'bounds',
};

// ============================================================================
// Decision Node Shape
// ============================================================================

/**
 * Decision node custom properties.
 */
export interface DecisionProperties {
  decisionInput?: string;
}

/**
 * Custom render function for decision node (diamond).
 */
const renderDecisionNode: CustomRenderFunction = (ctx, shape) => {
  const { width, height, stroke, fill } = shape;
  const hw = width / 2;
  const hh = height / 2;

  // Get custom properties
  const customProps = shape.customProperties as DecisionProperties | undefined;
  const decisionInput = customProps?.decisionInput || '';

  // Draw diamond
  ctx.beginPath();
  ctx.moveTo(0, -hh);
  ctx.lineTo(hw, 0);
  ctx.lineTo(0, hh);
  ctx.lineTo(-hw, 0);
  ctx.closePath();

  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  ctx.strokeStyle = stroke || '#000000';
  ctx.lineWidth = shape.strokeWidth || 1;
  ctx.stroke();

  // Draw decision input if present (as small label above)
  if (decisionInput) {
    const fontSize = 10;
    ctx.fillStyle = shape.labelColor || stroke || '#000000';
    ctx.font = `${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`«decisionInput» ${decisionInput}`, 0, -hh - 4, width + 20);
  }
};

/**
 * Decision node properties.
 */
const decisionProperties: PropertyDefinition[] = [
  ...createStandardProperties({}),
  {
    key: 'customProperties.decisionInput',
    label: 'Decision Input',
    type: 'string',
    section: 'custom',
    placeholder: 'inputName',
    helpText: 'Optional decision input behavior',
  },
];

/**
 * Decision node shape - diamond for branching.
 */
export const activityDecisionShape: LibraryShapeDefinition = {
  type: 'activity-decision',
  metadata: {
    type: 'activity-decision',
    name: 'Decision',
    category: 'uml-activity',
    icon: '◇',
    properties: decisionProperties,
    supportsLabel: false,
    supportsIcon: false,
    defaultWidth: 40,
    defaultHeight: 40,
    aspectRatioLocked: true,
    description: 'Decision node for conditional branching',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    const hw = width / 2;
    const hh = height / 2;
    path.moveTo(0, -hh);
    path.lineTo(hw, 0);
    path.lineTo(0, hh);
    path.lineTo(-hw, 0);
    path.closePath();
    return path;
  },
  anchors: [
    { position: 'center', x: () => 0, y: () => 0 },
    { position: 'top', x: () => 0, y: (_, h) => -h / 2 },
    { position: 'bottom', x: () => 0, y: (_, h) => h / 2 },
    { position: 'left', x: (w) => -w / 2, y: () => 0 },
    { position: 'right', x: (w) => w / 2, y: () => 0 },
  ],
  customRender: renderDecisionNode,
  hitTestMode: 'path',
};

// ============================================================================
// Merge Node Shape
// ============================================================================

/**
 * Custom render function for merge node (diamond without decision input).
 */
const renderMergeNode: CustomRenderFunction = (ctx, shape) => {
  const { width, height, stroke, fill } = shape;
  const hw = width / 2;
  const hh = height / 2;

  // Draw diamond
  ctx.beginPath();
  ctx.moveTo(0, -hh);
  ctx.lineTo(hw, 0);
  ctx.lineTo(0, hh);
  ctx.lineTo(-hw, 0);
  ctx.closePath();

  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  ctx.strokeStyle = stroke || '#000000';
  ctx.lineWidth = shape.strokeWidth || 1;
  ctx.stroke();
};

/**
 * Merge node shape - diamond for merging flows.
 */
export const activityMergeShape: LibraryShapeDefinition = {
  type: 'activity-merge',
  metadata: {
    type: 'activity-merge',
    name: 'Merge',
    category: 'uml-activity',
    icon: '◆',
    properties: createStandardProperties({}),
    supportsLabel: false,
    supportsIcon: false,
    defaultWidth: 40,
    defaultHeight: 40,
    aspectRatioLocked: true,
    description: 'Merge node for combining flows',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    const hw = width / 2;
    const hh = height / 2;
    path.moveTo(0, -hh);
    path.lineTo(hw, 0);
    path.lineTo(0, hh);
    path.lineTo(-hw, 0);
    path.closePath();
    return path;
  },
  anchors: [
    { position: 'center', x: () => 0, y: () => 0 },
    { position: 'top', x: () => 0, y: (_, h) => -h / 2 },
    { position: 'bottom', x: () => 0, y: (_, h) => h / 2 },
    { position: 'left', x: (w) => -w / 2, y: () => 0 },
    { position: 'right', x: (w) => w / 2, y: () => 0 },
  ],
  customRender: renderMergeNode,
  hitTestMode: 'path',
};

// ============================================================================
// Accept Event Action Shape
// ============================================================================

/**
 * Accept event shape - concave pentagon (same as receive signal).
 */
export const activityAcceptEventShape: LibraryShapeDefinition = {
  type: 'activity-accept-event',
  metadata: {
    type: 'activity-accept-event',
    name: 'Accept Event',
    category: 'uml-activity',
    icon: '◁',
    properties: createStandardProperties({ includeLabel: true }),
    supportsLabel: true,
    supportsIcon: false,
    defaultWidth: 100,
    defaultHeight: 50,
    description: 'Accept event action (waits for event)',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    const hw = width / 2;
    const hh = height / 2;
    const notchIndent = width * 0.15;
    path.moveTo(-hw + notchIndent, -hh);
    path.lineTo(hw, -hh);
    path.lineTo(hw, hh);
    path.lineTo(-hw + notchIndent, hh);
    path.lineTo(-hw, 0);
    path.closePath();
    return path;
  },
  anchors: createStandardAnchors(),
  customRender: renderReceiveSignal, // Reuse receive signal render
  customLabelRendering: true,
  hitTestMode: 'path',
};

// ============================================================================
// Accept Time Event Shape (Hourglass)
// ============================================================================

/**
 * Time event custom properties.
 */
export interface TimeEventProperties {
  timeExpression?: string;
}

/**
 * Custom render function for accept time event (hourglass).
 */
const renderTimeEvent: CustomRenderFunction = (ctx, shape) => {
  const { width, height, stroke, fill } = shape;
  const hw = width / 2;
  const hh = height / 2;

  // Get custom properties
  const customProps = shape.customProperties as TimeEventProperties | undefined;
  const timeExpression = customProps?.timeExpression || '';

  // Draw hourglass shape
  ctx.beginPath();
  ctx.moveTo(-hw, -hh);
  ctx.lineTo(hw, -hh);
  ctx.lineTo(0, 0);
  ctx.lineTo(hw, hh);
  ctx.lineTo(-hw, hh);
  ctx.lineTo(0, 0);
  ctx.closePath();

  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  ctx.strokeStyle = stroke || '#000000';
  ctx.lineWidth = shape.strokeWidth || 1;
  ctx.stroke();

  // Draw time expression below if present
  if (timeExpression) {
    const fontSize = 10;
    ctx.fillStyle = shape.labelColor || stroke || '#000000';
    ctx.font = `${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(timeExpression, 0, hh + 4, width + 20);
  }
};

/**
 * Time event properties.
 */
const timeEventProperties: PropertyDefinition[] = [
  ...createStandardProperties({}),
  {
    key: 'customProperties.timeExpression',
    label: 'Time Expression',
    type: 'string',
    section: 'custom',
    placeholder: 'after(5s)',
    helpText: 'Time trigger expression',
  },
];

/**
 * Accept time event shape - hourglass symbol.
 */
export const activityTimeEventShape: LibraryShapeDefinition = {
  type: 'activity-time-event',
  metadata: {
    type: 'activity-time-event',
    name: 'Time Event',
    category: 'uml-activity',
    icon: '⌛',
    properties: timeEventProperties,
    supportsLabel: false,
    supportsIcon: false,
    defaultWidth: 30,
    defaultHeight: 40,
    description: 'Accept time event action (timer trigger)',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    const hw = width / 2;
    const hh = height / 2;
    path.moveTo(-hw, -hh);
    path.lineTo(hw, -hh);
    path.lineTo(0, 0);
    path.lineTo(hw, hh);
    path.lineTo(-hw, hh);
    path.lineTo(0, 0);
    path.closePath();
    return path;
  },
  anchors: [
    { position: 'center', x: () => 0, y: () => 0 },
    { position: 'top', x: () => 0, y: (_, h) => -h / 2 },
    { position: 'bottom', x: () => 0, y: (_, h) => h / 2 },
  ],
  customRender: renderTimeEvent,
  hitTestMode: 'path',
};

// ============================================================================
// Object Node Shape
// ============================================================================

/**
 * Object node custom properties.
 */
export interface ObjectNodeProperties {
  objectName?: string;
  objectType?: string;
  state?: string;
  ordering?: 'FIFO' | 'LIFO' | 'ordered' | 'unordered';
}

/**
 * Custom render function for object node.
 */
const renderObjectNode: CustomRenderFunction = (ctx, shape) => {
  const { width, height, stroke, fill } = shape;
  const hw = width / 2;
  const hh = height / 2;

  // Get custom properties
  const customProps = shape.customProperties as ObjectNodeProperties | undefined;
  const objectName = customProps?.objectName || shape.label || 'object';
  const objectType = customProps?.objectType || '';
  const state = customProps?.state || '';
  const ordering = customProps?.ordering || '';

  // Draw rectangle
  ctx.fillStyle = fill || '#ffffff';
  ctx.fillRect(-hw, -hh, width, height);
  ctx.strokeStyle = stroke || '#000000';
  ctx.lineWidth = shape.strokeWidth || 1;
  ctx.strokeRect(-hw, -hh, width, height);

  // Build label text
  let labelText = objectName;
  if (objectType) {
    labelText = `${objectName} : ${objectType}`;
  }
  if (state) {
    labelText = `${labelText} [${state}]`;
  }

  // Draw label
  const fontSize = shape.labelFontSize || 12;
  ctx.fillStyle = shape.labelColor || stroke || '#000000';
  ctx.font = `${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(labelText, 0, 0, width - 8);

  // Draw ordering annotation if present
  if (ordering) {
    const annotFontSize = 9;
    ctx.font = `${annotFontSize}px sans-serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`{${ordering}}`, hw - 4, hh - 2, width - 8);
  }
};

/**
 * Object node properties.
 */
const objectNodeProperties: PropertyDefinition[] = [
  ...createStandardProperties({ includeLabel: true }),
  {
    key: 'customProperties.objectName',
    label: 'Object Name',
    type: 'string',
    section: 'custom',
    placeholder: 'objectName',
  },
  {
    key: 'customProperties.objectType',
    label: 'Object Type',
    type: 'string',
    section: 'custom',
    placeholder: 'ClassName',
  },
  {
    key: 'customProperties.state',
    label: 'State',
    type: 'string',
    section: 'custom',
    placeholder: 'approved',
    helpText: 'Current state (shown in brackets)',
  },
  {
    key: 'customProperties.ordering',
    label: 'Ordering',
    type: 'select',
    section: 'custom',
    options: [
      { value: '', label: 'None' },
      { value: 'FIFO', label: 'FIFO' },
      { value: 'LIFO', label: 'LIFO' },
      { value: 'ordered', label: 'Ordered' },
      { value: 'unordered', label: 'Unordered' },
    ],
    default: '',
  },
];

/**
 * Object node shape - rectangle with name:Type[state].
 */
export const activityObjectShape: LibraryShapeDefinition = {
  type: 'activity-object',
  metadata: {
    type: 'activity-object',
    name: 'Object Node',
    category: 'uml-activity',
    icon: '▭',
    properties: objectNodeProperties,
    supportsLabel: true,
    supportsIcon: false,
    defaultWidth: 80,
    defaultHeight: 40,
    description: 'Object node (data flowing through activity)',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    path.rect(-width / 2, -height / 2, width, height);
    return path;
  },
  anchors: createStandardAnchors(),
  customRender: renderObjectNode,
  customLabelRendering: true,
  hitTestMode: 'path',
};

// ============================================================================
// Data Store Shape
// ============================================================================

/**
 * Data store custom properties.
 */
export interface DataStoreProperties {
  storeName?: string;
}

/**
 * Custom render function for data store.
 */
const renderDataStore: CustomRenderFunction = (ctx, shape) => {
  const { width, height, stroke, fill } = shape;
  const hw = width / 2;
  const hh = height / 2;

  // Get custom properties
  const customProps = shape.customProperties as DataStoreProperties | undefined;
  const storeName = customProps?.storeName || shape.label || 'datastore';

  // Draw cylinder (simplified as rectangle with top/bottom lines)
  ctx.fillStyle = fill || '#ffffff';
  ctx.fillRect(-hw, -hh, width, height);
  ctx.strokeStyle = stroke || '#000000';
  ctx.lineWidth = shape.strokeWidth || 1;
  ctx.strokeRect(-hw, -hh, width, height);

  // Draw top line (indicating cylinder top)
  ctx.beginPath();
  ctx.moveTo(-hw, -hh + 8);
  ctx.lineTo(hw, -hh + 8);
  ctx.stroke();

  // Draw stereotype
  const fontSize = 10;
  ctx.fillStyle = shape.labelColor || stroke || '#000000';
  ctx.font = `${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('«datastore»', 0, -hh + 2, width - 8);

  // Draw store name
  const nameFontSize = shape.labelFontSize || 12;
  ctx.font = `${nameFontSize}px sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText(storeName, 0, 5, width - 8);
};

/**
 * Data store properties.
 */
const dataStoreProperties: PropertyDefinition[] = [
  ...createStandardProperties({ includeLabel: true }),
  {
    key: 'customProperties.storeName',
    label: 'Store Name',
    type: 'string',
    section: 'custom',
    placeholder: 'DatabaseName',
  },
];

/**
 * Data store shape - rectangle with datastore stereotype.
 */
export const activityDataStoreShape: LibraryShapeDefinition = {
  type: 'activity-datastore',
  metadata: {
    type: 'activity-datastore',
    name: 'Data Store',
    category: 'uml-activity',
    icon: '🗄',
    properties: dataStoreProperties,
    supportsLabel: true,
    supportsIcon: false,
    defaultWidth: 80,
    defaultHeight: 50,
    description: 'Data store (persistent data)',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    path.rect(-width / 2, -height / 2, width, height);
    return path;
  },
  anchors: createStandardAnchors(),
  customRender: renderDataStore,
  customLabelRendering: true,
  hitTestMode: 'path',
};

// ============================================================================
// Central Buffer Shape
// ============================================================================

/**
 * Central buffer custom properties.
 */
export interface CentralBufferProperties {
  bufferName?: string;
  ordering?: 'FIFO' | 'LIFO' | 'ordered' | 'unordered';
}

/**
 * Custom render function for central buffer.
 */
const renderCentralBuffer: CustomRenderFunction = (ctx, shape) => {
  const { width, height, stroke, fill } = shape;
  const hw = width / 2;
  const hh = height / 2;

  // Get custom properties
  const customProps = shape.customProperties as CentralBufferProperties | undefined;
  const bufferName = customProps?.bufferName || shape.label || 'buffer';
  const ordering = customProps?.ordering || '';

  // Draw rectangle
  ctx.fillStyle = fill || '#ffffff';
  ctx.fillRect(-hw, -hh, width, height);
  ctx.strokeStyle = stroke || '#000000';
  ctx.lineWidth = shape.strokeWidth || 1;
  ctx.strokeRect(-hw, -hh, width, height);

  // Draw stereotype
  const fontSize = 10;
  ctx.fillStyle = shape.labelColor || stroke || '#000000';
  ctx.font = `${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('«centralBuffer»', 0, -hh + 2, width - 8);

  // Draw buffer name
  const nameFontSize = shape.labelFontSize || 12;
  ctx.font = `${nameFontSize}px sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText(bufferName, 0, 5, width - 8);

  // Draw ordering annotation if present
  if (ordering) {
    const annotFontSize = 9;
    ctx.font = `${annotFontSize}px sans-serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`{${ordering}}`, hw - 4, hh - 2, width - 8);
  }
};

/**
 * Central buffer properties.
 */
const centralBufferProperties: PropertyDefinition[] = [
  ...createStandardProperties({ includeLabel: true }),
  {
    key: 'customProperties.bufferName',
    label: 'Buffer Name',
    type: 'string',
    section: 'custom',
    placeholder: 'BufferName',
  },
  {
    key: 'customProperties.ordering',
    label: 'Ordering',
    type: 'select',
    section: 'custom',
    options: [
      { value: '', label: 'None' },
      { value: 'FIFO', label: 'FIFO' },
      { value: 'LIFO', label: 'LIFO' },
      { value: 'ordered', label: 'Ordered' },
      { value: 'unordered', label: 'Unordered' },
    ],
    default: '',
  },
];

/**
 * Central buffer shape - rectangle with centralBuffer stereotype.
 */
export const activityCentralBufferShape: LibraryShapeDefinition = {
  type: 'activity-buffer',
  metadata: {
    type: 'activity-buffer',
    name: 'Central Buffer',
    category: 'uml-activity',
    icon: '⬜',
    properties: centralBufferProperties,
    supportsLabel: true,
    supportsIcon: false,
    defaultWidth: 80,
    defaultHeight: 50,
    description: 'Central buffer (temporary storage)',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    path.rect(-width / 2, -height / 2, width, height);
    return path;
  },
  anchors: createStandardAnchors(),
  customRender: renderCentralBuffer,
  customLabelRendering: true,
  hitTestMode: 'path',
};

// ============================================================================
// Pin Shape
// ============================================================================

/**
 * Pin custom properties.
 */
export interface PinProperties {
  pinType?: 'input' | 'output';
  pinName?: string;
  dataType?: string;
}

/**
 * Custom render function for pin.
 */
const renderPin: CustomRenderFunction = (ctx, shape) => {
  const { width, height, stroke, fill } = shape;
  const hw = width / 2;
  const hh = height / 2;

  // Get custom properties
  const customProps = shape.customProperties as PinProperties | undefined;
  const pinType = customProps?.pinType || 'input';
  const pinName = customProps?.pinName || '';
  const dataType = customProps?.dataType || '';

  // Draw small square
  ctx.fillStyle = fill || '#ffffff';
  ctx.fillRect(-hw, -hh, width, height);
  ctx.strokeStyle = stroke || '#000000';
  ctx.lineWidth = shape.strokeWidth || 1;
  ctx.strokeRect(-hw, -hh, width, height);

  // Draw directional indicator (small arrow)
  if (pinType === 'input') {
    // Arrow pointing into the pin
    ctx.beginPath();
    ctx.moveTo(-hw - 3, 0);
    ctx.lineTo(-hw + 3, -3);
    ctx.lineTo(-hw + 3, 3);
    ctx.closePath();
    ctx.fillStyle = stroke || '#000000';
    ctx.fill();
  } else {
    // Arrow pointing out of the pin
    ctx.beginPath();
    ctx.moveTo(hw + 3, 0);
    ctx.lineTo(hw - 3, -3);
    ctx.lineTo(hw - 3, 3);
    ctx.closePath();
    ctx.fillStyle = stroke || '#000000';
    ctx.fill();
  }

  // Draw pin name and type below if present
  if (pinName || dataType) {
    const fontSize = 9;
    ctx.fillStyle = shape.labelColor || stroke || '#000000';
    ctx.font = `${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    // Format as "name : Type" if both present, otherwise just the one that exists
    const labelText = pinName && dataType ? `${pinName} : ${dataType}` : (pinName || dataType);
    ctx.fillText(labelText, 0, hh + 2, 80);
  }
};

/**
 * Pin properties.
 */
const pinProperties: PropertyDefinition[] = [
  ...createStandardProperties({}),
  {
    key: 'customProperties.pinType',
    label: 'Pin Type',
    type: 'select',
    section: 'custom',
    options: [
      { value: 'input', label: 'Input' },
      { value: 'output', label: 'Output' },
    ],
    default: 'input',
  },
  {
    key: 'customProperties.pinName',
    label: 'Pin Name',
    type: 'string',
    section: 'custom',
    placeholder: 'pinName',
  },
  {
    key: 'customProperties.dataType',
    label: 'Data Type',
    type: 'string',
    section: 'custom',
    placeholder: 'DataType',
  },
];

/**
 * Pin shape - small square attached to action boundaries.
 */
export const activityPinShape: LibraryShapeDefinition = {
  type: 'activity-pin',
  metadata: {
    type: 'activity-pin',
    name: 'Pin',
    category: 'uml-activity',
    icon: '□',
    properties: pinProperties,
    supportsLabel: false,
    supportsIcon: false,
    defaultWidth: 16,
    defaultHeight: 16,
    aspectRatioLocked: true,
    description: 'Input/Output pin for action data flow',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    path.rect(-width / 2, -height / 2, width, height);
    return path;
  },
  anchors: [
    { position: 'center', x: () => 0, y: () => 0 },
    { position: 'left', x: (w) => -w / 2, y: () => 0 },
    { position: 'right', x: (w) => w / 2, y: () => 0 },
  ],
  customRender: renderPin,
  hitTestMode: 'path',
};

// ============================================================================
// Expansion Region Shape
// ============================================================================

/**
 * Expansion region custom properties.
 */
export interface ExpansionRegionProperties {
  mode?: 'parallel' | 'iterative' | 'stream';
}

/**
 * Custom render function for expansion region.
 */
const renderExpansionRegion: CustomRenderFunction = (ctx, shape) => {
  const { width, height, stroke, fill } = shape;
  const hw = width / 2;
  const hh = height / 2;
  const cornerRadius = 10;

  // Get custom properties
  const customProps = shape.customProperties as ExpansionRegionProperties | undefined;
  const mode = customProps?.mode || 'parallel';

  // Draw rounded dashed rectangle
  ctx.beginPath();
  ctx.moveTo(-hw + cornerRadius, -hh);
  ctx.lineTo(hw - cornerRadius, -hh);
  ctx.quadraticCurveTo(hw, -hh, hw, -hh + cornerRadius);
  ctx.lineTo(hw, hh - cornerRadius);
  ctx.quadraticCurveTo(hw, hh, hw - cornerRadius, hh);
  ctx.lineTo(-hw + cornerRadius, hh);
  ctx.quadraticCurveTo(-hw, hh, -hw, hh - cornerRadius);
  ctx.lineTo(-hw, -hh + cornerRadius);
  ctx.quadraticCurveTo(-hw, -hh, -hw + cornerRadius, -hh);
  ctx.closePath();

  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  ctx.strokeStyle = stroke || '#000000';
  ctx.lineWidth = shape.strokeWidth || 1;
  ctx.setLineDash([6, 3]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Draw expansion nodes (small rectangles) on edges
  const nodeSize = 12;
  const nodeY = -hh - nodeSize / 2;

  // Input nodes (top-left)
  for (let i = 0; i < 3; i++) {
    const nodeX = -hw + 20 + i * (nodeSize + 2);
    ctx.fillStyle = fill || '#ffffff';
    ctx.fillRect(nodeX, nodeY, nodeSize, nodeSize);
    ctx.strokeRect(nodeX, nodeY, nodeSize, nodeSize);
  }

  // Output nodes (bottom-left)
  const outputY = hh - nodeSize / 2;
  for (let i = 0; i < 3; i++) {
    const nodeX = -hw + 20 + i * (nodeSize + 2);
    ctx.fillStyle = fill || '#ffffff';
    ctx.fillRect(nodeX, outputY, nodeSize, nodeSize);
    ctx.strokeRect(nodeX, outputY, nodeSize, nodeSize);
  }

  // Draw mode keyword
  const fontSize = 10;
  ctx.fillStyle = shape.labelColor || stroke || '#000000';
  ctx.font = `${fontSize}px sans-serif`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  ctx.fillText(`«${mode}»`, hw - 4, -hh + 4, width - 20);
};

/**
 * Expansion region properties.
 */
const expansionRegionProperties: PropertyDefinition[] = [
  ...createStandardProperties({}),
  {
    key: 'customProperties.mode',
    label: 'Execution Mode',
    type: 'select',
    section: 'custom',
    options: [
      { value: 'parallel', label: 'Parallel' },
      { value: 'iterative', label: 'Iterative' },
      { value: 'stream', label: 'Stream' },
    ],
    default: 'parallel',
  },
];

/**
 * Expansion region shape - container for iterative/parallel execution.
 */
export const activityExpansionRegionShape: LibraryShapeDefinition = {
  type: 'activity-expansion',
  metadata: {
    type: 'activity-expansion',
    name: 'Expansion Region',
    category: 'uml-activity',
    icon: '⬚',
    properties: expansionRegionProperties,
    supportsLabel: false,
    supportsIcon: false,
    defaultWidth: 200,
    defaultHeight: 150,
    description: 'Expansion region for iterative/parallel processing',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    path.rect(-width / 2, -height / 2, width, height);
    return path;
  },
  anchors: createStandardAnchors(),
  customRender: renderExpansionRegion,
  hitTestMode: 'bounds',
};

// ============================================================================
// Interruptible Region Shape
// ============================================================================

/**
 * Custom render function for interruptible region.
 */
const renderInterruptibleRegion: CustomRenderFunction = (ctx, shape) => {
  const { width, height, stroke, fill } = shape;
  const hw = width / 2;
  const hh = height / 2;
  const cornerRadius = 10;

  // Draw rounded dashed rectangle
  ctx.beginPath();
  ctx.moveTo(-hw + cornerRadius, -hh);
  ctx.lineTo(hw - cornerRadius, -hh);
  ctx.quadraticCurveTo(hw, -hh, hw, -hh + cornerRadius);
  ctx.lineTo(hw, hh - cornerRadius);
  ctx.quadraticCurveTo(hw, hh, hw - cornerRadius, hh);
  ctx.lineTo(-hw + cornerRadius, hh);
  ctx.quadraticCurveTo(-hw, hh, -hw, hh - cornerRadius);
  ctx.lineTo(-hw, -hh + cornerRadius);
  ctx.quadraticCurveTo(-hw, -hh, -hw + cornerRadius, -hh);
  ctx.closePath();

  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  ctx.strokeStyle = stroke || '#000000';
  ctx.lineWidth = shape.strokeWidth || 1;
  ctx.setLineDash([6, 3]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Draw lightning bolt / zigzag indicator in corner
  const zigzagSize = 16;
  const zigX = hw - 20;
  const zigY = -hh + 10;

  ctx.beginPath();
  ctx.moveTo(zigX, zigY);
  ctx.lineTo(zigX - 6, zigY + zigzagSize / 2);
  ctx.lineTo(zigX + 2, zigY + zigzagSize / 2);
  ctx.lineTo(zigX - 4, zigY + zigzagSize);
  ctx.strokeStyle = stroke || '#000000';
  ctx.lineWidth = 2;
  ctx.stroke();
};

/**
 * Interruptible region shape - dashed rectangle with lightning indicator.
 */
export const activityInterruptibleRegionShape: LibraryShapeDefinition = {
  type: 'activity-interruptible',
  metadata: {
    type: 'activity-interruptible',
    name: 'Interruptible Region',
    category: 'uml-activity',
    icon: '⚡',
    properties: createStandardProperties({}),
    supportsLabel: false,
    supportsIcon: false,
    defaultWidth: 200,
    defaultHeight: 150,
    description: 'Interruptible activity region',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    path.rect(-width / 2, -height / 2, width, height);
    return path;
  },
  anchors: createStandardAnchors(),
  customRender: renderInterruptibleRegion,
  hitTestMode: 'bounds',
};

// ============================================================================
// Activity Parameter Node Shape
// ============================================================================

/**
 * Activity parameter custom properties.
 */
export interface ActivityParameterProperties {
  direction?: 'in' | 'out' | 'inout';
  paramName?: string;
  paramType?: string;
}

/**
 * Custom render function for activity parameter node.
 */
const renderActivityParameter: CustomRenderFunction = (ctx, shape) => {
  const { width, height, stroke, fill } = shape;
  const hw = width / 2;
  const hh = height / 2;

  // Get custom properties
  const customProps = shape.customProperties as ActivityParameterProperties | undefined;
  const direction = customProps?.direction || 'in';
  const paramName = customProps?.paramName || shape.label || 'param';
  const paramType = customProps?.paramType || '';

  // Draw rectangle (half-overlapping activity boundary style)
  ctx.fillStyle = fill || '#ffffff';
  ctx.fillRect(-hw, -hh, width, height);
  ctx.strokeStyle = stroke || '#000000';
  ctx.lineWidth = shape.strokeWidth || 1;
  ctx.strokeRect(-hw, -hh, width, height);

  // Build label text
  let labelText = paramName;
  if (paramType) {
    labelText = `${paramName} : ${paramType}`;
  }

  // Add direction indicator
  let dirIndicator = '';
  if (direction === 'in') {
    dirIndicator = '▶ ';
  } else if (direction === 'out') {
    dirIndicator = '◀ ';
  } else {
    dirIndicator = '◀▶ ';
  }

  // Draw label
  const fontSize = shape.labelFontSize || 11;
  ctx.fillStyle = shape.labelColor || stroke || '#000000';
  ctx.font = `${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(dirIndicator + labelText, 0, 0, width - 8);
};

/**
 * Activity parameter properties.
 */
const activityParameterProperties: PropertyDefinition[] = [
  ...createStandardProperties({ includeLabel: true }),
  {
    key: 'customProperties.direction',
    label: 'Direction',
    type: 'select',
    section: 'custom',
    options: [
      { value: 'in', label: 'In' },
      { value: 'out', label: 'Out' },
      { value: 'inout', label: 'In/Out' },
    ],
    default: 'in',
  },
  {
    key: 'customProperties.paramName',
    label: 'Parameter Name',
    type: 'string',
    section: 'custom',
    placeholder: 'paramName',
  },
  {
    key: 'customProperties.paramType',
    label: 'Parameter Type',
    type: 'string',
    section: 'custom',
    placeholder: 'DataType',
  },
];

/**
 * Activity parameter node shape - pin-like shape at activity boundary.
 */
export const activityParameterShape: LibraryShapeDefinition = {
  type: 'activity-parameter',
  metadata: {
    type: 'activity-parameter',
    name: 'Activity Parameter',
    category: 'uml-activity',
    icon: '▯',
    properties: activityParameterProperties,
    supportsLabel: true,
    supportsIcon: false,
    defaultWidth: 100,
    defaultHeight: 30,
    description: 'Activity parameter node (input/output)',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    path.rect(-width / 2, -height / 2, width, height);
    return path;
  },
  anchors: createStandardAnchors(),
  customRender: renderActivityParameter,
  customLabelRendering: true,
  hitTestMode: 'path',
};

// ============================================================================
// Export all activity diagram shapes
// ============================================================================

/**
 * All UML Activity Diagram shape definitions.
 */
export const activityDiagramShapes: LibraryShapeDefinition[] = [
  activityActionShape,
  activityInitialShape,
  activityFinalShape,
  activityFlowFinalShape,
  activityForkJoinShape,
  activitySendSignalShape,
  activityReceiveSignalShape,
  activitySwimlaneShape,
  activityDecisionShape,
  activityMergeShape,
  activityAcceptEventShape,
  activityTimeEventShape,
  activityObjectShape,
  activityDataStoreShape,
  activityCentralBufferShape,
  activityPinShape,
  activityExpansionRegionShape,
  activityInterruptibleRegionShape,
  activityParameterShape,
];
