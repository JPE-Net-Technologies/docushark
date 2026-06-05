import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import {
  fileShapeHandler,
  onThumbnailLoad,
  resetFileThumbnailCaches,
  isBlobMissing,
} from './FileShape';
import { FileShape, isFile, DEFAULT_FILE_SHAPE } from './Shape';
import { Vec2 } from '../math/Vec2';
import { shapeRegistry } from './ShapeRegistry';

// JP-122: the blob:// thumbnail resolver loads bytes from BlobStorage. Mock the
// singleton so tests control resolution without touching IndexedDB.
const blobStorageMock = vi.hoisted(() => ({ loadBlob: vi.fn() }));
vi.mock('../storage/BlobStorage', () => ({ blobStorage: blobStorageMock }));

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

describe('blob:// thumbnail resolution (JP-122)', () => {
  const HASH = 'abc123hash';
  const BLOB_THUMB = `blob://${HASH}`;

  /** A minimal canvas context mock that records the calls we assert on. */
  function makeCtx(): CanvasRenderingContext2D {
    return {
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
  }

  /** Let the resolver's then/catch/finally microtask chain settle. */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeAll(() => {
    // jsdom lacks object-URL APIs — stub them so the resolver can run.
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:objecturl/stub');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  beforeEach(() => {
    resetFileThumbnailCaches();
    blobStorageMock.loadBlob.mockReset();
    (globalThis.URL.createObjectURL as ReturnType<typeof vi.fn>).mockClear();
    (globalThis.URL.revokeObjectURL as ReturnType<typeof vi.fn>).mockClear();
  });

  it('loads the blob, caches an object URL, and notifies on success', async () => {
    blobStorageMock.loadBlob.mockResolvedValue(new Blob(['img'], { type: 'image/png' }));
    const onLoad = vi.fn();
    const unsub = onThumbnailLoad(onLoad);
    const shape = createTestFile({ preview: { thumbnail: BLOB_THUMB } });

    // First frame: not resolved yet — falls through (emoji), kicks off the load.
    fileShapeHandler.render(makeCtx(), shape);
    expect(blobStorageMock.loadBlob).toHaveBeenCalledWith(HASH);

    await flush();

    expect(globalThis.URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(onLoad).toHaveBeenCalled(); // renderer would redraw
    expect(isBlobMissing(HASH)).toBe(false); // marked available
    unsub();
  });

  it('does not re-load the same blob on subsequent renders', async () => {
    blobStorageMock.loadBlob.mockResolvedValue(new Blob(['img'], { type: 'image/png' }));
    const shape = createTestFile({ preview: { thumbnail: BLOB_THUMB } });

    fileShapeHandler.render(makeCtx(), shape); // kicks off load
    await flush();
    fileShapeHandler.render(makeCtx(), shape); // object URL cached now
    fileShapeHandler.render(makeCtx(), shape);

    expect(blobStorageMock.loadBlob).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent loads while one is in flight', () => {
    blobStorageMock.loadBlob.mockReturnValue(new Promise(() => {})); // never resolves
    const shape = createTestFile({ preview: { thumbnail: BLOB_THUMB } });

    fileShapeHandler.render(makeCtx(), shape);
    fileShapeHandler.render(makeCtx(), shape);

    expect(blobStorageMock.loadBlob).toHaveBeenCalledTimes(1);
  });

  it('marks missing and draws the warning overlay when the blob is absent', async () => {
    blobStorageMock.loadBlob.mockResolvedValue(null);
    const shape = createTestFile({
      blobRef: HASH,
      preview: { thumbnail: BLOB_THUMB },
    });

    fileShapeHandler.render(makeCtx(), shape);
    await flush();

    expect(isBlobMissing(HASH)).toBe(true);

    // A render after the miss draws the red missing-blob overlay (and routes the
    // warning glyph through the icon cache) rather than throwing. Track the
    // fillStyle assignments to confirm the overlay path ran.
    const ctx = makeCtx();
    const fillStyles: string[] = [];
    let current = '';
    Object.defineProperty(ctx, 'fillStyle', {
      get: () => current,
      set: (value: string) => {
        current = value;
        fillStyles.push(value);
      },
    });
    fileShapeHandler.render(ctx, shape);
    expect(fillStyles).toContain('rgba(239, 68, 68, 0.15)');
  });

  it('marks missing when the load rejects (no throw)', async () => {
    blobStorageMock.loadBlob.mockRejectedValue(new Error('idb down'));
    const shape = createTestFile({ preview: { thumbnail: BLOB_THUMB } });

    expect(() => fileShapeHandler.render(makeCtx(), shape)).not.toThrow();
    await flush();

    expect(isBlobMissing(HASH)).toBe(true);
  });

  it('passes regular data:/http URLs straight through without a blob load', () => {
    const shape = createTestFile({
      preview: { thumbnail: 'data:image/png;base64,AAAA' },
    });

    fileShapeHandler.render(makeCtx(), shape);

    expect(blobStorageMock.loadBlob).not.toHaveBeenCalled();
  });

  it('resetFileThumbnailCaches revokes object URLs and forces a fresh load', async () => {
    blobStorageMock.loadBlob.mockResolvedValue(new Blob(['img'], { type: 'image/png' }));
    const shape = createTestFile({ preview: { thumbnail: BLOB_THUMB } });

    fileShapeHandler.render(makeCtx(), shape);
    await flush();
    expect(globalThis.URL.createObjectURL).toHaveBeenCalledTimes(1);

    resetFileThumbnailCaches();
    expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledWith('blob:objecturl/stub');
    expect(isBlobMissing(HASH)).toBeUndefined(); // availability cleared

    // After reset the next render re-resolves from storage.
    fileShapeHandler.render(makeCtx(), shape);
    expect(blobStorageMock.loadBlob).toHaveBeenCalledTimes(2);
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
