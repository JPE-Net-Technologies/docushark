/**
 * UML Class Diagram shape definitions.
 *
 * This module defines shapes for creating UML class diagrams:
 * - Class (3-compartment box: name/attributes/methods)
 * - Interface, Abstract Class, Enum (class variants with stereotypes)
 * - Package (folder-like container)
 * - Note (dog-eared rectangle)
 * - Relationship indicators (association, aggregation, composition, inheritance, etc.)
 */

import type { LibraryShapeDefinition, CustomRenderFunction } from './ShapeLibraryTypes';
import { createStandardAnchors } from './ShapeLibraryTypes';
import { createStandardProperties } from '../ShapeMetadata';
import type { PropertyDefinition } from '../ShapeMetadata';

/**
 * UML class member (attribute or method).
 */
export interface UMLClassMember {
  /** Member name (including parameters for methods) */
  name: string;
  /** Return type or data type */
  type: string;
  /** Visibility: + public, - private, # protected, ~ package */
  visibility: '+' | '-' | '#' | '~';
  /** True if this is a static member */
  isStatic: boolean;
}

/**
 * Custom render function for UML classes.
 * Renders class name, attributes, and methods in compartments.
 */
const renderUMLClass: CustomRenderFunction = (ctx, shape) => {
  const { width, height, stroke } = shape;
  const hw = width / 2;
  const hh = height / 2;
  const compartmentHeight = height / 3;

  // Get custom properties
  const customProps = shape.customProperties as {
    className?: string;
    attributes?: UMLClassMember[];
    methods?: UMLClassMember[];
    stereotype?: string;
  } | undefined;

  const className = customProps?.className || shape.label || 'ClassName';
  const attributes = customProps?.attributes || [];
  const methods = customProps?.methods || [];
  const stereotype = customProps?.stereotype;

  // Text styling
  const nameFontSize = Math.min(14, compartmentHeight * 0.5);
  const memberFontSize = Math.min(11, compartmentHeight * 0.35);
  const lineHeight = memberFontSize * 1.3;

  ctx.fillStyle = shape.labelColor || stroke || '#000000';

  // Draw stereotype if present
  if (stereotype) {
    ctx.font = `italic ${nameFontSize * 0.75}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`«${stereotype}»`, 0, -hh + compartmentHeight * 0.3, width - 10);
  }

  // Draw class name in first compartment
  ctx.font = `bold ${nameFontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const nameY = stereotype ? -hh + compartmentHeight * 0.65 : -hh + compartmentHeight / 2;
  ctx.fillText(className, 0, nameY, width - 10);

  // Draw attributes in second compartment
  ctx.font = `${memberFontSize}px sans-serif`;
  ctx.textAlign = 'left';

  const attrStartY = -hh + compartmentHeight + 5;
  attributes.forEach((attr, index) => {
    const y = attrStartY + (index + 0.5) * lineHeight;
    if (y > -hh + compartmentHeight * 2 - 5) return; // Don't overflow

    const text = `${attr.visibility} ${attr.name}${attr.type ? ': ' + attr.type : ''}`;
    const x = -hw + 6;

    if (attr.isStatic) {
      // Draw underline for static
      ctx.fillText(text, x, y);
      const metrics = ctx.measureText(text);
      ctx.beginPath();
      ctx.moveTo(x, y + memberFontSize * 0.25);
      ctx.lineTo(x + metrics.width, y + memberFontSize * 0.25);
      ctx.strokeStyle = shape.labelColor || stroke || '#000000';
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      ctx.fillText(text, x, y);
    }
  });

  // Draw methods in third compartment
  const methodStartY = -hh + compartmentHeight * 2 + 5;
  methods.forEach((method, index) => {
    const y = methodStartY + (index + 0.5) * lineHeight;
    if (y > hh - 5) return; // Don't overflow

    const text = `${method.visibility} ${method.name}${method.type ? ': ' + method.type : ''}`;
    const x = -hw + 6;

    if (method.isStatic) {
      // Draw underline for static
      ctx.fillText(text, x, y);
      const metrics = ctx.measureText(text);
      ctx.beginPath();
      ctx.moveTo(x, y + memberFontSize * 0.25);
      ctx.lineTo(x + metrics.width, y + memberFontSize * 0.25);
      ctx.strokeStyle = shape.labelColor || stroke || '#000000';
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      ctx.fillText(text, x, y);
    }
  });
};

/**
 * Custom render function for UML interfaces.
 * Shows stereotype, name, attributes, and methods compartments.
 */
const renderUMLInterface: CustomRenderFunction = (ctx, shape) => {
  const { width, height, stroke } = shape;
  const hw = width / 2;
  const hh = height / 2;
  const stereotypeHeight = 20;
  const nameHeight = 25;
  const bodyHeight = height - stereotypeHeight - nameHeight;
  const attrHeight = bodyHeight / 2;
  const methodHeight = bodyHeight / 2;

  // Get custom properties
  const customProps = shape.customProperties as {
    className?: string;
    attributes?: UMLClassMember[];
    methods?: UMLClassMember[];
  } | undefined;

  const className = customProps?.className || shape.label || 'IInterface';
  const attributes = customProps?.attributes || [];
  const methods = customProps?.methods || [];

  const nameFontSize = Math.min(14, nameHeight * 0.5);
  const memberFontSize = Math.min(11, Math.min(attrHeight, methodHeight) * 0.4);
  const lineHeight = memberFontSize * 1.3;

  ctx.fillStyle = shape.labelColor || stroke || '#000000';

  // Draw <<interface>> stereotype
  ctx.font = `italic ${nameFontSize * 0.75}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('«interface»', 0, -hh + stereotypeHeight / 2, width - 10);

  // Draw interface name
  ctx.font = `bold ${nameFontSize}px sans-serif`;
  ctx.fillText(className, 0, -hh + stereotypeHeight + nameHeight / 2, width - 10);

  // Draw attributes
  ctx.font = `${memberFontSize}px sans-serif`;
  ctx.textAlign = 'left';

  const attrStartY = -hh + stereotypeHeight + nameHeight + 5;
  attributes.forEach((attr, index) => {
    const y = attrStartY + (index + 0.5) * lineHeight;
    if (y > -hh + stereotypeHeight + nameHeight + attrHeight - 5) return;

    const text = `${attr.visibility} ${attr.name}${attr.type ? ': ' + attr.type : ''}`;
    ctx.fillText(text, -hw + 6, y);
  });

  // Draw methods
  const methodStartY = -hh + stereotypeHeight + nameHeight + attrHeight + 5;
  methods.forEach((method, index) => {
    const y = methodStartY + (index + 0.5) * lineHeight;
    if (y > hh - 5) return;

    const text = `${method.visibility} ${method.name}${method.type ? ': ' + method.type : ''}`;
    ctx.fillText(text, -hw + 6, y);
  });
};

/**
 * Custom render function for UML abstract classes.
 */
const renderUMLAbstractClass: CustomRenderFunction = (ctx, shape) => {
  const { width, height, stroke } = shape;
  const hw = width / 2;
  const hh = height / 2;
  const stereotypeHeight = 20;
  const compartmentHeight = (height - stereotypeHeight) / 2;

  // Get custom properties
  const customProps = shape.customProperties as {
    className?: string;
    attributes?: UMLClassMember[];
    methods?: UMLClassMember[];
  } | undefined;

  const className = customProps?.className || shape.label || 'AbstractClass';
  const attributes = customProps?.attributes || [];
  // Methods would go in a third section but space is limited with stereotype

  const nameFontSize = Math.min(14, compartmentHeight * 0.4);
  const memberFontSize = Math.min(11, compartmentHeight * 0.3);
  const lineHeight = memberFontSize * 1.3;

  ctx.fillStyle = shape.labelColor || stroke || '#000000';

  // Draw <<abstract>> stereotype
  ctx.font = `italic ${nameFontSize * 0.75}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('«abstract»', 0, -hh + stereotypeHeight / 2, width - 10);

  // Draw class name (italic for abstract)
  ctx.font = `italic bold ${nameFontSize}px sans-serif`;
  ctx.fillText(className, 0, -hh + stereotypeHeight + compartmentHeight / 2, width - 10);

  // Draw attributes
  ctx.font = `${memberFontSize}px sans-serif`;
  ctx.textAlign = 'left';

  const attrStartY = -hh + stereotypeHeight + compartmentHeight + 5;
  attributes.forEach((attr, index) => {
    const y = attrStartY + (index + 0.5) * lineHeight;
    if (y > hh - 5) return;

    const text = `${attr.visibility} ${attr.name}${attr.type ? ': ' + attr.type : ''}`;
    ctx.fillText(text, -hw + 6, y);
  });
};

/**
 * Custom render function for UML enumerations.
 */
const renderUMLEnum: CustomRenderFunction = (ctx, shape) => {
  const { width, height, stroke } = shape;
  const hw = width / 2;
  const hh = height / 2;
  const stereotypeHeight = 20;
  const nameHeight = 25;

  // Get custom properties
  const customProps = shape.customProperties as {
    className?: string;
    values?: string[];
  } | undefined;

  const enumName = customProps?.className || shape.label || 'EnumType';
  const values = customProps?.values || [];

  const nameFontSize = Math.min(14, nameHeight * 0.5);
  const valueFontSize = Math.min(11, 14);
  const lineHeight = valueFontSize * 1.3;

  ctx.fillStyle = shape.labelColor || stroke || '#000000';

  // Draw <<enumeration>> stereotype
  ctx.font = `italic ${nameFontSize * 0.75}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('«enumeration»', 0, -hh + stereotypeHeight / 2, width - 10);

  // Draw enum name
  ctx.font = `bold ${nameFontSize}px sans-serif`;
  ctx.fillText(enumName, 0, -hh + stereotypeHeight + nameHeight / 2, width - 10);

  // Draw enum values
  ctx.font = `${valueFontSize}px sans-serif`;
  ctx.textAlign = 'left';

  const valueStartY = -hh + stereotypeHeight + nameHeight + 5;
  values.forEach((value, index) => {
    const y = valueStartY + (index + 0.5) * lineHeight;
    if (y > hh - 5) return;

    ctx.fillText(value, -hw + 6, y);
  });
};

/**
 * UML class properties with custom fields.
 */
const umlClassProperties: PropertyDefinition[] = [
  ...createStandardProperties({ includeLabel: false }),
  {
    // Top-level BaseShape field — see the matching note in erdShapes.ts. Must be
    // 'appearance' (top-level binding), not 'custom' (customProperties), or the
    // Text Color control silently does nothing.
    key: 'labelColor',
    label: 'Text Color',
    type: 'color',
    section: 'appearance',
  },
];

/**
 * Class shape - 3-compartment box.
 * Top: class name, Middle: attributes, Bottom: methods.
 */
export const umlClassShape: LibraryShapeDefinition = {
  type: 'uml-class',
  metadata: {
    type: 'uml-class',
    name: 'Class',
    category: 'uml-class',
    icon: '▤',
    properties: umlClassProperties,
    supportsLabel: false, // Custom rendering handles text
    supportsIcon: false,
    defaultWidth: 160,
    defaultHeight: 120,
    description: 'UML class with name, attributes, and methods compartments',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    const hw = width / 2;
    const hh = height / 2;
    const compartmentHeight = height / 3;

    // Main rectangle
    path.rect(-hw, -hh, width, height);

    // First divider (name/attributes)
    path.moveTo(-hw, -hh + compartmentHeight);
    path.lineTo(hw, -hh + compartmentHeight);

    // Second divider (attributes/methods)
    path.moveTo(-hw, -hh + compartmentHeight * 2);
    path.lineTo(hw, -hh + compartmentHeight * 2);

    return path;
  },
  anchors: createStandardAnchors(),
  customRender: renderUMLClass,
  customLabelRendering: true,
};

/**
 * Interface shape - class with stereotype indicator.
 * Represents an interface contract with attributes and methods.
 */
export const umlInterfaceShape: LibraryShapeDefinition = {
  type: 'uml-interface',
  metadata: {
    type: 'uml-interface',
    name: 'Interface',
    category: 'uml-class',
    icon: '⟨I⟩',
    properties: umlClassProperties,
    supportsLabel: false, // Custom rendering handles text
    supportsIcon: false,
    defaultWidth: 160,
    defaultHeight: 140,
    description: 'UML interface with <<interface>> stereotype',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    const hw = width / 2;
    const hh = height / 2;
    const stereotypeHeight = 20;
    const nameHeight = 25;
    const bodyHeight = height - stereotypeHeight - nameHeight;
    const attrHeight = bodyHeight / 2;

    // Main rectangle
    path.rect(-hw, -hh, width, height);

    // Stereotype divider
    path.moveTo(-hw, -hh + stereotypeHeight);
    path.lineTo(hw, -hh + stereotypeHeight);

    // Name divider (after stereotype + name section)
    path.moveTo(-hw, -hh + stereotypeHeight + nameHeight);
    path.lineTo(hw, -hh + stereotypeHeight + nameHeight);

    // Attributes/Methods divider
    path.moveTo(-hw, -hh + stereotypeHeight + nameHeight + attrHeight);
    path.lineTo(hw, -hh + stereotypeHeight + nameHeight + attrHeight);

    return path;
  },
  anchors: createStandardAnchors(),
  customRender: renderUMLInterface,
  customLabelRendering: true,
};

/**
 * Abstract Class shape - class with abstract indicator.
 * Represents an abstract class that cannot be instantiated.
 */
export const umlAbstractClassShape: LibraryShapeDefinition = {
  type: 'uml-abstract-class',
  metadata: {
    type: 'uml-abstract-class',
    name: 'Abstract Class',
    category: 'uml-class',
    icon: '⟨A⟩',
    properties: umlClassProperties,
    supportsLabel: false, // Custom rendering handles text
    supportsIcon: false,
    defaultWidth: 160,
    defaultHeight: 120,
    description: 'UML abstract class with <<abstract>> stereotype',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    const hw = width / 2;
    const hh = height / 2;
    const stereotypeHeight = 20;
    const compartmentHeight = (height - stereotypeHeight) / 2;

    // Main rectangle
    path.rect(-hw, -hh, width, height);

    // Stereotype divider
    path.moveTo(-hw, -hh + stereotypeHeight);
    path.lineTo(hw, -hh + stereotypeHeight);

    // Second divider (name/methods)
    path.moveTo(-hw, -hh + stereotypeHeight + compartmentHeight);
    path.lineTo(hw, -hh + stereotypeHeight + compartmentHeight);

    return path;
  },
  anchors: createStandardAnchors(),
  customRender: renderUMLAbstractClass,
  customLabelRendering: true,
};

/**
 * Enum shape - class with enumeration stereotype.
 * Represents an enumeration type.
 */
export const umlEnumShape: LibraryShapeDefinition = {
  type: 'uml-enum',
  metadata: {
    type: 'uml-enum',
    name: 'Enumeration',
    category: 'uml-class',
    icon: '⟨E⟩',
    properties: umlClassProperties,
    supportsLabel: false, // Custom rendering handles text
    supportsIcon: false,
    defaultWidth: 140,
    defaultHeight: 100,
    description: 'UML enumeration with <<enumeration>> stereotype',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    const hw = width / 2;
    const hh = height / 2;
    const stereotypeHeight = 20;
    const nameHeight = 25;

    // Main rectangle
    path.rect(-hw, -hh, width, height);

    // Stereotype divider
    path.moveTo(-hw, -hh + stereotypeHeight);
    path.lineTo(hw, -hh + stereotypeHeight);

    // Name divider (stereotype/name | values)
    path.moveTo(-hw, -hh + stereotypeHeight + nameHeight);
    path.lineTo(hw, -hh + stereotypeHeight + nameHeight);

    return path;
  },
  anchors: createStandardAnchors(),
  customRender: renderUMLEnum,
  customLabelRendering: true,
};

/**
 * Package shape - folder-like container.
 * Represents a namespace or module grouping.
 */
export const umlPackageShape: LibraryShapeDefinition = {
  type: 'uml-package',
  metadata: {
    type: 'uml-package',
    name: 'Package',
    category: 'uml-class',
    icon: '📁',
    properties: createStandardProperties({ includeLabel: true }),
    supportsLabel: true,
    supportsIcon: false,
    defaultWidth: 200,
    defaultHeight: 150,
    description: 'UML package for grouping related classes',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    const hw = width / 2;
    const hh = height / 2;
    const tabWidth = width * 0.35;
    const tabHeight = 20;

    // Tab (top-left)
    path.moveTo(-hw, -hh);
    path.lineTo(-hw, -hh - tabHeight);
    path.lineTo(-hw + tabWidth, -hh - tabHeight);
    path.lineTo(-hw + tabWidth + 10, -hh);

    // Main body
    path.moveTo(-hw, -hh);
    path.lineTo(hw, -hh);
    path.lineTo(hw, hh);
    path.lineTo(-hw, hh);
    path.closePath();

    return path;
  },
  anchors: [
    { position: 'center', x: () => 0, y: () => 0 },
    { position: 'top', x: () => 0, y: (_, h) => -h / 2 },
    { position: 'right', x: (w) => w / 2, y: () => 0 },
    { position: 'bottom', x: () => 0, y: (_, h) => h / 2 },
    { position: 'left', x: (w) => -w / 2, y: () => 0 },
  ],
  hitTestMode: 'bounds',
};

/**
 * Note shape - dog-eared rectangle.
 * For adding comments and annotations to diagrams.
 */
export const umlNoteShape: LibraryShapeDefinition = {
  type: 'uml-note',
  metadata: {
    type: 'uml-note',
    name: 'Note',
    category: 'uml-class',
    icon: '📝',
    properties: createStandardProperties({ includeLabel: true }),
    supportsLabel: true,
    supportsIcon: false,
    defaultWidth: 120,
    defaultHeight: 80,
    description: 'Annotation or comment note',
  },
  pathBuilder: (width, height) => {
    const path = new Path2D();
    const hw = width / 2;
    const hh = height / 2;
    const foldSize = 15;

    // Main shape with folded corner (top-right)
    path.moveTo(-hw, -hh);
    path.lineTo(hw - foldSize, -hh);
    path.lineTo(hw, -hh + foldSize);
    path.lineTo(hw, hh);
    path.lineTo(-hw, hh);
    path.closePath();

    // Fold line
    path.moveTo(hw - foldSize, -hh);
    path.lineTo(hw - foldSize, -hh + foldSize);
    path.lineTo(hw, -hh + foldSize);

    return path;
  },
  anchors: createStandardAnchors(),
};

/**
 * All UML Class Diagram shape definitions.
 *
 * Note: UML relationship connectors (Association, Aggregation, Composition,
 * Inheritance, Realization, Dependency) are now handled via connector properties
 * (connectorType: 'uml-class', startUMLMarker, endUMLMarker, lineStyle) instead
 * of standalone shapes. See PropertyPanel's "UML Markers" section for presets.
 */
export const umlClassShapes: LibraryShapeDefinition[] = [
  umlClassShape,
  umlInterfaceShape,
  umlAbstractClassShape,
  umlEnumShape,
  umlPackageShape,
  umlNoteShape,
];
