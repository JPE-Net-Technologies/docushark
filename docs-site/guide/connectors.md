# Connectors

Connectors are smart lines that link shapes together. Unlike regular lines, connectors stay attached to their shapes — move a shape and the connector follows.

## Creating Connectors

1. Press `C` or click the connector icon in the toolbar
2. **Hover** over a shape — you'll see **connection points** appear as small circles on the edges
3. **Click** a connection point to start the connector
4. **Click** a connection point on another shape to finish

The connector automatically routes itself between the two shapes.

## Connection Points

Every shape has connection points where connectors can attach:

| Port | Position |
|------|----------|
| `top` | Top center |
| `right` | Right center |
| `bottom` | Bottom center |
| `left` | Left center |
| `topLeft` | Top-left corner |
| `topRight` | Top-right corner |
| `bottomLeft` | Bottom-left corner |
| `bottomRight` | Bottom-right corner |
| `center` | Center of shape |

Connection points become visible when you hover over a shape with the Connector tool active.

## Routing Styles

Configure the connector's routing in the Property Panel:

| Style | Description |
|-------|-------------|
| **Orthogonal** | Right-angle paths that route around shapes (default) |
| **Straight** | Direct line from start to end |
| **Curved** | Smooth curved path |

Orthogonal connectors automatically adjust their path when you move shapes, keeping the diagram tidy.

## Connector Properties

| Property | What It Does |
|----------|--------------|
| **Start/End Arrow** | Choose arrowhead style: none, arrow, triangle, circle, square, diamond |
| **Arrow Size** | Scale the arrowhead size |
| **Label** | Add text to the connector |
| **Label Position** | Where along the path the label appears (0 = start, 1 = end) |
| **Corner Radius** | Rounding on orthogonal route corners |
| **Stroke** | Color, width, and style (solid, dashed, dotted) |

## Labels and Annotations

Click a connector's label area (or use the Property Panel) to add text. Labels float alongside the connector path and move with it.

### Guard Conditions

For activity and flowchart diagrams, connectors support **guard conditions** — text displayed in square brackets near the start of the connector:

- Set the `guardCondition` property (e.g., `[yes]`, `[amount > 100]`)
- Adjust `guardPosition` to control where along the path it appears

### Message Numbering

For sequence diagrams, use the `messageNumber` property to display numbered messages (e.g., `1:`, `2.1:`) near the connector start.

## UML Sequence Markers

Connectors support specialized markers for UML sequence diagrams:

| Marker | Meaning |
|--------|---------|
| `sync` | Synchronous call (filled arrowhead) |
| `async` | Asynchronous call (open arrowhead) |
| `reply` | Return message (dashed line) |
| `create` | Object creation |
| `destroy` | Object destruction |
| `lost` | Lost message |
| `found` | Found message |

Set these via the `startSequenceMarker` and `endSequenceMarker` properties.

## Flow Types

For activity diagrams, connectors have a **flow type**:

| Type | Appearance | Use |
|------|-----------|-----|
| `control` | Solid line | Control flow (default) |
| `object` | Dashed line | Object/data flow |

## Self-Messages

When a connector starts and ends on the same shape (common in sequence diagrams), it automatically routes as a loop to the right. Adjust the loop width with the `selfMessageWidth` property.

## Tips

- **Move connected shapes freely** — connectors update their routes automatically
- **Switch routing style** if a connector's path looks awkward — sometimes straight or curved works better
- **Use orthogonal routing** for clean, professional diagrams
- **Connectors snap** to the nearest connection point as you draw them
