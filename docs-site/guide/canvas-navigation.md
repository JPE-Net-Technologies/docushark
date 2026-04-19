# Canvas & Navigation

The canvas is your infinite drawing surface. Let's cover how to move around it efficiently.

## Mouse Navigation

| Action | How |
|--------|-----|
| Pan | Middle-click + drag |
| Zoom | Scroll wheel (zooms toward your cursor) |
| Pan (alternative) | Hold Space + drag |

Zooming always targets where your mouse cursor is, so you can quickly zoom into any area.

## Keyboard Navigation (WASD)

Navigate the canvas like a game — hold multiple keys for diagonal movement:

| Key | Action |
|-----|--------|
| `W` | Pan up |
| `A` | Pan left |
| `S` | Pan down |
| `D` | Pan right |
| `Q` | Zoom out |
| `E` | Zoom in |

Arrow keys also pan the canvas when no shapes are selected.

## Zoom Controls

| Action | Shortcut |
|--------|----------|
| Reset to 100% | `0` |
| Fit all shapes in view | `1` |
| Zoom in | `E` or scroll up |
| Zoom out | `Q` or scroll down |

You can also click the zoom percentage in the status bar to reset it.

## Minimap

Enable the minimap in **Settings → Canvas** to see a bird's-eye view of your entire document. Click anywhere on the minimap to jump directly to that area.

The minimap is especially useful for large diagrams where you need to navigate quickly between different areas.

## Grid

The grid helps you position shapes precisely.

### Grid Display

Toggle the grid in Settings. You can configure:
- **Grid size** — Default is 20px
- **Grid color and opacity** — Adjust to your preference

### Snap to Grid

When enabled, shapes automatically align to grid intersections as you move or resize them. This makes it easy to create neat, aligned layouts.

### Smart Guides

Smart guides appear automatically when you move shapes near other shapes:

- **Pink dashed lines** show alignment (edges or centers lining up)
- Shapes snap to nearby edges and centers
- This works even with snap-to-grid disabled

Smart guides make it easy to align shapes without thinking about exact coordinates.

## Performance Notes

For the best experience with large diagrams:

1. **Viewport culling is automatic** — Shapes outside the visible area aren't rendered, so pan freely
2. **Group related shapes** — Reduces hit-testing overhead
3. **Use the Layer Panel** — Hide layers you're not actively editing to reduce visual clutter
