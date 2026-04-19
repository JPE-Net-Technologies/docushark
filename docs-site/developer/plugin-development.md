# Plugin Development Guide

Diagrammer provides a plugin system through the **PanelExtensions** registry, allowing developers to extend the UI without modifying core components.

## Extension Points

| Extension | Description | Registration Method |
|-----------|-------------|-------------------|
| Property Sections | Add custom sections to PropertyPanel | `registerPropertySection()` |
| Property Renderers | Custom renderers for new property types | `registerPropertyRenderer()` |
| Panel Actions | Action buttons in panel headers | `registerPanelAction()` |
| Context Menu Items | Items in shape context menus | `registerContextMenuItem()` |

## Quick Start

```typescript
import { panelExtensions } from './plugins/PanelExtensions';

// Register a custom property section
panelExtensions.registerPropertySection({
  id: 'my-plugin-settings',
  title: 'Plugin Settings',
  priority: 100,
  shouldShow: (shape) => shape.type === 'my-custom-shape',
  render: (shape, updateShape) => (
    <MyPluginSettings shape={shape} onChange={updateShape} />
  ),
});
```

## Creating a Custom Shape Library

1. Define shape definitions implementing `LibraryShapeDefinition`:

```typescript
import type { LibraryShapeDefinition } from '../shapes/library/ShapeLibraryTypes';
import { createStandardProperties } from '../shapes/ShapeMetadata';

export const myShapes: LibraryShapeDefinition[] = [
  {
    type: 'hexagon',
    metadata: {
      type: 'hexagon',
      name: 'Hexagon',
      category: 'custom',
      icon: '⬡',
      properties: createStandardProperties({ includeLabel: true, includeIcon: true }),
      supportsLabel: true,
      supportsIcon: true,
      defaultWidth: 100,
      defaultHeight: 86,
      description: 'Regular hexagon shape',
    },
    // PathBuilder: receives width & height, returns a Path2D in local space (centered at origin)
    pathBuilder: (width, height) => {
      const path = new Path2D();
      const hw = width / 2;
      const hh = height / 2;
      const qw = width / 4;
      path.moveTo(-qw, -hh);
      path.lineTo(qw, -hh);
      path.lineTo(hw, 0);
      path.lineTo(qw, hh);
      path.lineTo(-qw, hh);
      path.lineTo(-hw, 0);
      path.closePath();
      return path;
    },
    // Anchor points for connector attachment (functions receive width, height)
    anchors: [
      { position: 'center', x: () => 0, y: () => 0 },
      { position: 'top', x: () => 0, y: (_w, h) => -h / 2 },
      { position: 'right', x: (w) => w / 2, y: () => 0 },
      { position: 'bottom', x: () => 0, y: (_w, h) => h / 2 },
      { position: 'left', x: (w) => -w / 2, y: () => 0 },
    ],
  },
];
```

2. Register with the shape library store:

```typescript
import { useShapeLibraryStore } from '../store/shapeLibraryStore';

useShapeLibraryStore.getState().registerShapes(myShapes);
```

3. For lazy loading (recommended), add a loader entry in `shapeLibraryStore.ts`:

```typescript
{
  category: 'custom',
  load: () => import('../shapes/library/myShapes').then((m) => m.myShapes),
}
```

::: tip
See the [Creating Shapes](./creating-shapes) guide for a complete end-to-end walkthrough, including the full `LibraryShapeDefinition` API, metadata configuration, and testing.
:::

## Adding a Property Renderer

Custom property renderers handle specialized property types in the PropertyPanel:

```typescript
import { panelExtensions } from './plugins/PanelExtensions';

// Register a gradient picker for 'gradient' type properties
panelExtensions.registerPropertyRenderer('gradient', ({ value, onChange }) => (
  <GradientPicker value={value} onChange={onChange} />
));
```

## State Management Guidelines

- **Read-only access**: Plugins should use `useDocumentStore`, `useSessionStore` for reading state
- **Mutations**: Use `updateShape()` from `useDocumentStore` for shape modifications
- **Persistence**: Plugin settings can use `localStorage` directly or create a Zustand store with `persist` middleware
- **Lifecycle**: Register extensions during module initialization (top-level calls)

## API Reference

See `src/plugins/PanelExtensions.ts` for the full TypeScript interface definitions including:

- `PropertySectionExtension` — Custom PropertyPanel sections
- `PropertyRendererExtension` — Custom property type renderers
- `PanelActionExtension` — Panel header action buttons
- `ContextMenuExtension` — Context menu items
