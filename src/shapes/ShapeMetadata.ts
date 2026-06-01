/**
 * Shape metadata types for UI-driven property rendering.
 *
 * This module defines the metadata structure that shapes use to declare
 * their properties for the PropertyPanel. This enables a generic, extensible
 * property editor that doesn't require code changes for new shape types.
 */

import type { Shape } from './Shape';

/**
 * Shape library categories for organization.
 */
export type ShapeLibraryCategory =
  | 'basic'        // Rectangle, Ellipse, Line, Text
  | 'flowchart'    // Process, Decision, Terminator, etc.
  | 'erd'          // Entity-Relationship diagrams (Crow's Foot)
  | 'uml-class'    // Class diagrams
  | 'uml-usecase'  // Use case diagrams
  | 'uml-sequence' // Sequence diagrams
  | 'uml-activity' // UML Activity diagrams
  | 'custom';      // User-defined shapes

/**
 * Property types supported by the PropertyPanel.
 */
export type PropertyType =
  | 'number'   // Numeric input with optional min/max/step
  | 'string'   // Text input
  | 'color'    // Color picker
  | 'boolean'  // Checkbox/toggle
  | 'select'   // Dropdown with predefined options
  | 'slider';  // Slider with min/max/step

/**
 * Property section for grouping in the PropertyPanel.
 */
export type PropertySection =
  | 'appearance'  // Fill, stroke, opacity
  | 'dimensions'  // Width, height, position
  | 'label'       // Label text and styling
  | 'icon'        // Icon selection and sizing
  | 'endpoints'   // Connector endpoints
  | 'routing'     // Connector routing
  | 'custom';     // Shape-specific custom properties

/**
 * Definition for a single editable property.
 *
 * Used by PropertyPanel to render appropriate controls.
 */
export interface PropertyDefinition {
  /** Property key on the shape object */
  key: string;

  /** Display label in the UI */
  label: string;

  /** Type of property (determines control type) */
  type: PropertyType;

  /** Section to group this property under */
  section: PropertySection;

  /** Minimum value (for number/slider) */
  min?: number;

  /** Maximum value (for number/slider) */
  max?: number;

  /** Step increment (for number/slider) */
  step?: number;

  /** Options for select type */
  options?: Array<{ value: string; label: string }>;

  /** Default value for new shapes */
  default?: unknown;

  /** Placeholder text for string inputs */
  placeholder?: string;

  /** Whether this property is required */
  required?: boolean;

  /** Condition function to show/hide this property */
  condition?: (shape: Shape) => boolean;

  /** Help text/tooltip */
  helpText?: string;

  /** For type === 'color': allow the contrast-aware "Automatic" sentinel. */
  colorAllowAuto?: boolean;
}

/**
 * Complete metadata for a shape type.
 *
 * Registered alongside the ShapeHandler to enable:
 * - Dynamic PropertyPanel rendering
 * - Shape picker UI with icons and names
 * - Tool registration with shortcuts
 */
export interface ShapeMetadata {
  /** Shape type identifier (matches Shape.type) */
  type: string;

  /** Human-readable display name */
  name: string;

  /** Category for organization in shape picker */
  category: ShapeLibraryCategory;

  /** Icon for toolbar/picker (Unicode char or SVG string) */
  icon: string;

  /** Keyboard shortcut (single letter, no modifiers) */
  shortcut?: string;

  /** Editable properties for PropertyPanel */
  properties: PropertyDefinition[];

  /** Whether this shape supports labels */
  supportsLabel: boolean;

  /** Whether this shape supports icons */
  supportsIcon: boolean;

  /** Default width for new shapes */
  defaultWidth: number;

  /** Default height for new shapes */
  defaultHeight: number;

  /** Whether aspect ratio should be locked during resize */
  aspectRatioLocked?: boolean;

  /** Description for tooltips/help */
  description?: string;

  /** Extension data for specialized shapes (e.g., UML-specific) */
  extensionData?: Record<string, unknown>;
}

/**
 * Standard appearance properties shared by most shapes.
 */
export const STANDARD_APPEARANCE_PROPERTIES: PropertyDefinition[] = [
  {
    key: 'fill',
    label: 'Fill',
    type: 'color',
    section: 'appearance',
    colorAllowAuto: true,
  },
  {
    key: 'stroke',
    label: 'Stroke',
    type: 'color',
    section: 'appearance',
    colorAllowAuto: true,
  },
  {
    key: 'strokeWidth',
    label: 'Stroke Width',
    type: 'number',
    section: 'appearance',
    min: 0,
    max: 20,
    step: 1,
  },
  {
    key: 'opacity',
    label: 'Opacity',
    type: 'slider',
    section: 'appearance',
    min: 0,
    max: 1,
    step: 0.1,
  },
];

/**
 * Standard dimension properties for shapes with width/height.
 */
export const STANDARD_DIMENSION_PROPERTIES: PropertyDefinition[] = [
  {
    key: 'x',
    label: 'X',
    type: 'number',
    section: 'dimensions',
    step: 1,
  },
  {
    key: 'y',
    label: 'Y',
    type: 'number',
    section: 'dimensions',
    step: 1,
  },
  {
    key: 'width',
    label: 'Width',
    type: 'number',
    section: 'dimensions',
    min: 1,
    step: 1,
  },
  {
    key: 'height',
    label: 'Height',
    type: 'number',
    section: 'dimensions',
    min: 1,
    step: 1,
  },
  {
    key: 'rotation',
    label: 'Rotation',
    type: 'number',
    section: 'dimensions',
    min: -180,
    max: 180,
    step: 1,
    helpText: 'Rotation in degrees',
  },
];

/**
 * Standard label properties for shapes that support labels.
 */
export const STANDARD_LABEL_PROPERTIES: PropertyDefinition[] = [
  {
    key: 'label',
    label: 'Text',
    type: 'string',
    section: 'label',
    placeholder: 'Enter label...',
  },
  {
    key: 'labelFontSize',
    label: 'Font Size',
    type: 'number',
    section: 'label',
    min: 8,
    max: 72,
    step: 1,
  },
  {
    key: 'labelColor',
    label: 'Color',
    type: 'color',
    section: 'label',
    colorAllowAuto: true,
  },
  {
    key: 'labelOverflow',
    label: 'Overflow',
    type: 'select',
    section: 'label',
    options: [
      { value: 'overflow', label: 'Overflow' },
      { value: 'squeeze-into', label: 'Shrink to fit' },
      { value: 'break-word', label: 'Break words' },
    ],
    default: 'overflow',
    helpText: 'How the label behaves when it is larger than the shape',
  },
];

/**
 * Standard icon properties for shapes that support icons.
 */
export const STANDARD_ICON_PROPERTIES: PropertyDefinition[] = [
  {
    key: 'iconId',
    label: 'Icon',
    type: 'string', // Rendered as IconPicker in PropertyPanel
    section: 'icon',
  },
  {
    key: 'iconSize',
    label: 'Size',
    type: 'number',
    section: 'icon',
    min: 12,
    max: 64,
    step: 4,
  },
  {
    key: 'iconPadding',
    label: 'Padding',
    type: 'number',
    section: 'icon',
    min: 0,
    max: 20,
    step: 2,
  },
];

/**
 * Create standard properties for a shape with width/height/label/icon support.
 */
export function createStandardProperties(options: {
  includeCornerRadius?: boolean;
  includeDimensions?: boolean;
  includeLabel?: boolean;
  includeIcon?: boolean;
} = {}): PropertyDefinition[] {
  const props: PropertyDefinition[] = [...STANDARD_APPEARANCE_PROPERTIES];

  if (options.includeCornerRadius) {
    props.push({
      key: 'cornerRadius',
      label: 'Corner Radius',
      type: 'number',
      section: 'appearance',
      min: 0,
      max: 50,
      step: 1,
    });
  }

  if (options.includeDimensions !== false) {
    props.push(...STANDARD_DIMENSION_PROPERTIES);
  }

  if (options.includeLabel) {
    props.push(...STANDARD_LABEL_PROPERTIES);
  }

  if (options.includeIcon) {
    props.push(...STANDARD_ICON_PROPERTIES);
  }

  return props;
}
