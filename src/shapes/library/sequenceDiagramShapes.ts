/**
 * UML Sequence Diagram shape definitions.
 *
 * This module defines shapes for creating UML sequence diagrams:
 * - Lifeline (actor/object header + dashed vertical line)
 * - Activation (execution rectangle on lifeline)
 * - Fragment (interaction frame: loop, alt, opt, par, etc.)
 * - Actor (stick figure)
 * - State Invariant (constraint on lifeline)
 * - Time Constraint (duration annotation)
 * - Coregion (unordered message region)
 * - Continuation (cross-diagram reference)
 */

import type { LibraryShapeDefinition, CustomRenderFunction, AnchorDefinition } from './ShapeLibraryTypes';
import { createStandardAnchors } from './ShapeLibraryTypes';
import { createStandardProperties } from '../ShapeMetadata';
import type { PropertyDefinition } from '../ShapeMetadata';
import type { LibraryShape, Handle } from '../Shape';
import { Vec2 } from '../../math/Vec2';
import { canvasFont } from '../../fonts/canvasFont';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Lifeline head type variants for different participant types.
 */
export type LifelineHeadType = 'object' | 'actor' | 'component' | 'interface' | 'database' | 'queue';

/**
 * Lifeline custom properties interface.
 */
export interface LifelineProperties {
  objectName?: string;
  objectType?: string;
  lifelineLength?: number;
  headType?: LifelineHeadType;
  stereotype?: string;
  showStereotype?: boolean;
}

/**
 * Activation custom properties interface.
 */
export interface ActivationProperties {
  nestLevel?: number;
  isRecursive?: boolean;
}

/**
 * Fragment operand for alt/par fragments.
 */
export interface FragmentOperand {
  condition?: string;
  label?: string;
}

/**
 * Fragment custom properties interface.
 */
export interface FragmentProperties {
  fragmentType?: FragmentType;
  guardCondition?: string;
  operands?: FragmentOperand[];
  showDividers?: boolean;
}

/**
 * Actor type variants.
 */
export type ActorType = 'person' | 'system' | 'external';

// ============================================================================
// Lifeline Shape
// ============================================================================

/**
 * Draw component symbol (small rectangles on left edge).
 */
function drawComponentSymbol(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  const rectW = size * 0.6;
  const rectH = size * 0.25;
  const gap = size * 0.15;

  ctx.fillRect(x - rectW / 2, y - gap - rectH, rectW, rectH);
  ctx.strokeRect(x - rectW / 2, y - gap - rectH, rectW, rectH);
  ctx.fillRect(x - rectW / 2, y + gap, rectW, rectH);
  ctx.strokeRect(x - rectW / 2, y + gap, rectW, rectH);
}

/**
 * Draw interface symbol (lollipop/ball).
 */
function drawInterfaceSymbol(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number): void {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

/**
 * Draw database symbol (cylinder).
 */
function drawDatabaseSymbol(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const ellipseH = h * 0.2;

  // Top ellipse
  ctx.beginPath();
  ctx.ellipse(x, y - h / 2 + ellipseH / 2, w / 2, ellipseH / 2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Body
  ctx.beginPath();
  ctx.moveTo(x - w / 2, y - h / 2 + ellipseH / 2);
  ctx.lineTo(x - w / 2, y + h / 2 - ellipseH / 2);
  ctx.ellipse(x, y + h / 2 - ellipseH / 2, w / 2, ellipseH / 2, 0, Math.PI, 0, true);
  ctx.lineTo(x + w / 2, y - h / 2 + ellipseH / 2);
  ctx.stroke();
}

/**
 * Draw queue symbol (cylinder rotated).
 */
function drawQueueSymbol(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const ellipseW = w * 0.2;

  // Left ellipse
  ctx.beginPath();
  ctx.ellipse(x - w / 2 + ellipseW / 2, y, ellipseW / 2, h / 2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Body top and bottom
  ctx.beginPath();
  ctx.moveTo(x - w / 2 + ellipseW / 2, y - h / 2);
  ctx.lineTo(x + w / 2 - ellipseW / 2, y - h / 2);
  ctx.ellipse(x + w / 2 - ellipseW / 2, y, ellipseW / 2, h / 2, 0, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(x - w / 2 + ellipseW / 2, y + h / 2);
  ctx.stroke();
}

/**
 * Draw stick figure for actor head type.
 */
function drawActorHead(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const headRadius = Math.min(w, h) * 0.2;
  const bodyTop = y - h / 2 + headRadius * 2 + 2;
  const bodyBottom = y + h / 2 - 5;
  const armY = bodyTop + (bodyBottom - bodyTop) * 0.2;

  // Head
  ctx.beginPath();
  ctx.arc(x, y - h / 2 + headRadius + 2, headRadius, 0, Math.PI * 2);
  ctx.stroke();

  // Body
  ctx.beginPath();
  ctx.moveTo(x, bodyTop);
  ctx.lineTo(x, bodyBottom);
  ctx.stroke();

  // Arms
  ctx.beginPath();
  ctx.moveTo(x - w / 2 + 5, armY);
  ctx.lineTo(x + w / 2 - 5, armY);
  ctx.stroke();

  // Legs
  ctx.beginPath();
  ctx.moveTo(x, bodyBottom);
  ctx.lineTo(x - w / 2 + 8, y + h / 2 - 2);
  ctx.moveTo(x, bodyBottom);
  ctx.lineTo(x + w / 2 - 8, y + h / 2 - 2);
  ctx.stroke();
}

/**
 * Custom render function for sequence lifeline.
 * Renders header box + dashed vertical line extending downward.
 * Supports multiple head types: object, actor, component, interface, database, queue.
 */
const renderLifeline: CustomRenderFunction = (ctx, shape) => {
  const { width, height, stroke, fill } = shape;
  const hw = width / 2;
  const hh = height / 2;

  // Get custom properties
  const customProps = shape.customProperties as LifelineProperties | undefined;

  const objectName = customProps?.objectName || shape.label || 'Object';
  const objectType = customProps?.objectType || '';
  const lifelineLength = customProps?.lifelineLength ?? 200;
  const headType = customProps?.headType || 'object';
  const stereotype = customProps?.stereotype || '';
  const showStereotype = customProps?.showStereotype ?? (stereotype !== '');

  // Header box dimensions
  const headerHeight = Math.min(50, height);
  const headerY = -hh;
  const headerCenterY = headerY + headerHeight / 2;

  ctx.strokeStyle = stroke || '#000000';
  ctx.lineWidth = shape.strokeWidth || 1;
  ctx.fillStyle = fill || '#ffffff';

  // Draw head based on type
  switch (headType) {
    case 'actor':
      // Draw stick figure
      drawActorHead(ctx, 0, headerCenterY, width * 0.6, headerHeight * 0.9);
      break;

    case 'component':
      // Draw component box with small rectangles
      ctx.fillRect(-hw, headerY, width, headerHeight);
      ctx.strokeRect(-hw, headerY, width, headerHeight);
      drawComponentSymbol(ctx, -hw, headerCenterY, 16);
      break;

    case 'interface':
      // Draw lollipop interface symbol
      ctx.fillRect(-hw, headerY, width, headerHeight);
      ctx.strokeRect(-hw, headerY, width, headerHeight);
      drawInterfaceSymbol(ctx, -hw + 12, headerCenterY, 6);
      break;

    case 'database':
      // Draw cylinder
      drawDatabaseSymbol(ctx, 0, headerCenterY, width * 0.8, headerHeight * 0.8);
      break;

    case 'queue':
      // Draw horizontal cylinder
      drawQueueSymbol(ctx, 0, headerCenterY, width * 0.8, headerHeight * 0.6);
      break;

    case 'object':
    default:
      // Standard rectangle
      ctx.fillRect(-hw, headerY, width, headerHeight);
      ctx.strokeRect(-hw, headerY, width, headerHeight);
      break;
  }

  // Draw stereotype if enabled
  const fontSize = Math.min(14, headerHeight * 0.35);
  ctx.fillStyle = shape.labelColor || stroke || '#000000';

  if (showStereotype && stereotype) {
    const stereoFontSize = fontSize * 0.85;
    ctx.font = `${stereoFontSize}px ${canvasFont()}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`«${stereotype}»`, 0, headerCenterY - 2, width - 10);

    // Object name below stereotype
    ctx.font = `${fontSize}px ${canvasFont()}`;
    ctx.textBaseline = 'top';
    if (objectType) {
      ctx.fillText(`${objectName} : ${objectType}`, 0, headerCenterY + 2, width - 10);
    } else {
      ctx.fillText(objectName, 0, headerCenterY + 2, width - 10);
    }
  } else {
    // Standard object name and type
    ctx.font = `${fontSize}px ${canvasFont()}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (objectType) {
      ctx.fillText(`${objectName} : ${objectType}`, 0, headerCenterY, width - 10);
    } else {
      ctx.fillText(objectName, 0, headerCenterY, width - 10);
    }
  }

  // Draw dashed lifeline extending downward from header
  const lineStartY = headerY + headerHeight;
  const lineEndY = lineStartY + lifelineLength;

  ctx.strokeStyle = stroke || '#000000';
  ctx.beginPath();
  ctx.setLineDash([8, 4]);
  ctx.moveTo(0, lineStartY);
  ctx.lineTo(0, lineEndY);
  ctx.stroke();
  ctx.setLineDash([]);
};

/**
 * Dynamic anchors for lifeline - provides anchors along the dashed line.
 */
const createLifelineAnchors = (
  shape: LibraryShape,
  width: number,
  height: number
): AnchorDefinition[] => {
  const customProps = shape.customProperties as LifelineProperties | undefined;
  const lifelineLength = customProps?.lifelineLength ?? 200;
  const headerHeight = Math.min(50, height);
  const lineStartY = -height / 2 + headerHeight;

  // Standard anchors for header
  const anchors: AnchorDefinition[] = [
    { position: 'center', x: () => 0, y: () => -height / 2 + headerHeight / 2 },
    { position: 'top', x: () => 0, y: () => -height / 2 },
    { position: 'left', x: () => -width / 2, y: () => -height / 2 + headerHeight / 2 },
    { position: 'right', x: () => width / 2, y: () => -height / 2 + headerHeight / 2 },
  ];

  // Add anchors along the lifeline at regular intervals
  const numLineAnchors = 10;
  for (let i = 0; i <= numLineAnchors; i++) {
    const t = i / numLineAnchors;
    const y = lineStartY + t * lifelineLength;
    anchors.push({
      position: `lifeline-${i}`,
      x: () => 0,
      y: () => y,
    });
    // Left and right anchors for message attachment
    anchors.push({
      position: `lifeline-${i}-left`,
      x: () => -4, // Slight offset for visual clarity
      y: () => y,
    });
    anchors.push({
      position: `lifeline-${i}-right`,
      x: () => 4,
      y: () => y,
    });
  }

  return anchors;
};

/**
 * Lifeline properties with head type and stereotype support.
 */
const lifelineProperties: PropertyDefinition[] = [
  ...createStandardProperties({ includeLabel: true }),
  {
    key: 'customProperties.headType',
    label: 'Head Type',
    type: 'select',
    section: 'custom',
    options: [
      { value: 'object', label: 'Object (default)' },
      { value: 'actor', label: 'Actor' },
      { value: 'component', label: 'Component' },
      { value: 'interface', label: 'Interface' },
      { value: 'database', label: 'Database' },
      { value: 'queue', label: 'Queue' },
    ],
    default: 'object',
  },
  {
    key: 'customProperties.objectName',
    label: 'Object Name',
    type: 'string',
    section: 'custom',
    placeholder: 'Object',
  },
  {
    key: 'customProperties.objectType',
    label: 'Object Type',
    type: 'string',
    section: 'custom',
    placeholder: 'ClassName',
  },
  {
    key: 'customProperties.stereotype',
    label: 'Stereotype',
    type: 'string',
    section: 'custom',
    placeholder: 'boundary, control, entity...',
  },
  {
    key: 'customProperties.lifelineLength',
    label: 'Lifeline Length',
    type: 'number',
    section: 'custom',
    min: 50,
    max: 500,
    step: 10,
    default: 200,
  },
];

/**
 * Transform a local point to world space for handle positioning.
 */
function localToWorldLifeline(local: Vec2, shape: LibraryShape): Vec2 {
  const rotated = local.rotate(shape.rotation);
  return new Vec2(rotated.x + shape.x, rotated.y + shape.y);
}

/**
 * Create custom handle for lifeline tail (to resize lifelineLength).
 */
function createLifelineCustomHandles(shape: LibraryShape): Handle[] {
  const customProps = shape.customProperties as LifelineProperties | undefined;
  const lifelineLength = customProps?.lifelineLength ?? 200;
  const headerHeight = Math.min(50, shape.height);
  const lineStartY = -shape.height / 2 + headerHeight;
  const lineEndY = lineStartY + lifelineLength;

  // Handle at the bottom of the lifeline tail
  const world = localToWorldLifeline(new Vec2(0, lineEndY), shape);
  return [
    {
      type: 'lifeline-tail',
      x: world.x,
      y: world.y,
      cursor: 'ns-resize',
      metadata: { style: 'line' },
    },
  ];
}

/**
 * Lifeline shape - header box with dashed vertical line.
 */
export const seqLifelineShape: LibraryShapeDefinition = {
  type: 'seq-lifeline',
  metadata: {
    type: 'seq-lifeline',
    name: 'Lifeline',
    category: 'uml-sequence',
    icon: '┃',
    properties: lifelineProperties,
    supportsLabel: true,
    supportsIcon: false,
    defaultWidth: 100,
    defaultHeight: 50,
    description: 'UML sequence diagram lifeline with header and dashed line',
  },
  pathBuilder: (width, height) => {
    // Path is just the header box - lifeline is drawn in customRender
    const path = new Path2D();
    const hw = width / 2;
    const hh = height / 2;
    const headerHeight = Math.min(50, height);
    path.rect(-hw, -hh, width, headerHeight);
    return path;
  },
  anchors: createStandardAnchors(),
  dynamicAnchors: createLifelineAnchors,
  customRender: renderLifeline,
  customLabelRendering: true,
  hitTestMode: 'bounds',
  customHandles: createLifelineCustomHandles,
};

// ============================================================================
// Activation Shape
// ============================================================================

/**
 * Custom render function for activation box.
 * Thin filled rectangle representing method execution.
 * Supports visual offset for nested activations.
 */
const renderActivation: CustomRenderFunction = (ctx, shape) => {
  const { width, height, stroke, fill } = shape;

  // Get custom properties for nesting
  const customProps = shape.customProperties as ActivationProperties | undefined;
  const nestLevel = customProps?.nestLevel ?? 0;
  const isRecursive = customProps?.isRecursive ?? false;

  // Apply visual offset for nested activations
  const nestOffset = nestLevel * 4;
  const hw = width / 2;
  const hh = height / 2;

  // Draw filled rectangle with nest offset
  ctx.fillStyle = fill || '#ffffff';
  ctx.fillRect(-hw + nestOffset, -hh, width, height);
  ctx.strokeStyle = stroke || '#000000';
  ctx.lineWidth = shape.strokeWidth || 1;
  ctx.strokeRect(-hw + nestOffset, -hh, width, height);

  // Draw recursive indicator (small loop arrow) if recursive
  if (isRecursive) {
    const arrowSize = 6;
    const arrowX = hw + nestOffset - 2;
    const arrowY = -hh + 10;

    ctx.beginPath();
    ctx.moveTo(arrowX, arrowY);
    ctx.lineTo(arrowX + arrowSize, arrowY);
    ctx.lineTo(arrowX + arrowSize, arrowY + arrowSize);
    ctx.moveTo(arrowX + arrowSize - 2, arrowY + arrowSize - 2);
    ctx.lineTo(arrowX + arrowSize, arrowY + arrowSize);
    ctx.lineTo(arrowX + arrowSize + 2, arrowY + arrowSize - 2);
    ctx.stroke();
  }
};

/**
 * Activation properties with nesting support.
 */
const activationProperties: PropertyDefinition[] = [
  ...createStandardProperties({}),
  {
    key: 'customProperties.nestLevel',
    label: 'Nest Level',
    type: 'number',
    section: 'custom',
    min: 0,
    max: 5,
    step: 1,
    default: 0,
    helpText: 'Visual offset for nested calls (0-5)',
  },
  {
    key: 'customProperties.isRecursive',
    label: 'Recursive Call',
    type: 'boolean',
    section: 'custom',
    default: false,
    helpText: 'Show recursive call indicator',
  },
];

/**
 * Activation shape - thin rectangle for execution period.
 */
export const seqActivationShape: LibraryShapeDefinition = {
  type: 'seq-activation',
  metadata: {
    type: 'seq-activation',
    name: 'Activation',
    category: 'uml-sequence',
    icon: '▮',
    properties: activationProperties,
    supportsLabel: false,
    supportsIcon: false,
    defaultWidth: 16,
    defaultHeight: 60,
    description: 'Activation box showing method execution period',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    const hw = width / 2;
    const hh = height / 2;
    path.rect(-hw, -hh, width, height);
    return path;
  },
  anchors: [
    { position: 'center', x: () => 0, y: () => 0 },
    { position: 'top', x: () => 0, y: (_, h) => -h / 2 },
    { position: 'bottom', x: () => 0, y: (_, h) => h / 2 },
    { position: 'left', x: (w) => -w / 2, y: () => 0 },
    { position: 'right', x: (w) => w / 2, y: () => 0 },
  ],
  customRender: renderActivation,
  hitTestMode: 'path',
};

// ============================================================================
// Fragment Shape (Interaction Frame)
// ============================================================================

/**
 * Fragment type options for interaction frames.
 * Extended with strict and seq operators per UML 2.x specification.
 */
export type FragmentType =
  | 'loop'     // Loop iteration
  | 'alt'      // Alternative (if-else)
  | 'opt'      // Optional (if without else)
  | 'par'      // Parallel execution
  | 'break'    // Break out of enclosing fragment
  | 'critical' // Critical region (atomic)
  | 'neg'      // Invalid/negative interaction
  | 'assert'   // Assertion (must occur)
  | 'ignore'   // Ignore certain messages
  | 'consider' // Consider only certain messages
  | 'ref'      // Reference to another diagram
  | 'strict'   // Strict ordering
  | 'seq';     // Weak sequencing

/**
 * Custom render function for interaction fragment.
 * Renders frame with operator label in corner and operand dividers.
 */
const renderFragment: CustomRenderFunction = (ctx, shape) => {
  const { width, height, stroke, fill } = shape;
  const hw = width / 2;
  const hh = height / 2;

  // Get custom properties
  const customProps = shape.customProperties as FragmentProperties | undefined;

  const fragmentType = customProps?.fragmentType || 'loop';
  const guardCondition = customProps?.guardCondition || '';
  const operands = customProps?.operands || [];
  const showDividers = customProps?.showDividers ?? true;

  // Frame dimensions
  const labelHeight = 24;
  const labelWidth = Math.min(80, width * 0.4);
  const pentagonIndent = 10;

  // Draw main frame rectangle
  ctx.fillStyle = fill || 'rgba(255, 255, 255, 0.9)';
  ctx.fillRect(-hw, -hh, width, height);
  ctx.strokeStyle = stroke || '#000000';
  ctx.lineWidth = shape.strokeWidth || 1;
  ctx.strokeRect(-hw, -hh, width, height);

  // Draw operator label pentagon in top-left corner
  ctx.beginPath();
  ctx.moveTo(-hw, -hh);
  ctx.lineTo(-hw + labelWidth, -hh);
  ctx.lineTo(-hw + labelWidth, -hh + labelHeight - pentagonIndent);
  ctx.lineTo(-hw + labelWidth - pentagonIndent, -hh + labelHeight);
  ctx.lineTo(-hw, -hh + labelHeight);
  ctx.closePath();
  ctx.fillStyle = fill || '#f0f0f0';
  ctx.fill();
  ctx.stroke();

  // Draw operator text
  const fontSize = Math.min(12, labelHeight * 0.5);
  ctx.fillStyle = shape.labelColor || stroke || '#000000';
  ctx.font = `bold ${fontSize}px ${canvasFont()}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(fragmentType.toUpperCase(), -hw + labelWidth / 2, -hh + labelHeight / 2);

  // Draw guard condition if present (for first operand or single condition)
  if (guardCondition) {
    ctx.font = `${fontSize}px ${canvasFont()}`;
    ctx.textAlign = 'left';
    const guardX = -hw + labelWidth + 10;
    const guardY = -hh + labelHeight / 2;
    ctx.fillText(`[${guardCondition}]`, guardX, guardY, width - labelWidth - 20);
  }

  // Draw operand dividers if there are multiple operands (for alt, par, etc.)
  if (showDividers && operands.length > 0) {
    const contentTop = -hh + labelHeight + 5;
    const contentHeight = height - labelHeight - 5;
    const numOperands = operands.length + 1; // +1 for the implicit first operand
    const operandHeight = contentHeight / numOperands;

    ctx.setLineDash([6, 3]);
    ctx.strokeStyle = stroke || '#000000';

    for (let i = 0; i < operands.length; i++) {
      const dividerY = contentTop + (i + 1) * operandHeight;

      // Draw horizontal divider
      ctx.beginPath();
      ctx.moveTo(-hw, dividerY);
      ctx.lineTo(hw, dividerY);
      ctx.stroke();

      // Draw operand condition/label
      const operand = operands[i];
      if (operand?.condition) {
        ctx.setLineDash([]);
        ctx.font = `${fontSize}px ${canvasFont()}`;
        ctx.textAlign = 'left';
        ctx.fillStyle = shape.labelColor || stroke || '#000000';
        ctx.fillText(`[${operand.condition}]`, -hw + 10, dividerY + 12, width - 20);
        ctx.setLineDash([6, 3]);
      } else if (operand?.label === 'else' || (!operand?.condition && i === operands.length - 1 && fragmentType === 'alt')) {
        // Draw "else" for alt fragments
        ctx.setLineDash([]);
        ctx.font = `${fontSize}px ${canvasFont()}`;
        ctx.textAlign = 'left';
        ctx.fillStyle = shape.labelColor || stroke || '#000000';
        ctx.fillText('[else]', -hw + 10, dividerY + 12, width - 20);
        ctx.setLineDash([6, 3]);
      }
    }

    ctx.setLineDash([]);
  }
};

/**
 * Fragment properties with operand support.
 */
const fragmentProperties: PropertyDefinition[] = [
  ...createStandardProperties({ includeLabel: false }),
  {
    key: 'customProperties.fragmentType',
    label: 'Fragment Type',
    type: 'select',
    section: 'custom',
    options: [
      { value: 'loop', label: 'Loop' },
      { value: 'alt', label: 'Alternative (alt)' },
      { value: 'opt', label: 'Optional (opt)' },
      { value: 'par', label: 'Parallel (par)' },
      { value: 'break', label: 'Break' },
      { value: 'critical', label: 'Critical' },
      { value: 'neg', label: 'Negative (neg)' },
      { value: 'assert', label: 'Assert' },
      { value: 'ignore', label: 'Ignore' },
      { value: 'consider', label: 'Consider' },
      { value: 'ref', label: 'Reference (ref)' },
      { value: 'strict', label: 'Strict Ordering' },
      { value: 'seq', label: 'Weak Sequencing' },
    ],
    default: 'loop',
  },
  {
    key: 'customProperties.guardCondition',
    label: 'Guard Condition',
    type: 'string',
    section: 'custom',
    placeholder: 'i < n',
  },
  {
    key: 'customProperties.showDividers',
    label: 'Show Operand Dividers',
    type: 'boolean',
    section: 'custom',
    default: true,
  },
];

/**
 * Fragment shape - interaction frame with operator.
 */
export const seqFragmentShape: LibraryShapeDefinition = {
  type: 'seq-fragment',
  metadata: {
    type: 'seq-fragment',
    name: 'Fragment',
    category: 'uml-sequence',
    icon: '⬚',
    properties: fragmentProperties,
    supportsLabel: false,
    supportsIcon: false,
    defaultWidth: 200,
    defaultHeight: 150,
    description: 'Interaction frame for loop, alt, opt, par, etc.',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    const hw = width / 2;
    const hh = height / 2;
    path.rect(-hw, -hh, width, height);
    return path;
  },
  anchors: createStandardAnchors(),
  customRender: renderFragment,
  customLabelRendering: true,
  hitTestMode: 'bounds',
};

// ============================================================================
// Actor Shape (Stick Figure)
// ============================================================================

/**
 * Actor custom properties.
 */
interface ActorProperties {
  actorType?: ActorType;
}

/**
 * Custom render function for UML actor.
 * Supports person (stick figure), system (box), and external (box with stereotype).
 */
const renderActor: CustomRenderFunction = (ctx, shape) => {
  const { width, height, stroke, fill } = shape;
  const hw = width / 2;
  const hh = height / 2;

  // Get custom properties
  const customProps = shape.customProperties as ActorProperties | undefined;
  const actorType = customProps?.actorType || 'person';

  ctx.strokeStyle = stroke || '#000000';
  ctx.lineWidth = shape.strokeWidth || 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (actorType === 'system' || actorType === 'external') {
    // Draw box with stereotype
    ctx.fillStyle = fill || '#ffffff';
    ctx.fillRect(-hw, -hh, width, height - 20);
    ctx.strokeRect(-hw, -hh, width, height - 20);

    // Draw stereotype
    const stereo = actorType === 'system' ? '«system»' : '«external»';
    const fontSize = Math.min(10, width * 0.15);
    ctx.fillStyle = shape.labelColor || stroke || '#000000';
    ctx.font = `${fontSize}px ${canvasFont()}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(stereo, 0, -hh + 12, width - 10);

    // Draw actor name
    const label = shape.label || 'Actor';
    ctx.font = `bold ${fontSize}px ${canvasFont()}`;
    ctx.fillText(label, 0, 0, width - 10);
  } else {
    // Draw stick figure (person)
    const headRadius = Math.min(width, height) * 0.15;
    const bodyTop = -height / 2 + headRadius * 2 + 5;
    const bodyBottom = height / 2 - headRadius * 2;
    const armY = bodyTop + (bodyBottom - bodyTop) * 0.2;
    const legY = bodyBottom;

    // Head
    ctx.beginPath();
    ctx.arc(0, -height / 2 + headRadius + 2, headRadius, 0, Math.PI * 2);
    ctx.stroke();

    // Body
    ctx.beginPath();
    ctx.moveTo(0, bodyTop);
    ctx.lineTo(0, bodyBottom);
    ctx.stroke();

    // Arms
    ctx.beginPath();
    ctx.moveTo(-hw + 5, armY);
    ctx.lineTo(hw - 5, armY);
    ctx.stroke();

    // Legs
    ctx.beginPath();
    ctx.moveTo(0, legY);
    ctx.lineTo(-hw + 10, height / 2 - 5);
    ctx.moveTo(0, legY);
    ctx.lineTo(hw - 10, height / 2 - 5);
    ctx.stroke();

    // Draw label below
    const label = shape.label || '';
    if (label) {
      const fontSize = Math.min(12, width * 0.2);
      ctx.fillStyle = shape.labelColor || stroke || '#000000';
      ctx.font = `${fontSize}px ${canvasFont()}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(label, 0, height / 2 + 5, width);
    }
  }
};

/**
 * Actor properties with type support.
 */
const actorProperties: PropertyDefinition[] = [
  ...createStandardProperties({ includeLabel: true }),
  {
    key: 'customProperties.actorType',
    label: 'Actor Type',
    type: 'select',
    section: 'custom',
    options: [
      { value: 'person', label: 'Person (stick figure)' },
      { value: 'system', label: 'System' },
      { value: 'external', label: 'External System' },
    ],
    default: 'person',
  },
];

/**
 * Actor shape - UML actor (person, system, or external).
 */
export const seqActorShape: LibraryShapeDefinition = {
  type: 'seq-actor',
  metadata: {
    type: 'seq-actor',
    name: 'Actor',
    category: 'uml-sequence',
    icon: '🧑',
    properties: actorProperties,
    supportsLabel: true,
    supportsIcon: false,
    defaultWidth: 50,
    defaultHeight: 80,
    description: 'UML actor (stick figure, system, or external) for sequence diagrams',
  },
  pathBuilder: (width, height) => {
    // Path defines bounding area for hit testing
    const path = new Path2D();
    const hw = width / 2;
    const hh = height / 2;
    path.rect(-hw, -hh, width, height);
    return path;
  },
  anchors: [
    { position: 'center', x: () => 0, y: () => 0 },
    { position: 'top', x: () => 0, y: (_, h) => -h / 2 },
    { position: 'bottom', x: () => 0, y: (_, h) => h / 2 },
    { position: 'left', x: (w) => -w / 2, y: () => 0 },
    { position: 'right', x: (w) => w / 2, y: () => 0 },
  ],
  customRender: renderActor,
  customLabelRendering: true,
  hitTestMode: 'bounds',
};

// ============================================================================
// Destruction Marker Shape
// ============================================================================

/**
 * Custom render function for destruction marker (X).
 */
const renderDestruction: CustomRenderFunction = (ctx, shape) => {
  const { width, height, stroke } = shape;
  const size = Math.min(width, height) / 2;

  ctx.strokeStyle = stroke || '#000000';
  ctx.lineWidth = (shape.strokeWidth || 2) * 1.5;
  ctx.lineCap = 'round';

  // Draw X
  ctx.beginPath();
  ctx.moveTo(-size, -size);
  ctx.lineTo(size, size);
  ctx.moveTo(-size, size);
  ctx.lineTo(size, -size);
  ctx.stroke();
};

/**
 * Destruction marker shape - X marking object destruction.
 */
export const seqDestructionShape: LibraryShapeDefinition = {
  type: 'seq-destruction',
  metadata: {
    type: 'seq-destruction',
    name: 'Destruction',
    category: 'uml-sequence',
    icon: '✕',
    properties: createStandardProperties({}),
    supportsLabel: false,
    supportsIcon: false,
    defaultWidth: 20,
    defaultHeight: 20,
    aspectRatioLocked: true,
    description: 'Destruction marker (X) for object termination',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    const hw = width / 2;
    const hh = height / 2;
    path.rect(-hw, -hh, width, height);
    return path;
  },
  anchors: [
    { position: 'center', x: () => 0, y: () => 0 },
    { position: 'top', x: () => 0, y: (_, h) => -h / 2 },
    { position: 'bottom', x: () => 0, y: (_, h) => h / 2 },
  ],
  customRender: renderDestruction,
  hitTestMode: 'bounds',
};

// ============================================================================
// State Invariant Shape
// ============================================================================

/**
 * State invariant custom properties.
 */
export interface StateInvariantProperties {
  constraint?: string;
}

/**
 * Custom render function for state invariant.
 * Renders constraint text in curly braces notation or rounded bracket style.
 */
const renderStateInvariant: CustomRenderFunction = (ctx, shape) => {
  const { width, height, stroke, fill } = shape;
  const hw = width / 2;
  const hh = height / 2;

  // Get custom properties
  const customProps = shape.customProperties as StateInvariantProperties | undefined;
  const constraint = customProps?.constraint || shape.label || 'state';

  ctx.strokeStyle = stroke || '#000000';
  ctx.lineWidth = shape.strokeWidth || 1;
  ctx.fillStyle = fill || '#ffffff';

  // Draw rounded rectangle / bracket shape
  const radius = Math.min(hh, 8);
  ctx.beginPath();
  ctx.moveTo(-hw + radius, -hh);
  ctx.lineTo(hw - radius, -hh);
  ctx.quadraticCurveTo(hw, -hh, hw, -hh + radius);
  ctx.lineTo(hw, hh - radius);
  ctx.quadraticCurveTo(hw, hh, hw - radius, hh);
  ctx.lineTo(-hw + radius, hh);
  ctx.quadraticCurveTo(-hw, hh, -hw, hh - radius);
  ctx.lineTo(-hw, -hh + radius);
  ctx.quadraticCurveTo(-hw, -hh, -hw + radius, -hh);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Draw constraint text in curly braces
  const fontSize = Math.min(12, height * 0.5);
  ctx.fillStyle = shape.labelColor || stroke || '#000000';
  ctx.font = `${fontSize}px ${canvasFont()}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`{${constraint}}`, 0, 0, width - 8);
};

/**
 * State invariant properties.
 */
const stateInvariantProperties: PropertyDefinition[] = [
  ...createStandardProperties({ includeLabel: false }),
  {
    key: 'customProperties.constraint',
    label: 'Constraint',
    type: 'string',
    section: 'custom',
    placeholder: 'state == READY',
  },
];

/**
 * State invariant shape - constraint on lifeline state.
 */
export const seqStateInvariantShape: LibraryShapeDefinition = {
  type: 'seq-state-invariant',
  metadata: {
    type: 'seq-state-invariant',
    name: 'State Invariant',
    category: 'uml-sequence',
    icon: '{ }',
    properties: stateInvariantProperties,
    supportsLabel: true,
    supportsIcon: false,
    defaultWidth: 80,
    defaultHeight: 24,
    description: 'State invariant constraint on a lifeline',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    const hw = width / 2;
    const hh = height / 2;
    const radius = Math.min(hh, 8);
    path.moveTo(-hw + radius, -hh);
    path.lineTo(hw - radius, -hh);
    path.quadraticCurveTo(hw, -hh, hw, -hh + radius);
    path.lineTo(hw, hh - radius);
    path.quadraticCurveTo(hw, hh, hw - radius, hh);
    path.lineTo(-hw + radius, hh);
    path.quadraticCurveTo(-hw, hh, -hw, hh - radius);
    path.lineTo(-hw, -hh + radius);
    path.quadraticCurveTo(-hw, -hh, -hw + radius, -hh);
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
  customRender: renderStateInvariant,
  customLabelRendering: true,
  hitTestMode: 'path',
};

// ============================================================================
// Time Constraint Shape
// ============================================================================

/**
 * Time constraint custom properties.
 */
export interface TimeConstraintProperties {
  duration?: string;
  minTime?: string;
  maxTime?: string;
  unit?: 'ms' | 's' | 'min' | 'h';
}

/**
 * Custom render function for time constraint.
 * Renders duration annotation in special UML notation.
 */
const renderTimeConstraint: CustomRenderFunction = (ctx, shape) => {
  const { width, height, stroke, fill } = shape;
  const hw = width / 2;
  const hh = height / 2;

  // Get custom properties
  const customProps = shape.customProperties as TimeConstraintProperties | undefined;
  const duration = customProps?.duration || '';
  const minTime = customProps?.minTime || '';
  const maxTime = customProps?.maxTime || '';
  const unit = customProps?.unit || '';

  ctx.strokeStyle = stroke || '#000000';
  ctx.lineWidth = shape.strokeWidth || 1;
  ctx.fillStyle = fill || '#ffffd0'; // Light yellow for time annotations

  // Draw rounded rectangle
  const radius = Math.min(hh * 0.5, 4);
  ctx.beginPath();
  ctx.moveTo(-hw + radius, -hh);
  ctx.lineTo(hw - radius, -hh);
  ctx.quadraticCurveTo(hw, -hh, hw, -hh + radius);
  ctx.lineTo(hw, hh - radius);
  ctx.quadraticCurveTo(hw, hh, hw - radius, hh);
  ctx.lineTo(-hw + radius, hh);
  ctx.quadraticCurveTo(-hw, hh, -hw, hh - radius);
  ctx.lineTo(-hw, -hh + radius);
  ctx.quadraticCurveTo(-hw, -hh, -hw + radius, -hh);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Format time text
  let timeText = '';
  if (duration) {
    timeText = `{${duration}${unit}}`;
  } else if (minTime && maxTime) {
    timeText = `{${minTime}..${maxTime}${unit}}`;
  } else if (minTime) {
    timeText = `{${minTime}+${unit}}`;
  } else if (maxTime) {
    timeText = `{<${maxTime}${unit}}`;
  } else {
    timeText = shape.label || '{time}';
  }

  // Draw time text
  const fontSize = Math.min(11, height * 0.6);
  ctx.fillStyle = shape.labelColor || stroke || '#000000';
  ctx.font = `${fontSize}px monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(timeText, 0, 0, width - 6);
};

/**
 * Time constraint properties.
 */
const timeConstraintProperties: PropertyDefinition[] = [
  ...createStandardProperties({ includeLabel: false }),
  {
    key: 'customProperties.duration',
    label: 'Duration',
    type: 'string',
    section: 'custom',
    placeholder: '5',
    helpText: 'Exact duration value',
  },
  {
    key: 'customProperties.minTime',
    label: 'Min Time',
    type: 'string',
    section: 'custom',
    placeholder: '1',
    helpText: 'Minimum time (for range)',
  },
  {
    key: 'customProperties.maxTime',
    label: 'Max Time',
    type: 'string',
    section: 'custom',
    placeholder: '10',
    helpText: 'Maximum time (for range)',
  },
  {
    key: 'customProperties.unit',
    label: 'Time Unit',
    type: 'select',
    section: 'custom',
    options: [
      { value: '', label: 'None' },
      { value: 'ms', label: 'Milliseconds (ms)' },
      { value: 's', label: 'Seconds (s)' },
      { value: 'min', label: 'Minutes (min)' },
      { value: 'h', label: 'Hours (h)' },
    ],
    default: '',
  },
];

/**
 * Time constraint shape - duration annotation for sequence diagrams.
 */
export const seqTimeConstraintShape: LibraryShapeDefinition = {
  type: 'seq-time-constraint',
  metadata: {
    type: 'seq-time-constraint',
    name: 'Time Constraint',
    category: 'uml-sequence',
    icon: '⏱',
    properties: timeConstraintProperties,
    supportsLabel: true,
    supportsIcon: false,
    defaultWidth: 60,
    defaultHeight: 20,
    description: 'Time/duration constraint annotation',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    const hw = width / 2;
    const hh = height / 2;
    const radius = Math.min(hh * 0.5, 4);
    path.moveTo(-hw + radius, -hh);
    path.lineTo(hw - radius, -hh);
    path.quadraticCurveTo(hw, -hh, hw, -hh + radius);
    path.lineTo(hw, hh - radius);
    path.quadraticCurveTo(hw, hh, hw - radius, hh);
    path.lineTo(-hw + radius, hh);
    path.quadraticCurveTo(-hw, hh, -hw, hh - radius);
    path.lineTo(-hw, -hh + radius);
    path.quadraticCurveTo(-hw, -hh, -hw + radius, -hh);
    path.closePath();
    return path;
  },
  anchors: [
    { position: 'center', x: () => 0, y: () => 0 },
    { position: 'left', x: (w) => -w / 2, y: () => 0 },
    { position: 'right', x: (w) => w / 2, y: () => 0 },
  ],
  customRender: renderTimeConstraint,
  customLabelRendering: true,
  hitTestMode: 'path',
};

// ============================================================================
// Coregion Shape
// ============================================================================

/**
 * Coregion custom properties.
 */
export interface CoregionProperties {
  patternType?: 'stripes' | 'dots' | 'bracket';
}

/**
 * Custom render function for coregion (concurrent messages region).
 * Renders a region indicating unordered/concurrent message execution.
 */
const renderCoregion: CustomRenderFunction = (ctx, shape) => {
  const { width, height, stroke, fill } = shape;
  const hw = width / 2;
  const hh = height / 2;

  // Get custom properties
  const customProps = shape.customProperties as CoregionProperties | undefined;
  const patternType = customProps?.patternType || 'bracket';

  ctx.strokeStyle = stroke || '#000000';
  ctx.lineWidth = shape.strokeWidth || 2;

  if (patternType === 'stripes') {
    // Draw striped rectangle
    ctx.fillStyle = fill || 'rgba(200, 200, 200, 0.3)';
    ctx.fillRect(-hw, -hh, width, height);

    // Draw diagonal stripes
    ctx.save();
    ctx.beginPath();
    ctx.rect(-hw, -hh, width, height);
    ctx.clip();

    ctx.strokeStyle = stroke || '#888888';
    ctx.lineWidth = 1;
    const stripeSpacing = 8;
    for (let i = -height; i < width + height; i += stripeSpacing) {
      ctx.beginPath();
      ctx.moveTo(-hw + i, -hh);
      ctx.lineTo(-hw + i - height, hh);
      ctx.stroke();
    }
    ctx.restore();

    // Draw border
    ctx.strokeStyle = stroke || '#000000';
    ctx.lineWidth = shape.strokeWidth || 2;
    ctx.strokeRect(-hw, -hh, width, height);
  } else if (patternType === 'dots') {
    // Draw dotted rectangle
    ctx.fillStyle = fill || 'rgba(200, 200, 200, 0.3)';
    ctx.fillRect(-hw, -hh, width, height);

    // Draw dots pattern
    ctx.fillStyle = stroke || '#888888';
    const dotSpacing = 10;
    for (let x = -hw + 5; x < hw; x += dotSpacing) {
      for (let y = -hh + 5; y < hh; y += dotSpacing) {
        ctx.beginPath();
        ctx.arc(x, y, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Draw border
    ctx.strokeStyle = stroke || '#000000';
    ctx.lineWidth = shape.strokeWidth || 2;
    ctx.strokeRect(-hw, -hh, width, height);
  } else {
    // Bracket notation (UML 2.x standard)
    ctx.lineCap = 'square';

    // Left bracket
    ctx.beginPath();
    ctx.moveTo(-hw + 8, -hh);
    ctx.lineTo(-hw, -hh);
    ctx.lineTo(-hw, hh);
    ctx.lineTo(-hw + 8, hh);
    ctx.stroke();

    // Right bracket
    ctx.beginPath();
    ctx.moveTo(hw - 8, -hh);
    ctx.lineTo(hw, -hh);
    ctx.lineTo(hw, hh);
    ctx.lineTo(hw - 8, hh);
    ctx.stroke();
  }
};

/**
 * Coregion properties.
 */
const coregionProperties: PropertyDefinition[] = [
  ...createStandardProperties({}),
  {
    key: 'customProperties.patternType',
    label: 'Pattern',
    type: 'select',
    section: 'custom',
    options: [
      { value: 'bracket', label: 'Bracket (standard)' },
      { value: 'stripes', label: 'Diagonal Stripes' },
      { value: 'dots', label: 'Dots' },
    ],
    default: 'bracket',
  },
];

/**
 * Coregion shape - concurrent/unordered message region.
 */
export const seqCoregionShape: LibraryShapeDefinition = {
  type: 'seq-coregion',
  metadata: {
    type: 'seq-coregion',
    name: 'Coregion',
    category: 'uml-sequence',
    icon: '⟦⟧',
    properties: coregionProperties,
    supportsLabel: false,
    supportsIcon: false,
    defaultWidth: 30,
    defaultHeight: 80,
    description: 'Coregion for concurrent/unordered messages',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    const hw = width / 2;
    const hh = height / 2;
    path.rect(-hw, -hh, width, height);
    return path;
  },
  anchors: [
    { position: 'center', x: () => 0, y: () => 0 },
    { position: 'top', x: () => 0, y: (_, h) => -h / 2 },
    { position: 'bottom', x: () => 0, y: (_, h) => h / 2 },
    { position: 'left', x: (w) => -w / 2, y: () => 0 },
    { position: 'right', x: (w) => w / 2, y: () => 0 },
  ],
  customRender: renderCoregion,
  hitTestMode: 'bounds',
};

// ============================================================================
// Continuation Shape
// ============================================================================

/**
 * Continuation custom properties.
 */
export interface ContinuationProperties {
  continuationLabel?: string;
}

/**
 * Custom render function for continuation.
 * Renders a frame for cross-diagram continuation references.
 */
const renderContinuation: CustomRenderFunction = (ctx, shape) => {
  const { width, height, stroke, fill } = shape;
  const hw = width / 2;
  const hh = height / 2;

  // Get custom properties
  const customProps = shape.customProperties as ContinuationProperties | undefined;
  const continuationLabel = customProps?.continuationLabel || shape.label || 'continue';

  ctx.strokeStyle = stroke || '#000000';
  ctx.lineWidth = shape.strokeWidth || 1;
  ctx.fillStyle = fill || '#ffffff';

  // Draw rounded/hexagonal continuation frame (pill shape)
  const radius = hh;
  ctx.beginPath();
  ctx.moveTo(-hw + radius, -hh);
  ctx.lineTo(hw - radius, -hh);
  ctx.arc(hw - radius, 0, radius, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(-hw + radius, hh);
  ctx.arc(-hw + radius, 0, radius, Math.PI / 2, -Math.PI / 2);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Draw continuation label
  const fontSize = Math.min(14, height * 0.6);
  ctx.fillStyle = shape.labelColor || stroke || '#000000';
  ctx.font = `${fontSize}px ${canvasFont()}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(continuationLabel, 0, 0, width - radius * 2);
};

/**
 * Continuation properties.
 */
const continuationProperties: PropertyDefinition[] = [
  ...createStandardProperties({ includeLabel: false }),
  {
    key: 'customProperties.continuationLabel',
    label: 'Continuation Label',
    type: 'string',
    section: 'custom',
    placeholder: 'continue',
  },
];

/**
 * Continuation shape - cross-diagram continuation reference.
 */
export const seqContinuationShape: LibraryShapeDefinition = {
  type: 'seq-continuation',
  metadata: {
    type: 'seq-continuation',
    name: 'Continuation',
    category: 'uml-sequence',
    icon: '⤴',
    properties: continuationProperties,
    supportsLabel: true,
    supportsIcon: false,
    defaultWidth: 100,
    defaultHeight: 30,
    description: 'Cross-diagram continuation reference',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    const hw = width / 2;
    const hh = height / 2;
    const radius = hh;
    path.moveTo(-hw + radius, -hh);
    path.lineTo(hw - radius, -hh);
    path.arc(hw - radius, 0, radius, -Math.PI / 2, Math.PI / 2);
    path.lineTo(-hw + radius, hh);
    path.arc(-hw + radius, 0, radius, Math.PI / 2, -Math.PI / 2);
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
  customRender: renderContinuation,
  customLabelRendering: true,
  hitTestMode: 'path',
};

// ============================================================================
// Export all sequence diagram shapes
// ============================================================================

/**
 * All UML Sequence Diagram shape definitions.
 */
export const sequenceDiagramShapes: LibraryShapeDefinition[] = [
  seqLifelineShape,
  seqActivationShape,
  seqFragmentShape,
  seqActorShape,
  seqDestructionShape,
  seqStateInvariantShape,
  seqTimeConstraintShape,
  seqCoregionShape,
  seqContinuationShape,
];
