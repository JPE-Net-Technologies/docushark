import { describe, it, expect } from 'vitest';
import { rectangleHandler } from '../Rectangle';
import { ellipseHandler } from '../Ellipse';
import { connectorHandler } from '../Connector';
import { groupHandler } from '../Group';
import { fileShapeHandler } from '../FileShape';
import { createLibraryShapeHandler } from '../library/LibraryShapeHandler';
import type { LibraryShapeDefinition } from '../library/ShapeLibraryTypes';
import { createStandardAnchors } from '../library/ShapeLibraryTypes';
import type {
  RectangleShape,
  EllipseShape,
  ConnectorShape,
  GroupShape,
  LibraryShape,
} from '../Shape';

const baseStyle = {
  rotation: 0,
  opacity: 1,
  locked: false,
  visible: true,
  fill: '#fff',
  stroke: '#000',
  strokeWidth: 2,
};

describe('getLabelEditTarget', () => {
  it('rectangle: centered on the shape, field "label"', () => {
    const rect: RectangleShape = {
      id: 'r', type: 'rectangle', x: 10, y: 20, width: 100, height: 80,
      cornerRadius: 0, label: 'hi', ...baseStyle,
    };
    const t = rectangleHandler.getLabelEditTarget!(rect);
    expect(t).not.toBeNull();
    expect(t!.field).toBe('label');
    expect(t!.worldRect).toMatchObject({ cx: 10, cy: 20, width: 100, height: 80 });
  });

  it('ellipse: full-diameter box centered on the shape', () => {
    const ell: EllipseShape = {
      id: 'e', type: 'ellipse', x: 0, y: 0, radiusX: 40, radiusY: 30, ...baseStyle,
    };
    const t = ellipseHandler.getLabelEditTarget!(ell);
    expect(t!.worldRect).toMatchObject({ cx: 0, cy: 0, width: 80, height: 60 });
  });

  it('connector: anchored at the mid-path point', () => {
    const conn: ConnectorShape = {
      id: 'c', type: 'connector', x: 0, y: 0, x2: 100, y2: 0, ...baseStyle,
    } as ConnectorShape;
    const t = connectorHandler.getLabelEditTarget!(conn);
    expect(t!.field).toBe('label');
    expect(t!.worldRect.cx).toBeCloseTo(50);
    expect(t!.worldRect.cy).toBeCloseTo(0);
  });

  it('group: anchored at the 9-grid label position (empty group → at origin)', () => {
    const group: GroupShape = {
      id: 'g', type: 'group', x: 5, y: 5, childIds: [], ...baseStyle,
    } as GroupShape;
    const t = groupHandler.getLabelEditTarget!(group);
    expect(t!.field).toBe('label');
    expect(t!.worldRect.cx).toBeCloseTo(5);
  });

  it('file: no editable label (opens the viewer instead)', () => {
    expect(fileShapeHandler.getLabelEditTarget).toBeUndefined();
  });

  describe('library shapes', () => {
    const def: LibraryShapeDefinition = {
      type: 'test-box',
      metadata: {
        type: 'test-box', name: 'Test', category: 'flowchart', icon: '',
        properties: [], supportsLabel: true, supportsIcon: false,
        defaultWidth: 120, defaultHeight: 60,
      },
      pathBuilder: () => new Path2D(),
      anchors: createStandardAnchors(),
    };

    it('centered target for a standard library shape', () => {
      const handler = createLibraryShapeHandler(def);
      const shape: LibraryShape = {
        id: 'l', type: 'test-box', x: 7, y: 9, width: 120, height: 60, ...baseStyle,
      };
      const t = handler.getLabelEditTarget!(shape);
      expect(t!.worldRect).toMatchObject({ cx: 7, cy: 9, width: 120, height: 60 });
    });

    it('returns null when the shape renders its own text', () => {
      const handler = createLibraryShapeHandler({ ...def, customLabelRendering: true });
      const shape: LibraryShape = {
        id: 'l2', type: 'test-box', x: 0, y: 0, width: 120, height: 60, ...baseStyle,
      };
      expect(handler.getLabelEditTarget!(shape)).toBeNull();
    });
  });
});
