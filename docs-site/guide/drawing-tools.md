# Drawing Tools

Diagrammer gives you a set of drawing tools for creating and manipulating shapes. Switch between them using the toolbar or keyboard shortcuts.

## Select Tool (`V`)

The default tool for selecting and manipulating shapes.

- **Click** a shape to select it
- **Shift+Click** to add or remove shapes from your selection
- **Drag on empty canvas** to marquee-select multiple shapes
- **Drag a selected shape** to move it
- **Drag a handle** to resize

::: tip
Press `V` any time to get back to the Select tool. It's your home base.
:::

## Shape Tools

### Rectangle (`R`)

Click and drag to create a rectangle. Hold **Shift** for a perfect square.

Rectangles support adjustable corner radius — use the Property Panel to round the corners.

### Ellipse (`O`)

Click and drag to create an ellipse. Hold **Shift** for a perfect circle.

### Line (`L`)

Click to set the start point, then click again to set the end point. Lines can have arrowheads at either end — configure them in the Property Panel.

### Text (`T`)

Click anywhere on the canvas to place a text box, then start typing. Click outside or press `Escape` to finish.

**Double-click** any existing shape to edit its text inline.

## Hand Tool (`H`)

Pan the canvas without accidentally selecting shapes. Useful when you want to navigate without worrying about clicking on shapes.

::: tip
You don't need to switch to the Hand tool just to pan — holding **Space** temporarily activates panning with any tool.
:::

## Shape Manipulation

### Moving Shapes

- **Drag** selected shapes to move them
- **Arrow keys** nudge selected shapes by 10px
- **Shift+Arrow** nudges by 50px for bigger moves

### Resizing

Select a shape to see its resize handles:

- **Corner handles** resize proportionally (hold Shift to unlock free resize)
- **Edge handles** resize in one direction only

### Rotating

1. Select a shape
2. Hover near a corner handle until the cursor changes to a rotation icon
3. Drag to rotate

Hold **Shift** while rotating to snap to 15° increments.

### Grouping

Combine multiple shapes into a single unit:

1. Select the shapes you want to group
2. Press `Ctrl+G` (or right-click → **Group**)

To ungroup: `Ctrl+Shift+G` (or right-click → **Ungroup**)

Groups can be nested — group shapes that are already inside groups to create hierarchies.

### Alignment

Select multiple shapes, then use the alignment buttons in the toolbar:

- **Horizontal**: Align left, center, or right
- **Vertical**: Align top, middle, or bottom
- **Distribute**: Space shapes evenly horizontally or vertically

### Z-Order (Stacking)

Control which shapes appear in front of others:

- **Right-click** → **Bring to Front** or **Send to Back**
- **Drag shapes** in the Layer Panel to reorder them visually

## Clipboard

| Action | Shortcut |
|--------|----------|
| Copy | `Ctrl+C` |
| Paste | `Ctrl+V` |

Pasted shapes are offset by 20px from the original to avoid stacking directly on top.

## Shape Text

Most shapes support inline text. **Double-click** any shape to start typing. The text respects the shape's text properties (font, size, alignment) which you can configure in the Property Panel.

::: tip Tip: LaTeX in shapes
Prefix a shape's label with `=` to render it as a LaTeX equation. For example, a rectangle with the label `=\sum_{i=1}^{n} x_i` renders the math visually.
:::
