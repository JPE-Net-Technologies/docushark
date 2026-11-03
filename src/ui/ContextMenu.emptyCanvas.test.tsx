/**
 * Right-clicking empty canvas (DSK-213). The menu used to hold one greyed-out
 * "No selection"; now it acts where you clicked (paste, text, shapes) and lists
 * the canvas commands the registry offers here, with their shortcuts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

const engine = vi.hoisted(() => ({ hasCanvasClipboard: vi.fn(() => false), requestPasteAt: vi.fn() }));
vi.mock('../engine/Engine', () => engine);
const doc = vi.hoisted(() => ({ readOnly: false }));
vi.mock('../store/documentRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/documentRegistry')>()),
  isActiveDocReadOnly: () => doc.readOnly,
}));

import { ContextMenu } from './ContextMenu';
import { getCanvasMenuCommands } from '../engine/CommandRegistry';
import { useDocumentStore } from '../store/documentStore';
import { useSessionStore } from '../store/sessionStore';
import { shapeRegistry } from '../shapes/ShapeRegistry';
import { applyDefaultStyleProfile } from '../store/defaultStyleProfile';
import { Vec2 } from '../math/Vec2';
import type { RectangleShape } from '../shapes/Shape';
import '../shapes/Rectangle';
import '../shapes/Ellipse';
import '../shapes/Text';

const WORLD = { x: 300, y: 200 };
const item = (label: string) =>
  screen.getByText(label, { selector: '.context-menu-label' }).closest('.context-menu-item') as HTMLButtonElement;

beforeEach(() => {
  useDocumentStore.setState({ shapes: {}, shapeOrder: [] });
  useSessionStore.getState().clearSelection();
});

afterEach(() => {
  cleanup();
  doc.readOnly = false;
  engine.hasCanvasClipboard.mockReturnValue(false);
  vi.clearAllMocks();
});

/** The one shape the menu added. */
function added() {
  const { shapes, shapeOrder } = useDocumentStore.getState();
  expect(shapeOrder).toHaveLength(1);
  return shapes[shapeOrder[0]!]!;
}

describe('the empty-canvas menu (DSK-213)', () => {
  it("acts where you clicked, then lists the registry's canvas commands with their shortcuts", () => {
    render(<ContextMenu x={10} y={10} world={WORLD} onClose={vi.fn()} />);
    expect(item('Paste here').disabled).toBe(true); // nothing copied yet
    expect(item('Add text here')).toBeTruthy();
    expect(item('Add shape here')).toBeTruthy();
    for (const command of getCanvasMenuCommands()) {
      const button = item(command.label);
      if (command.shortcut) expect(button.textContent).toContain(command.shortcut);
    }
    expect(getCanvasMenuCommands().map((command) => command.id)).toEqual([
      'edit.undo',
      'edit.redo',
      'edit.selectAll',
      'view.zoomToFit',
      'view.zoomTo100',
    ]);
    expect(screen.queryByText('No selection')).toBeNull();
  });

  it('Paste here pastes the copied shapes at the point', () => {
    engine.hasCanvasClipboard.mockReturnValue(true);
    const onClose = vi.fn();
    render(<ContextMenu x={10} y={10} world={WORLD} onClose={onClose} />);
    fireEvent.click(item('Paste here'));
    expect(engine.requestPasteAt).toHaveBeenCalledWith(WORLD);
    expect(onClose).toHaveBeenCalled();
  });

  it('Add shape here makes the shape at the point, styled as its tool would, and selects it', () => {
    render(<ContextMenu x={10} y={10} world={WORLD} onClose={vi.fn()} />);
    fireEvent.mouseEnter(item('Add shape here').parentElement!);
    fireEvent.click(item('Rectangle'));
    const shape = added() as RectangleShape;
    const expected = applyDefaultStyleProfile(
      shapeRegistry.getHandler('rectangle').create(new Vec2(WORLD.x, WORLD.y), shape.id),
    );
    expect(shape).toEqual(expected);
    expect([shape.x, shape.y]).toEqual([WORLD.x, WORLD.y]);
    expect(useSessionStore.getState().getSelectedIds()).toEqual([shape.id]);
  });

  it('Add text here makes text at the point and opens it for typing', () => {
    render(<ContextMenu x={10} y={10} world={WORLD} onClose={vi.fn()} />);
    fireEvent.click(item('Add text here'));
    const shape = added();
    expect([shape.type, shape.x, shape.y]).toEqual(['text', WORLD.x, WORLD.y]);
    expect(useSessionStore.getState().editingTextId).toBe(shape.id);
  });

  it('runs a command and closes', () => {
    const onClose = vi.fn();
    const selectAll = vi.spyOn(useSessionStore.getState(), 'selectAll');
    render(<ContextMenu x={10} y={10} world={WORLD} onClose={onClose} />);
    fireEvent.click(item('Select all'));
    expect(selectAll).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('a read-only document keeps only the commands, and Undo stays off', () => {
    doc.readOnly = true;
    render(<ContextMenu x={10} y={10} world={WORLD} onClose={vi.fn()} />);
    expect(screen.queryByText('Paste here')).toBeNull();
    expect(screen.queryByText('Add text here')).toBeNull();
    expect(screen.queryByText('Add shape here')).toBeNull();
    expect(item('Zoom to fit')).toBeTruthy();
    expect(item('Undo').disabled).toBe(true);
  });
});
