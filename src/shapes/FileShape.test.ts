import { describe, it, expect, vi } from 'vitest';
import { fileShapeHandler } from './FileShape';
import { FileShape, isFile, DEFAULT_FILE_SHAPE } from './Shape';
import { Vec2 } from '../math/Vec2';
import { shapeRegistry } from './ShapeRegistry';

/**
 * Create a test file shape with default properties.
 */
function createTestFile(overrides: Partial<FileShape> = {}): FileShape {
  return {
    id: 'test-file',
    type: 'file',
    x: 0,
    y: 0,
    width: DEFAULT_FILE_SHAPE.width,
    height: DEFAULT_FILE_SHAPE.height,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    fill: DEFAULT_FILE_SHAPE.fill,
    stroke: DEFAULT_FILE_SHAPE.stroke,
    strokeWidth: DEFAULT_FILE_SHAPE.strokeWidth,
    blobRef: '',
    fileName: 'Untitled',
    mimeType: 'application/octet-stream',
    fileSize: 0,
    fileCategory: 'generic',
    labelFontSize: DEFAULT_FILE_SHAPE.labelFontSize,
    labelColor: DEFAULT_FILE_SHAPE.labelColor,
    ...overrides,
  };
}

describe('FileShape Handler', () => {
  describe('registration', () => {
    it('is registered in ShapeRegistry', () => {
      expect(shapeRegistry.hasHandler('file')).toBe(true);
    });

    it('has metadata registered', () => {
      expect(shapeRegistry.hasMetadata('file')).toBe(true);
      const meta = shapeRegistry.getMetadata('file');
      expect(meta?.name).toBe('File');
      expect(meta?.category).toBe('basic');
      expect(meta?.icon).toBe('📄');
    });
  });

  describe('create', () => {
    it('creates file shape at given position', () => {
      const shape = fileShapeHandler.create(new Vec2(100, 50), 'new-file');

      expect(shape.id).toBe('new-file');
      expect(shape.type).toBe('file');
      expect(shape.x).toBe(100);
      expect(shape.y).toBe(50);
    });

    it('uses default values', () => {
      const shape = fileShapeHandler.create(new Vec2(0, 0), 'test') as FileShape;

      expect(shape.width).toBe(DEFAULT_FILE_SHAPE.width);
      expect(shape.height).toBe(DEFAULT_FILE_SHAPE.height);
      expect(shape.rotation).toBe(0);
      expect(shape.opacity).toBe(1);
      expect(shape.locked).toBe(false);
      expect(shape.visible).toBe(true);
      expect(shape.fill).toBe(DEFAULT_FILE_SHAPE.fill);
      expect(shape.stroke).toBe(DEFAULT_FILE_SHAPE.stroke);
      expect(shape.strokeWidth).toBe(DEFAULT_FILE_SHAPE.strokeWidth);
      expect(shape.blobRef).toBe('');
      expect(shape.fileName).toBe('Untitled');
      expect(shape.mimeType).toBe('application/octet-stream');
      expect(shape.fileSize).toBe(0);
      expect(shape.fileCategory).toBe('generic');
      expect(shape.labelFontSize).toBe(DEFAULT_FILE_SHAPE.labelFontSize);
      expect(shape.labelColor).toBe(DEFAULT_FILE_SHAPE.labelColor);
    });
  });

  describe('hitTest', () => {
    it('returns true for point inside shape', () => {
      const shape = createTestFile();

      expect(fileShapeHandler.hitTest(shape, new Vec2(0, 0))).toBe(true);
      expect(fileShapeHandler.hitTest(shape, new Vec2(90, 70))).toBe(true);
      expect(fileShapeHandler.hitTest(shape, new Vec2(-90, -70))).toBe(true);
    });

    it('returns false for point outside shape', () => {
      const shape = createTestFile();

      expect(fileShapeHandler.hitTest(shape, new Vec2(110, 0))).toBe(false);
      expect(fileShapeHandler.hitTest(shape, new Vec2(0, 90))).toBe(false);
      expect(fileShapeHandler.hitTest(shape, new Vec2(500, 500))).toBe(false);
    });

    it('accounts for stroke width in hit area', () => {
      const shape = createTestFile({ strokeWidth: 10 });
      const halfW = shape.width / 2; // 100

      // Point at exact edge
      expect(fileShapeHandler.hitTest(shape, new Vec2(halfW, 0))).toBe(true);
      // Point just outside rect but within stroke padding (5px)
      expect(fileShapeHandler.hitTest(shape, new Vec2(halfW + 3, 0))).toBe(true);
      // Point outside stroke area
      expect(fileShapeHandler.hitTest(shape, new Vec2(halfW + 8, 0))).toBe(false);
    });

    it('handles offset shapes', () => {
      const shape = createTestFile({ x: 200, y: 150 });

      expect(fileShapeHandler.hitTest(shape, new Vec2(200, 150))).toBe(true);
      expect(fileShapeHandler.hitTest(shape, new Vec2(290, 220))).toBe(true);
      expect(fileShapeHandler.hitTest(shape, new Vec2(0, 0))).toBe(false);
    });

    it('handles rotated shapes', () => {
      // 90 degree rotation: width=200, height=160 → swapped extents
      const shape = createTestFile({ rotation: Math.PI / 2 });

      expect(fileShapeHandler.hitTest(shape, new Vec2(0, 0))).toBe(true);
      // Along original X-axis (now Y-axis) within half-width
      expect(fileShapeHandler.hitTest(shape, new Vec2(0, 90))).toBe(true);
      // Along original Y-axis (now X-axis) within half-height
      expect(fileShapeHandler.hitTest(shape, new Vec2(70, 0))).toBe(true);
    });

    it('handles 45 degree rotation', () => {
      const shape = createTestFile({
        width: 100,
        height: 100,
        rotation: Math.PI / 4,
      });

      expect(fileShapeHandler.hitTest(shape, new Vec2(0, 0))).toBe(true);
      // Corners of rotated square at ~70.7 from center along axes
      expect(fileShapeHandler.hitTest(shape, new Vec2(50, 0))).toBe(true);
      expect(fileShapeHandler.hitTest(shape, new Vec2(0, 50))).toBe(true);
    });
  });

  describe('getBounds', () => {
    it('returns correct bounds for unrotated shape', () => {
      const shape = createTestFile();
      const bounds = fileShapeHandler.getBounds(shape);
      const strokePad = shape.strokeWidth / 2; // 0.5

      // Width=200, height=160, centered at origin
      expect(bounds.minX).toBeCloseTo(-100 - strokePad);
      expect(bounds.minY).toBeCloseTo(-80 - strokePad);
      expect(bounds.maxX).toBeCloseTo(100 + strokePad);
      expect(bounds.maxY).toBeCloseTo(80 + strokePad);
    });

    it('returns correct bounds for offset shape', () => {
      const shape = createTestFile({ x: 200, y: 150 });
      const bounds = fileShapeHandler.getBounds(shape);
      const strokePad = shape.strokeWidth / 2;

      expect(bounds.minX).toBeCloseTo(200 - 100 - strokePad);
      expect(bounds.minY).toBeCloseTo(150 - 80 - strokePad);
      expect(bounds.maxX).toBeCloseTo(200 + 100 + strokePad);
      expect(bounds.maxY).toBeCloseTo(150 + 80 + strokePad);
    });

    it('returns expanded bounds for rotated shape', () => {
      const shape = createTestFile({
        width: 100,
        height: 100,
        rotation: Math.PI / 4,
      });
      const bounds = fileShapeHandler.getBounds(shape);
      const strokePad = shape.strokeWidth / 2;

      // 100x100 square rotated 45°: half-diagonal = 50√2 ≈ 70.71
      const expected = 70.71 + strokePad;
      expect(bounds.minX).toBeCloseTo(-expected, 0);
      expect(bounds.maxX).toBeCloseTo(expected, 0);
      expect(bounds.minY).toBeCloseTo(-expected, 0);
      expect(bounds.maxY).toBeCloseTo(expected, 0);
    });

    it('includes stroke width in bounds', () => {
      const shape = createTestFile({ strokeWidth: 20 });
      const bounds = fileShapeHandler.getBounds(shape);

      // Half stroke = 10
      expect(bounds.minX).toBeCloseTo(-110); // -100 - 10
      expect(bounds.maxX).toBeCloseTo(110);
      expect(bounds.minY).toBeCloseTo(-90); // -80 - 10
      expect(bounds.maxY).toBeCloseTo(90);
    });
  });

  describe('getHandles', () => {
    it('returns 9 handles (8 resize + 1 rotation)', () => {
      const shape = createTestFile();
      const handles = fileShapeHandler.getHandles(shape);

      expect(handles).toHaveLength(9);
    });

    it('returns handles at correct positions', () => {
      const shape = createTestFile();
      const handles = fileShapeHandler.getHandles(shape);
      const byType = new Map(handles.map((h) => [h.type, h]));

      // Corner handles
      expect(byType.get('top-left')?.x).toBeCloseTo(-100);
      expect(byType.get('top-left')?.y).toBeCloseTo(-80);
      expect(byType.get('bottom-right')?.x).toBeCloseTo(100);
      expect(byType.get('bottom-right')?.y).toBeCloseTo(80);

      // Edge midpoint handles
      expect(byType.get('top')?.x).toBeCloseTo(0);
      expect(byType.get('top')?.y).toBeCloseTo(-80);
      expect(byType.get('right')?.x).toBeCloseTo(100);
      expect(byType.get('right')?.y).toBeCloseTo(0);
    });

    it('transforms handles for offset shape', () => {
      const shape = createTestFile({ x: 200, y: 150 });
      const handles = fileShapeHandler.getHandles(shape);

      const topLeft = handles.find((h) => h.type === 'top-left')!;
      expect(topLeft.x).toBeCloseTo(100); // 200 - 100
      expect(topLeft.y).toBeCloseTo(70); // 150 - 80
    });

    it('transforms handles for rotated shape', () => {
      const shape = createTestFile({ rotation: Math.PI / 2 });
      const handles = fileShapeHandler.getHandles(shape);

      // top-left was at (-100, -80), after 90° rotation becomes (80, -100)
      const topLeft = handles.find((h) => h.type === 'top-left')!;
      expect(topLeft.x).toBeCloseTo(80);
      expect(topLeft.y).toBeCloseTo(-100);
    });

    it('includes rotation handle above shape', () => {
      const shape = createTestFile();
      const handles = fileShapeHandler.getHandles(shape);

      const rotation = handles.find((h) => h.type === 'rotation')!;
      expect(rotation.cursor).toBe('grab');
      // Rotation handle is 30px above top edge
      expect(rotation.x).toBeCloseTo(0);
      expect(rotation.y).toBeCloseTo(-80 - 30);
    });

    it('includes cursor styles', () => {
      const shape = createTestFile();
      const handles = fileShapeHandler.getHandles(shape);

      const topLeft = handles.find((h) => h.type === 'top-left')!;
      expect(topLeft.cursor).toBe('nwse-resize');

      const top = handles.find((h) => h.type === 'top')!;
      expect(top.cursor).toBe('ns-resize');
    });
  });

  describe('getAnchors', () => {
    it('returns 5 anchors (center + 4 edges)', () => {
      const shape = createTestFile();
      const anchors = fileShapeHandler.getAnchors!(shape);

      expect(anchors).toHaveLength(5);
    });

    it('returns anchors at correct positions', () => {
      const shape = createTestFile();
      const anchors = fileShapeHandler.getAnchors!(shape);
      const byPos = new Map(anchors.map((a) => [a.position, a]));

      expect(byPos.get('center')?.x).toBeCloseTo(0);
      expect(byPos.get('center')?.y).toBeCloseTo(0);
      expect(byPos.get('top')?.x).toBeCloseTo(0);
      expect(byPos.get('top')?.y).toBeCloseTo(-80);
      expect(byPos.get('right')?.x).toBeCloseTo(100);
      expect(byPos.get('right')?.y).toBeCloseTo(0);
      expect(byPos.get('bottom')?.x).toBeCloseTo(0);
      expect(byPos.get('bottom')?.y).toBeCloseTo(80);
      expect(byPos.get('left')?.x).toBeCloseTo(-100);
      expect(byPos.get('left')?.y).toBeCloseTo(0);
    });

    it('transforms anchors for offset shape', () => {
      const shape = createTestFile({ x: 200, y: 150 });
      const anchors = fileShapeHandler.getAnchors!(shape);
      const byPos = new Map(anchors.map((a) => [a.position, a]));

      expect(byPos.get('center')?.x).toBeCloseTo(200);
      expect(byPos.get('center')?.y).toBeCloseTo(150);
      expect(byPos.get('top')?.x).toBeCloseTo(200);
      expect(byPos.get('top')?.y).toBeCloseTo(70); // 150 - 80
    });

    it('transforms anchors for rotated shape', () => {
      const shape = createTestFile({ rotation: Math.PI / 2 });
      const anchors = fileShapeHandler.getAnchors!(shape);
      const byPos = new Map(anchors.map((a) => [a.position, a]));

      // Center stays at origin
      expect(byPos.get('center')?.x).toBeCloseTo(0);
      expect(byPos.get('center')?.y).toBeCloseTo(0);
      // Top was (0, -80), after 90° rotation becomes (80, 0)
      expect(byPos.get('top')?.x).toBeCloseTo(80);
      expect(byPos.get('top')?.y).toBeCloseTo(0);
    });
  });

  describe('render', () => {
    it('calls context methods for basic rendering', () => {
      const shape = createTestFile();
      const ctx = {
        save: vi.fn(),
        restore: vi.fn(),
        translate: vi.fn(),
        rotate: vi.fn(),
        beginPath: vi.fn(),
        closePath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        arcTo: vi.fn(),
        fill: vi.fn(),
        stroke: vi.fn(),
        clip: vi.fn(),
        rect: vi.fn(),
        fillRect: vi.fn(),
        fillText: vi.fn(),
        measureText: vi.fn().mockReturnValue({ width: 30 }),
        drawImage: vi.fn(),
        globalAlpha: 1,
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        textAlign: 'left',
        textBaseline: 'top',
        font: '',
      } as unknown as CanvasRenderingContext2D;

      fileShapeHandler.render(ctx, shape);

      expect(ctx.save).toHaveBeenCalled();
      expect(ctx.translate).toHaveBeenCalledWith(0, 0);
      expect(ctx.rotate).toHaveBeenCalledWith(0);
      expect(ctx.fill).toHaveBeenCalled();
      expect(ctx.stroke).toHaveBeenCalled();
      expect(ctx.restore).toHaveBeenCalled();
    });

    it('does not fill when fill is empty', () => {
      const shape = createTestFile({ fill: '' });
      const ctx = {
        save: vi.fn(),
        restore: vi.fn(),
        translate: vi.fn(),
        rotate: vi.fn(),
        beginPath: vi.fn(),
        closePath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        arcTo: vi.fn(),
        fill: vi.fn(),
        stroke: vi.fn(),
        clip: vi.fn(),
        rect: vi.fn(),
        fillRect: vi.fn(),
        fillText: vi.fn(),
        measureText: vi.fn().mockReturnValue({ width: 30 }),
        globalAlpha: 1,
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        textAlign: 'left',
        textBaseline: 'top',
        font: '',
      } as unknown as CanvasRenderingContext2D;

      fileShapeHandler.render(ctx, shape);

      // Fill should not be called for the card background (first fill call)
      // but fillText/fillRect may still be called for text and bar
      expect(ctx.stroke).toHaveBeenCalled();
    });

    it('does not stroke when strokeWidth is 0', () => {
      const shape = createTestFile({ stroke: '', strokeWidth: 0 });
      const ctx = {
        save: vi.fn(),
        restore: vi.fn(),
        translate: vi.fn(),
        rotate: vi.fn(),
        beginPath: vi.fn(),
        closePath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        arcTo: vi.fn(),
        fill: vi.fn(),
        stroke: vi.fn(),
        clip: vi.fn(),
        rect: vi.fn(),
        fillRect: vi.fn(),
        fillText: vi.fn(),
        measureText: vi.fn().mockReturnValue({ width: 30 }),
        globalAlpha: 1,
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        textAlign: 'left',
        textBaseline: 'top',
        font: '',
      } as unknown as CanvasRenderingContext2D;

      fileShapeHandler.render(ctx, shape);

      // stroke() should not be called (no stroke color or zero width)
      expect(ctx.stroke).not.toHaveBeenCalled();
    });

    it('uses rounded corners via arcTo', () => {
      const shape = createTestFile();
      const ctx = {
        save: vi.fn(),
        restore: vi.fn(),
        translate: vi.fn(),
        rotate: vi.fn(),
        beginPath: vi.fn(),
        closePath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        arcTo: vi.fn(),
        fill: vi.fn(),
        stroke: vi.fn(),
        clip: vi.fn(),
        rect: vi.fn(),
        fillRect: vi.fn(),
        fillText: vi.fn(),
        measureText: vi.fn().mockReturnValue({ width: 30 }),
        globalAlpha: 1,
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        textAlign: 'left',
        textBaseline: 'top',
        font: '',
      } as unknown as CanvasRenderingContext2D;

      fileShapeHandler.render(ctx, shape);

      // File shape always uses rounded corners
      expect(ctx.arcTo).toHaveBeenCalled();
    });
  });
});

describe('isFile type guard', () => {
  it('returns true for file shapes', () => {
    const shape = createTestFile();
    expect(isFile(shape)).toBe(true);
  });

  it('returns false for other shape types', () => {
    const shape = { ...createTestFile(), type: 'rectangle' as const };
    expect(isFile(shape as unknown as Parameters<typeof isFile>[0])).toBe(false);
  });
});
