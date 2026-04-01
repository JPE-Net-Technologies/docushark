import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolManager } from './ToolManager';
import { BaseTool, ToolContext } from './tools/Tool';
import type { NormalizedPointerEvent } from './InputHandler';
import { Vec2 } from '../math/Vec2';

// ============ Test Helpers ============

/**
 * Create a minimal mock ToolContext for testing.
 */
function createMockContext(): ToolContext {
  return {
    camera: {} as any,
    renderer: {} as any,
    hitTester: {} as any,
    spatialIndex: {} as any,
    getShapes: () => ({}),
    getShapeOrder: () => [],
    getSelectedIds: () => [],
    getSelectedShapes: () => [],
    select: vi.fn(),
    addToSelection: vi.fn(),
    removeFromSelection: vi.fn(),
    clearSelection: vi.fn(),
    addShape: vi.fn(),
    updateShape: vi.fn(),
    updateShapes: vi.fn(),
    deleteShape: vi.fn(),
    deleteShapes: vi.fn(),
    setCursor: vi.fn(),
    setIsInteracting: vi.fn(),
    setActiveTool: vi.fn(),
    startTextEdit: vi.fn(),
    openFileViewer: vi.fn(),
    getSnapSettings: () => ({ enabled: false, snapToGrid: false, snapToShapes: false, gridSpacing: 10 }),
    setSnapGuides: vi.fn(),
    clearSnapGuides: vi.fn(),
    requestRender: vi.fn(),
    pushHistory: vi.fn(),
  };
}

/**
 * Create a mock pointer event.
 */
function createPointerEvent(
  type: 'down' | 'move' | 'up',
  screenX = 0,
  screenY = 0
): NormalizedPointerEvent {
  return {
    type,
    screenPoint: new Vec2(screenX, screenY),
    worldPoint: new Vec2(screenX, screenY),
    button: type === 'up' ? 'none' : 'left',
    modifiers: { shift: false, ctrl: false, alt: false, meta: false },
    pressure: type === 'up' ? 0 : 0.5,
    pointerId: 1,
    isPrimary: true,
    timestamp: Date.now(),
    originalEvent: null as any,
  };
}

/**
 * Test tool that tracks lifecycle calls.
 */
class TestTool extends BaseTool {
  readonly type: string;
  readonly name: string;

  activateCount = 0;
  deactivateCount = 0;
  pointerDownCount = 0;
  pointerMoveCount = 0;
  pointerUpCount = 0;
  keyDownCount = 0;
  keyUpCount = 0;
  wheelCount = 0;

  constructor(type: string, name: string, shortcut?: string) {
    super();
    this.type = type;
    this.name = name;
    if (shortcut !== undefined) {
      (this as any).shortcut = shortcut;
    }
  }

  onActivate(_ctx: ToolContext): void {
    this.activateCount++;
  }

  onDeactivate(_ctx: ToolContext): void {
    this.deactivateCount++;
  }

  onPointerDown(_event: NormalizedPointerEvent, _ctx: ToolContext): void {
    this.pointerDownCount++;
  }

  onPointerMove(_event: NormalizedPointerEvent, _ctx: ToolContext): void {
    this.pointerMoveCount++;
  }

  onPointerUp(_event: NormalizedPointerEvent, _ctx: ToolContext): void {
    this.pointerUpCount++;
  }

  onKeyDown(_event: KeyboardEvent, _ctx: ToolContext): boolean {
    this.keyDownCount++;
    return true;
  }

  onKeyUp(_event: KeyboardEvent, _ctx: ToolContext): boolean {
    this.keyUpCount++;
    return true;
  }

  onWheel(_event: WheelEvent, _worldPoint: Vec2, _ctx: ToolContext): boolean {
    this.wheelCount++;
    return true;
  }
}

// ============ Tests ============

describe('ToolManager', () => {
  let manager: ToolManager;
  let ctx: ToolContext;

  beforeEach(() => {
    ctx = createMockContext();
    manager = new ToolManager(ctx);
  });

  describe('registration', () => {
    it('registers a tool', () => {
      const tool = new TestTool('select', 'Select');
      manager.register(tool);
      expect(manager.hasToolRegistered('select')).toBe(true);
    });

    it('throws on duplicate registration', () => {
      manager.register(new TestTool('select', 'Select'));
      expect(() => manager.register(new TestTool('select', 'Select 2'))).toThrow(
        'Tool already registered: select'
      );
    });

    it('registers multiple tools', () => {
      manager.register(new TestTool('select', 'Select'));
      manager.register(new TestTool('pan', 'Pan'));
      manager.register(new TestTool('rectangle', 'Rectangle'));
      expect(manager.getRegisteredTools()).toHaveLength(3);
    });

    it('returns false for unregistered tool', () => {
      expect(manager.hasToolRegistered('nonexistent')).toBe(false);
    });

    it('gets registered tool by type', () => {
      const tool = new TestTool('select', 'Select');
      manager.register(tool);
      expect(manager.getTool('select')).toBe(tool);
    });

    it('returns undefined for unregistered tool', () => {
      expect(manager.getTool('select')).toBeUndefined();
    });
  });

  describe('unregistration', () => {
    it('unregisters a tool', () => {
      manager.register(new TestTool('select', 'Select'));
      expect(manager.unregister('select')).toBe(true);
      expect(manager.hasToolRegistered('select')).toBe(false);
    });

    it('returns false when unregistering unknown tool', () => {
      expect(manager.unregister('nonexistent')).toBe(false);
    });

    it('deactivates tool when unregistering active tool', () => {
      const tool = new TestTool('select', 'Select');
      manager.register(tool);
      manager.setActiveTool('select');
      manager.unregister('select');
      expect(tool.deactivateCount).toBe(1);
      expect(manager.getActiveTool()).toBeNull();
    });
  });

  describe('activation/deactivation lifecycle', () => {
    it('activates a registered tool', () => {
      const tool = new TestTool('select', 'Select');
      manager.register(tool);
      manager.setActiveTool('select');
      expect(manager.getActiveTool()).toBe(tool);
      expect(manager.getActiveToolType()).toBe('select');
      expect(tool.activateCount).toBe(1);
    });

    it('throws when activating unregistered tool', () => {
      expect(() => manager.setActiveTool('nonexistent')).toThrow(
        'Tool not registered: nonexistent'
      );
    });

    it('deactivates previous tool when switching', () => {
      const selectTool = new TestTool('select', 'Select');
      const panTool = new TestTool('pan', 'Pan');
      manager.register(selectTool);
      manager.register(panTool);

      manager.setActiveTool('select');
      manager.setActiveTool('pan');

      expect(selectTool.deactivateCount).toBe(1);
      expect(panTool.activateCount).toBe(1);
      expect(manager.getActiveTool()).toBe(panTool);
    });

    it('skips activation if already active', () => {
      const tool = new TestTool('select', 'Select');
      manager.register(tool);
      manager.setActiveTool('select');
      manager.setActiveTool('select');
      expect(tool.activateCount).toBe(1);
      expect(tool.deactivateCount).toBe(0);
    });

    it('returns null when no tool is active', () => {
      expect(manager.getActiveTool()).toBeNull();
      expect(manager.getActiveToolType()).toBeNull();
    });

    it('handles rapid tool switches', () => {
      const tools = ['select', 'pan', 'rectangle', 'ellipse', 'line'].map(
        (type) => {
          const t = new TestTool(type, type);
          manager.register(t);
          return t;
        }
      );

      // Rapidly switch through all tools
      for (const tool of tools) {
        manager.setActiveTool(tool.type);
      }

      // Each tool activated exactly once, all but last deactivated
      for (let i = 0; i < tools.length - 1; i++) {
        expect(tools[i]!.activateCount).toBe(1);
        expect(tools[i]!.deactivateCount).toBe(1);
      }
      const lastTool = tools[tools.length - 1]!;
      expect(lastTool.activateCount).toBe(1);
      expect(lastTool.deactivateCount).toBe(0);
      expect(manager.getActiveTool()).toBe(lastTool);
    });
  });

  describe('event forwarding — pointer', () => {
    it('forwards pointer down to active tool', () => {
      const tool = new TestTool('select', 'Select');
      manager.register(tool);
      manager.setActiveTool('select');

      manager.handlePointerEvent(createPointerEvent('down', 100, 200));
      expect(tool.pointerDownCount).toBe(1);
    });

    it('forwards pointer move to active tool', () => {
      const tool = new TestTool('select', 'Select');
      manager.register(tool);
      manager.setActiveTool('select');

      manager.handlePointerEvent(createPointerEvent('move', 150, 250));
      expect(tool.pointerMoveCount).toBe(1);
    });

    it('forwards pointer up to active tool', () => {
      const tool = new TestTool('select', 'Select');
      manager.register(tool);
      manager.setActiveTool('select');

      manager.handlePointerEvent(createPointerEvent('up', 100, 200));
      expect(tool.pointerUpCount).toBe(1);
    });

    it('does not crash when no tool is active', () => {
      expect(() => {
        manager.handlePointerEvent(createPointerEvent('down'));
        manager.handlePointerEvent(createPointerEvent('move'));
        manager.handlePointerEvent(createPointerEvent('up'));
      }).not.toThrow();
    });
  });

  describe('event forwarding — keyboard', () => {
    it('forwards key down to active tool', () => {
      const tool = new TestTool('select', 'Select');
      manager.register(tool);
      manager.setActiveTool('select');

      const event = new KeyboardEvent('keydown', { key: 'a' });
      const handled = manager.handleKeyDown(event);
      expect(tool.keyDownCount).toBe(1);
      expect(handled).toBe(true);
    });

    it('forwards key up to active tool', () => {
      const tool = new TestTool('select', 'Select');
      manager.register(tool);
      manager.setActiveTool('select');

      const event = new KeyboardEvent('keyup', { key: 'a' });
      const handled = manager.handleKeyUp(event);
      expect(tool.keyUpCount).toBe(1);
      expect(handled).toBe(true);
    });

    it('returns false when no tool is active for key events', () => {
      const event = new KeyboardEvent('keydown', { key: 'a' });
      expect(manager.handleKeyDown(event)).toBe(false);
      expect(manager.handleKeyUp(event)).toBe(false);
    });
  });

  describe('event forwarding — wheel', () => {
    it('forwards wheel to active tool', () => {
      const tool = new TestTool('select', 'Select');
      manager.register(tool);
      manager.setActiveTool('select');

      const event = new WheelEvent('wheel', { deltaY: 100 });
      const worldPoint = new Vec2(50, 50);
      const handled = manager.handleWheel(event, worldPoint);

      expect(tool.wheelCount).toBe(1);
      expect(handled).toBe(true);
    });

    it('returns false when no tool is active for wheel', () => {
      const event = new WheelEvent('wheel');
      expect(manager.handleWheel(event, new Vec2(0, 0))).toBe(false);
    });
  });

  describe('keyboard shortcuts', () => {
    it('switches tool via shortcut key', () => {
      const selectTool = new TestTool('select', 'Select', 'v');
      const panTool = new TestTool('pan', 'Pan', 'h');
      manager.register(selectTool);
      manager.register(panTool);
      manager.setActiveTool('select');

      const event = new KeyboardEvent('keydown', { key: 'h' });
      const handled = manager.handleKeyDown(event);

      expect(handled).toBe(true);
      expect(ctx.setActiveTool).toHaveBeenCalledWith('pan');
    });

    it('does not switch when modifier keys are held', () => {
      const selectTool = new TestTool('select', 'Select', 'v');
      const panTool = new TestTool('pan', 'Pan', 'h');
      manager.register(selectTool);
      manager.register(panTool);
      manager.setActiveTool('select');

      const event = new KeyboardEvent('keydown', { key: 'h', ctrlKey: true });
      manager.handleKeyDown(event);

      // Should forward to tool, not switch
      expect(ctx.setActiveTool).not.toHaveBeenCalled();
      expect(selectTool.keyDownCount).toBe(1);
    });

    it('does not switch to already active tool', () => {
      const selectTool = new TestTool('select', 'Select', 'v');
      manager.register(selectTool);
      manager.setActiveTool('select');

      const event = new KeyboardEvent('keydown', { key: 'v' });
      manager.handleKeyDown(event);

      // Same tool already active — forward key event instead
      expect(ctx.setActiveTool).not.toHaveBeenCalled();
      expect(selectTool.keyDownCount).toBe(1);
    });
  });

  describe('tool overlay', () => {
    it('returns null when no tool is active', () => {
      expect(manager.getToolOverlayCallback()).toBeNull();
    });

    it('returns null when tool has no overlay', () => {
      const tool = new TestTool('select', 'Select');
      manager.register(tool);
      manager.setActiveTool('select');
      // TestTool (extends BaseTool) has renderOverlay as optional undefined
      expect(manager.getToolOverlayCallback()).toBeNull();
    });

    it('returns callback when tool has overlay', () => {
      const tool = new TestTool('select', 'Select');
      tool.renderOverlay = vi.fn();
      manager.register(tool);
      manager.setActiveTool('select');

      const callback = manager.getToolOverlayCallback();
      expect(callback).not.toBeNull();
      expect(typeof callback).toBe('function');
    });
  });

  describe('context management', () => {
    it('updates context', () => {
      const newCtx = createMockContext();
      manager.setContext(newCtx);

      const tool = new TestTool('select', 'Select');
      manager.register(tool);
      manager.setActiveTool('select');

      // Verify tool activation uses new context by checking no error
      expect(tool.activateCount).toBe(1);
    });
  });

  describe('destroy', () => {
    it('deactivates current tool and clears all tools', () => {
      const tool = new TestTool('select', 'Select');
      manager.register(tool);
      manager.setActiveTool('select');

      manager.destroy();

      expect(tool.deactivateCount).toBe(1);
      expect(manager.getActiveTool()).toBeNull();
      expect(manager.getRegisteredTools()).toHaveLength(0);
    });

    it('handles destroy when no tool is active', () => {
      manager.register(new TestTool('select', 'Select'));
      expect(() => manager.destroy()).not.toThrow();
      expect(manager.getRegisteredTools()).toHaveLength(0);
    });

    it('handles destroy when empty', () => {
      expect(() => manager.destroy()).not.toThrow();
    });
  });
});
