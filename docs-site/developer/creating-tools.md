# Creating Custom Tools

Tools are the primary way users interact with the canvas. Each tool is a **state machine** that responds to normalized input events — pointer down, move, up, keyboard, and wheel. Only one tool is active at a time, managed by the `ToolManager`.

## Architecture Overview

```
User Input → InputHandler → NormalizedPointerEvent → ToolManager → Active Tool
                                                                      ↓
                                                               renderOverlay (each frame)
```

1. **InputHandler** normalizes mouse, touch, and pen events into a unified `NormalizedPointerEvent` with both screen and world coordinates.
2. **ToolManager** routes events to the currently active tool.
3. The active tool processes the event, mutates state via `ToolContext`, and optionally renders overlays each frame.

## The Tool Interface

Every tool implements the `Tool` interface:

```typescript
interface Tool {
  readonly type: ToolType;
  readonly name: string;
  readonly shortcut?: string;

  onActivate(ctx: ToolContext): void;
  onDeactivate(ctx: ToolContext): void;
  onPointerDown(event: NormalizedPointerEvent, ctx: ToolContext): void;
  onPointerMove(event: NormalizedPointerEvent, ctx: ToolContext): void;
  onPointerUp(event: NormalizedPointerEvent, ctx: ToolContext): void;
  onKeyDown?(event: KeyboardEvent, ctx: ToolContext): boolean;
  onKeyUp?(event: KeyboardEvent, ctx: ToolContext): boolean;
  onWheel?(event: WheelEvent, worldPoint: Vec2, ctx: ToolContext): boolean;
  renderOverlay?(ctx2d: CanvasRenderingContext2D, toolCtx: ToolContext): void;
}
```

::: tip
`BaseTool` provides no-op defaults for every method. Extend it instead of implementing `Tool` directly — you only need to override the methods your tool actually uses.
:::

### Lifecycle

| Method | Called When |
|--------|-----------|
| `onActivate` | Tool becomes the active tool |
| `onDeactivate` | Tool is replaced by another tool |
| `onPointerDown` | Pointer button pressed on canvas |
| `onPointerMove` | Pointer moves over canvas |
| `onPointerUp` | Pointer button released |
| `onKeyDown` | Key pressed while tool is active |
| `onKeyUp` | Key released while tool is active |
| `onWheel` | Scroll wheel on canvas |
| `renderOverlay` | Every animation frame, after shapes |

## ToolContext — What Tools Can Do

The `ToolContext` object is passed to every tool method. It provides full access to the engine, stores, and UI state:

| Category | Members | Description |
|----------|---------|-------------|
| **Engine** | `camera`, `renderer`, `hitTester`, `spatialIndex` | Core engine components |
| **Read State** | `getShapes()`, `getShapeOrder()`, `getSelectedIds()`, `getSelectedShapes()` | Document queries |
| **Mutate State** | `addShape()`, `updateShape()`, `updateShapes()`, `deleteShape()`, `deleteShapes()` | Document mutations (via Immer) |
| **Selection** | `select()`, `addToSelection()`, `removeFromSelection()`, `clearSelection()` | Selection management |
| **UI** | `setCursor()`, `setIsInteracting()`, `setActiveTool()`, `startTextEdit()`, `openFileViewer()` | UI state changes |
| **Snapping** | `getSnapSettings()`, `setSnapGuides()`, `clearSnapGuides()` | Snap alignment guides |
| **Rendering** | `requestRender()` | Trigger a canvas redraw |
| **History** | `pushHistory(description?)` | Create an undo/redo checkpoint |

::: warning
All document mutations go through `ToolContext` methods which use Immer internally. Never mutate shape objects directly.
:::

## NormalizedPointerEvent

Every pointer event is normalized by `InputHandler` before reaching your tool:

```typescript
interface NormalizedPointerEvent {
  type: 'down' | 'move' | 'up';
  screenPoint: Vec2;          // Canvas pixels from top-left
  worldPoint: Vec2;           // World space (via camera transform)
  button: 'left' | 'middle' | 'right' | 'none';
  modifiers: {
    shift: boolean;
    ctrl: boolean;
    alt: boolean;
    meta: boolean;
  };
  pressure: number;           // 0–1, defaults to 0.5 for mouse
  pointerId: number;
  isPrimary: boolean;
  timestamp: number;
  originalEvent: PointerEvent;
}
```

Key details:

- **`worldPoint`** is already camera-transformed — use it for positioning shapes.
- **`screenPoint`** is in raw canvas pixels — use it for overlay rendering.
- **`modifiers`** lets you implement Shift-constrained or Alt-centered creation.
- **`pressure`** enables pen-sensitive tools (drawing, calligraphy).

## Building a Tool: Step-by-Step

Let's build a **Stamp Tool** that places a predefined shape on click with a ghost preview at the cursor.

### 1. Define the State Machine

```typescript
type StampState = 'idle' | 'preview';
```

- **idle** — tool just activated, waiting for first move.
- **preview** — cursor is on the canvas, showing a ghost preview.

### 2. Full Implementation

```typescript
import { BaseTool } from './BaseTool';
import type { ToolContext } from './ToolContext';
import type { NormalizedPointerEvent } from '../InputHandler';
import type { Vec2 } from '../../math/Vec2';

const STAMP_SIZE = 60;

export class StampTool extends BaseTool {
  readonly type = 'stamp' as const;
  readonly name = 'Stamp';
  readonly shortcut = 'S';

  private state: StampState = 'idle';
  private previewPosition: Vec2 | null = null;

  onActivate(ctx: ToolContext): void {
    this.state = 'idle';
    this.previewPosition = null;
    ctx.setCursor('crosshair');
  }

  onDeactivate(ctx: ToolContext): void {
    this.state = 'idle';
    this.previewPosition = null;
    ctx.setCursor('default');
    ctx.requestRender();
  }

  onPointerMove(event: NormalizedPointerEvent, ctx: ToolContext): void {
    this.state = 'preview';
    this.previewPosition = event.worldPoint;
    ctx.requestRender();
  }

  onPointerDown(event: NormalizedPointerEvent, ctx: ToolContext): void {
    if (event.button !== 'left') return;

    const { x, y } = event.worldPoint;
    const halfSize = STAMP_SIZE / 2;

    // Create undo checkpoint before mutation
    ctx.pushHistory('Stamp shape');

    const shape = ctx.addShape({
      type: 'rectangle',
      x: x - halfSize,
      y: y - halfSize,
      width: STAMP_SIZE,
      height: STAMP_SIZE,
      fill: '#6c5ce7',
      stroke: '#4a3db0',
      strokeWidth: 2,
      rotation: 0,
      opacity: 1,
    });

    ctx.select([shape.id]);
    ctx.setActiveTool('select');
  }

  onKeyDown(event: KeyboardEvent, ctx: ToolContext): boolean {
    if (event.key === 'Escape') {
      ctx.setActiveTool('select');
      return true;
    }
    return false;
  }

  renderOverlay(ctx2d: CanvasRenderingContext2D, toolCtx: ToolContext): void {
    if (this.state !== 'preview' || !this.previewPosition) return;

    // Convert world position to screen for overlay rendering
    const screen = toolCtx.camera.worldToScreen(this.previewPosition);
    const zoom = toolCtx.camera.zoom;
    const size = STAMP_SIZE * zoom;

    ctx2d.save();
    ctx2d.globalAlpha = 0.4;
    ctx2d.fillStyle = '#6c5ce7';
    ctx2d.strokeStyle = '#4a3db0';
    ctx2d.lineWidth = 2;
    ctx2d.fillRect(screen.x - size / 2, screen.y - size / 2, size, size);
    ctx2d.strokeRect(screen.x - size / 2, screen.y - size / 2, size, size);
    ctx2d.restore();
  }
}
```

### 3. What's Happening

1. **`onActivate`** — resets state and sets the cursor to crosshair.
2. **`onPointerMove`** — tracks the cursor in world space and requests a redraw to show the ghost preview.
3. **`onPointerDown`** — pushes an undo checkpoint, creates the shape centered on the click, selects it, and switches to the select tool.
4. **`onKeyDown`** — Escape cancels and returns to select tool. Returns `true` to stop event propagation.
5. **`renderOverlay`** — draws a semi-transparent rectangle at the cursor, converting world coordinates to screen space and scaling by zoom.

## Registering a Tool

Tools are registered with the `ToolManager` in `Engine.ts`:

```typescript
import { StampTool } from './tools/StampTool';

// During engine initialization
toolManager.register(new StampTool());
```

### Built-in Tools

| Tool | Class | Shortcut | Description |
|------|-------|----------|-------------|
| Select | `SelectTool` | `V` | Select, move, resize, rotate shapes |
| Pan | `PanTool` | `H` | Pan the canvas viewport |
| Rectangle | `RectangleTool` | `R` | Draw rectangles |
| Ellipse | `EllipseTool` | `E` | Draw ellipses |
| Line | `LineTool` | `L` | Draw straight lines |
| Text | `TextTool` | `T` | Place text blocks |
| Connector | `ConnectorTool` | `C` | Draw connectors between shapes |
| Library Shape | `LibraryShapeTool` | — | Place shapes from shape libraries |
| Custom Shape | `CustomShapeTool` | — | Place user-defined custom shapes |

## Rendering Overlays

The `renderOverlay` method is called every frame to draw tool-specific visuals on top of shapes.

### Key Rules

1. **Screen space** — overlays render in screen space. The camera transform is **not** applied.
2. **Convert coordinates** — use `camera.worldToScreen(worldPoint)` for anything positioned in the world.
3. **Save/restore** — always wrap drawing in `ctx.save()` / `ctx.restore()`.
4. **Called after shapes** — overlays render on top of all shape content, before the FPS counter.

### Common Patterns

**Selection marquee:**

```typescript
renderOverlay(ctx2d: CanvasRenderingContext2D, toolCtx: ToolContext): void {
  if (!this.marqueeStart || !this.marqueeEnd) return;

  const start = toolCtx.camera.worldToScreen(this.marqueeStart);
  const end = toolCtx.camera.worldToScreen(this.marqueeEnd);

  ctx2d.save();
  ctx2d.fillStyle = 'rgba(59, 130, 246, 0.1)';
  ctx2d.strokeStyle = 'rgba(59, 130, 246, 0.6)';
  ctx2d.setLineDash([4, 4]);
  ctx2d.fillRect(start.x, start.y, end.x - start.x, end.y - start.y);
  ctx2d.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
  ctx2d.restore();
}
```

**Snap guides:**

```typescript
// Full-width dashed line at a snapped Y position
const screenY = toolCtx.camera.worldToScreen({ x: 0, y: snapY }).y;
ctx2d.save();
ctx2d.strokeStyle = '#ff00ff';
ctx2d.setLineDash([6, 3]);
ctx2d.beginPath();
ctx2d.moveTo(0, screenY);
ctx2d.lineTo(canvasWidth, screenY);
ctx2d.stroke();
ctx2d.restore();
```

## State Machine Patterns

Every tool is a state machine. The complexity varies by tool:

### Simple — PanTool

```
idle ←→ panning
```

Only two states: waiting, or actively dragging. Pointer down starts panning, pointer up stops.

### Creation — RectangleTool

```
idle → drawing → idle
```

Pointer down records the origin, moves resize the shape being drawn, pointer up finalizes it and commits.

### Complex — SelectTool

```
         ┌─── translating
         │
idle → pending ─┼─── marquee
         │
         ├─── resizing
         │
         └─── rotating
```

The `pending` state resolves on the next pointer move based on what was initially hit — a shape handle, a shape body, or empty canvas.

::: tip
Always handle `Escape` to cancel in-progress operations. Always call `ctx.setIsInteracting(false)` when releasing — this signals to the engine that a drag gesture is complete.
:::

## Tips & Best Practices

### Event Handling

- Return `true` from `onKeyDown` / `onKeyUp` to indicate the event was handled and prevent other handlers from processing it.
- Use `event.modifiers.shift` for constrained operations (e.g., perfect squares from rectangle tool, 45° snap for lines).
- Use `event.modifiers.alt` for alternate behavior (e.g., draw from center instead of corner).

### History & Undo

- Call `ctx.pushHistory()` **before** your mutations — this captures the pre-mutation state for undo.
- Use descriptive labels: `ctx.pushHistory('Draw rectangle')` rather than just `ctx.pushHistory()`.
- Group related mutations: one `pushHistory` call per logical user action, even if it involves multiple `updateShape` calls.

### Rendering

- Call `ctx.requestRender()` after any change that affects visuals — moved preview, changed cursor, etc.
- Don't call `requestRender()` from inside `renderOverlay` — this causes infinite render loops.

### Interaction State

- Call `ctx.setIsInteracting(true)` on pointer down when starting a drag gesture.
- Call `ctx.setIsInteracting(false)` on pointer up or cancel.
- This flag tells the engine to skip certain optimizations (like spatial index rebuilds) during active drags.

### Coordinate Hygiene

- Use `event.worldPoint` for all shape positioning and hit testing.
- Use `event.screenPoint` only for screen-space calculations (overlay rendering, distance thresholds).
- When computing pixel distances for thresholds (e.g., drag start), use screen points to keep thresholds consistent regardless of zoom level.
