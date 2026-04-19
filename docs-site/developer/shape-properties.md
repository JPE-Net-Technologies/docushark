# Shape Properties

Every shape in Diagrammer has properties that control its appearance and behavior. This reference covers all available properties.

## Common Properties

These properties are available on all shapes:

### Position & Size

| Property | Type | Description |
|----------|------|-------------|
| `x` | number | X coordinate (world space) |
| `y` | number | Y coordinate (world space) |
| `width` | number | Shape width in pixels |
| `height` | number | Shape height in pixels |
| `rotation` | number | Rotation angle in degrees |

### Appearance

| Property | Type | Description |
|----------|------|-------------|
| `fill` | string | Fill color (hex, rgb, or named color) |
| `fillOpacity` | number | Fill opacity (0-1) |
| `stroke` | string | Stroke color |
| `strokeWidth` | number | Stroke width in pixels |
| `strokeOpacity` | number | Stroke opacity (0-1) |
| `strokeStyle` | enum | `solid`, `dashed`, `dotted` |
| `strokeDashArray` | number[] | Custom dash pattern |

### Shadow

| Property | Type | Description |
|----------|------|-------------|
| `shadowEnabled` | boolean | Whether shadow is visible |
| `shadowColor` | string | Shadow color |
| `shadowBlur` | number | Shadow blur radius |
| `shadowOffsetX` | number | Horizontal shadow offset |
| `shadowOffsetY` | number | Vertical shadow offset |

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
| `cornerRadii` | number[4] | Individual corner radii [tl, tr, br, bl] |

## Ellipse

Ellipses use only common properties. The shape is defined by its bounding box.

## Line

| Property | Type | Description |
|----------|------|-------------|
| `x1` | number | Start point X |
| `y1` | number | Start point Y |
| `x2` | number | End point X |
| `y2` | number | End point Y |
| `startArrow` | enum | Arrow at start: `none`, `arrow`, `triangle`, `circle`, `square`, `diamond` |
| `endArrow` | enum | Arrow at end (same options) |
| `arrowSize` | number | Arrow size multiplier |

## Text

| Property | Type | Description |
|----------|------|-------------|
| `text` | string | Text content |
| `fontFamily` | string | Font family name |
| `fontSize` | number | Font size in points |
| `fontWeight` | enum | `normal`, `bold` |
| `fontStyle` | enum | `normal`, `italic` |
| `textDecoration` | enum | `none`, `underline`, `strikethrough` |
| `textAlign` | enum | `left`, `center`, `right` |
| `verticalAlign` | enum | `top`, `middle`, `bottom` |
| `lineHeight` | number | Line height multiplier |
| `letterSpacing` | number | Letter spacing in pixels |
| `textColor` | string | Text color |
| `padding` | number | Internal padding |

## Connector

| Property | Type | Description |
|----------|------|-------------|
| `routingStyle` | enum | `orthogonal`, `curved`, `straight` |
| `startAnchor` | object | Start connection: `{ shapeId, port }` |
| `endAnchor` | object | End connection: `{ shapeId, port }` |
| `waypoints` | Point[] | Manual routing points |
| `startArrow` | enum | Arrow at start |
| `endArrow` | enum | Arrow at end |
| `cornerRadius` | number | Corner rounding for orthogonal |
| `label` | string | Connector label text |
| `labelPosition` | number | Label position (0-1 along path) |

### Connection Ports

Shapes have connection ports at these positions:

| Port | Position |
|------|----------|
| `top` | Top center |
| `right` | Right center |
| `bottom` | Bottom center |
| `left` | Left center |
| `topLeft` | Top left corner |
| `topRight` | Top right corner |
| `bottomLeft` | Bottom left corner |
| `bottomRight` | Bottom right corner |
| `center` | Center of shape |

## Group

| Property | Type | Description |
|----------|------|-------------|
| `children` | string[] | Array of child shape IDs |
| `collapsed` | boolean | Whether group is collapsed |
| `clipContent` | boolean | Clip children to group bounds |
| `backgroundFill` | string | Group background color |
| `backgroundOpacity` | number | Background opacity |
| `padding` | number | Internal padding |

## Image

| Property | Type | Description |
|----------|------|-------------|
| `src` | string | Image source (blob:// or data:) |
| `preserveAspectRatio` | boolean | Maintain proportions |
| `objectFit` | enum | `fill`, `contain`, `cover` |

## Flowchart Shapes

Flowchart shapes inherit common properties plus shape-specific ones:

### Process

Standard rectangle with optional corner radius.

### Decision

Diamond shape for yes/no branches.

| Property | Type | Description |
|----------|------|-------------|
| `yesLabel` | string | "Yes" branch label |
| `noLabel` | string | "No" branch label |

### Terminator

Pill shape (rounded ends).

### Data (Parallelogram)

| Property | Type | Description |
|----------|------|-------------|
| `skewAngle` | number | Parallelogram angle |

### Document

Rectangle with wavy bottom edge.

### Database

Cylinder shape.

| Property | Type | Description |
|----------|------|-------------|
| `topHeight` | number | Height of cylinder cap |

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

The Property Panel organizes properties into sections:

1. **Transform** - Position, size, rotation
2. **Fill** - Fill color, gradient, opacity
3. **Stroke** - Border color, width, style
4. **Text** - Font, size, alignment (when applicable)
5. **Shadow** - Shadow settings
6. **Effects** - Opacity, blend mode
7. **Shape** - Type-specific properties

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
