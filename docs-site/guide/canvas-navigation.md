---
title: Canvas & Navigation
description: Navigate DocuShark's infinite canvas — pan, zoom, fit-to-screen, minimap, and keyboard navigation.
---

# Canvas & Navigation

The canvas is your infinite drawing surface. Let's cover how to move around it efficiently.

## Trackpad & Mouse

There's no single "correct" way to move around the canvas — use whatever feels natural, and don't be afraid to mix it with the keyboard shortcuts below.

- **Trackpad**: two-finger scroll pans in any direction; pinch to zoom.
- **Mouse**: the scroll wheel pans vertically, Shift+scroll pans horizontally, and Ctrl (⌘ on Mac) + scroll zooms toward your cursor.
- **Middle-click + drag** also pans, while the Select tool is active.

| Input | Result |
|-------|--------|
| Two-finger scroll (trackpad) | Pan |
| Pinch (trackpad) | Zoom toward cursor |
| Scroll wheel | Pan vertically |
| Shift + scroll wheel | Pan horizontally |
| Ctrl/⌘ + scroll wheel | Zoom toward cursor |
| Middle-click + drag | Pan (Select tool) |

::: tip Trackpad pinch not zooming?
On some Linux setups, a trackpad pinch isn't reported the way it is on macOS/Windows. `Q`/`E` (below) always work as a fallback.
:::

## Keyboard Navigation (WASD / QE)

An additional option alongside the trackpad/mouse controls above — hold multiple keys for diagonal movement, and hold `Q`/`E` for a smooth zoom that speeds up the longer you hold it:

| Key | Action |
|-----|--------|
| `W` | Pan up |
| `A` | Pan left |
| `S` | Pan down |
| `D` | Pan right |
| `Q` | Zoom out |
| `E` | Zoom in |

Arrow keys also pan the canvas when no shapes are selected.

The zoom controls sit in the canvas's bottom-right corner: **−** and **+** step the zoom, clicking the percentage returns to 100%, and **Fit** frames every shape. Press and hold the percentage to see the whole diagram at once; let go and the view goes back exactly where it was. **Zoom to fit** and **Zoom to 100%** are also in the command palette.

## Minimap

The minimap shows the whole canvas page in miniature, with the part on screen outlined. Turn it on with the map button in the zoom controls, or in **Settings → General**.

- **Drag the outlined box** to move the view.
- **Click anywhere else** on the minimap to glide there. Keep holding and drag to carry on from that spot.
- **Scroll over the minimap** to zoom the canvas in or out around the point you're pointing at.
- **Arrow keys** move the view while the minimap has focus (Tab to it).

It works with touch and pen as well as a mouse, and it's most useful on large diagrams, where you need to move quickly between distant areas.

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
