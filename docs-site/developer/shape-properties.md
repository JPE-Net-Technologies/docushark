---
title: Shape Properties
description: Reference for every shape property in DocuShark — appearance, position, behavior, and metadata fields.
---

# Shape Properties

Every shape in DocuShark has properties that control its appearance and behavior. This reference covers all available properties.

## Common Properties

These properties are available on all shapes:

### Position & Size

| Property | Type | Description |
|----------|------|-------------|
| `x` | number | X coordinate (world space) |
| `y` | number | Y coordinate (world space) |
| `width` | number | Shape width in pixels |
| `height` | number | Shape height in pixels |
| `rotation` | number | Rotation angle in **radians** (the property panel edits it in degrees) |

### Appearance

| Property | Type | Description |
|----------|------|-------------|
| `fill` | string \| null | Fill color (hex, rgb, or named color); `null` for no fill |
| `stroke` | string \| null | Stroke color; `null` for no stroke |
| `strokeWidth` | number | Stroke width in world units |
| `opacity` | number | Overall shape opacity, `0`–`1` |

### Shadow

Shadows are opt-in on the shapes that support them (such as groups) via a single
`shadowConfig` object — see `ShadowConfig` in `src/shapes/GroupStyles.ts` for its
fields (color, blur, offset). It is not a flat per-shape property.

### State

| Property | Type | Description |
|----------|------|-------------|
| `locked` | boolean | Prevent editing |
| `visible` | boolean | Shape visibility |
| `opacity` | number | Overall opacity (0-1) |

## Rectangle

Additional properties for rectangles:

| Property | Type | Description |
|----------|------|-------------|
| `cornerRadius` | number | Rounded corner radius |

## Ellipse

Ellipses add `radiusX` and `radiusY` (the horizontal and vertical radii) on top of the common properties.

## Line

| Property | Type | Description |
|----------|------|-------------|
| `x` | number | Start point X (the shape's base position) |
| `y` | number | Start point Y |
| `x2` | number | End point X |
| `y2` | number | End point Y |
| `startArrow` | boolean | Arrowhead at the start |
| `endArrow` | boolean | Arrowhead at the end |
| `lineStyle` | enum | `solid` or `dashed` |

## Text

| Property | Type | Description |
|----------|------|-------------|
| `text` | string | Text content |
| `fontFamily` | string | Font family name |
| `fontSize` | number | Font size |
| `textAlign` | enum | `left`, `center`, `right` |
| `verticalAlign` | enum | `top`, `middle`, `bottom` |
| `width` | number | Text box width |
| `height` | number | Text box height |

Text colour comes from the common `fill` property — there is no separate `textColor` field.

## Connector

| Property | Type | Description |
|----------|------|-------------|
| `routingMode` | enum | `orthogonal`, `curved`, `straight` |
| `startShapeId` / `endShapeId` | string | The shapes the connector links |
| `startAnchor` / `endAnchor` | AnchorPosition | Which anchor on each shape (`top`/`right`/`bottom`/`left`/`center`) |
| `waypoints` | Point[] | Manual routing points |
| `startArrowStyle` | enum | Arrowhead at start: `none`, `triangle`, `open`, `diamond` |
| `endArrowStyle` | enum | Arrowhead at end (same options) |
| `lineStyle` | enum | `solid` or `dashed` |
| `label` | string | Connector label text |
| `labelPosition` | number | Label position (0-1 along path) |
| `flowType` | enum | `control` (solid, default), `object` (dashed) — activity diagram data vs. control flow |

Sequence-diagram-specific connector semantics (sync/async markers, guard conditions, message numbering, self-messages) are covered in DocuShark's Software Engineering guides, not this reference.

### Connection Ports

The five standard connection anchors (`STANDARD_ANCHOR_POSITIONS`) are:

| Port | Position |
|------|----------|
| `top` | Top center |
| `right` | Right center |
| `bottom` | Bottom center |
| `left` | Left center |
| `center` | Center of shape |

Some library shapes (UML classes, ERD entities) expose extra anchors on their individual rows or compartments beyond these five.

## Group

| Property | Type | Description |
|----------|------|-------------|
| `childIds` | string[] | Array of child shape IDs |
| `showBackground` | boolean | Draw a background behind the children |
| `backgroundColor` | string | Group background color |
| `backgroundPadding` | number | Padding around the children |

Groups also support shadows via `shadowConfig` (see [Shadow](#shadow)).

## Embedded Images & Files

There is no standalone image shape. Embedded images and files use the **`file`**
shape (`FileShape`) — dragged onto the canvas — and decorative shape icons use the
common `iconId` property. See [Embedded Files](/guide/embedded-files).

## Flowchart Shapes

Flowchart shapes inherit common properties plus shape-specific ones:

### Process

Standard rectangle with optional corner radius.

### Decision

Diamond shape for yes/no branches.

### Terminator

Pill shape (rounded ends).

### Data (Parallelogram)

Parallelogram for input/output.

### Document

Rectangle with wavy bottom edge.

### Database

Cylinder shape.

## UML Shapes

### Class

| Property | Type | Description |
|----------|------|-------------|
| `className` | string | Class name |
| `stereotype` | string | UML stereotype (e.g., `«interface»`) |
| `attributes` | Attribute[] | Class attributes |
| `methods` | Method[] | Class methods |
| `showAttributes` | boolean | Display attributes section |
| `showMethods` | boolean | Display methods section |

#### Attribute Format

```json
{
  "visibility": "+",  // +, -, #, ~
  "name": "attributeName",
  "type": "string",
  "default": "value"
}
```

#### Method Format

```json
{
  "visibility": "+",
  "name": "methodName",
  "parameters": [{ "name": "param", "type": "string" }],
  "returnType": "void"
}
```

### Actor

Stick figure for use case diagrams.

| Property | Type | Description |
|----------|------|-------------|
| `label` | string | Actor name |

### Use Case

Ellipse with centered label.

## ERD Shapes

### Entity

| Property | Type | Description |
|----------|------|-------------|
| `entityName` | string | Table/entity name |
| `attributes` | ERDAttribute[] | Entity attributes |
| `isWeak` | boolean | Weak entity (double border) |

#### ERD Attribute Format

```json
{
  "name": "attribute_name",
  "type": "VARCHAR(255)",
  "isPrimaryKey": true,
  "isForeignKey": false,
  "isNullable": false
}
```

### Relationship

Diamond shape for relationships.

| Property | Type | Description |
|----------|------|-------------|
| `relationshipName` | string | Relationship name |
| `isIdentifying` | boolean | Identifying relationship |

## Property Panel Sections

The Property Panel organizes properties into these sections (the `PropertySection`
values in `src/shapes/ShapeMetadata.ts`):

- **appearance** — fill, stroke, opacity
- **dimensions** — position, size, rotation
- **label** — text content and typography
- **icon** — shape icon
- **endpoints** — line/connector arrowheads
- **routing** — connector routing
- **custom** — type-specific properties

## Programmatic Access

Access shape properties via the document store:

```javascript
// Get a shape
const shape = documentStore.getShape(shapeId);

// Read properties
console.log(shape.fill, shape.strokeWidth);

// Update properties
documentStore.updateShape(shapeId, {
  fill: '#ff0000',
  strokeWidth: 2
});
```
