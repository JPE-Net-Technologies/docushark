import { describe, it, expect } from 'vitest';
import {
  buildEntries,
  buildBuiltinEntries,
  buildCustomEntries,
  tokenize,
  categoryLabel,
} from './entries';
import type { ShapeMetadata } from '../../shapes/ShapeMetadata';
import type { CustomShapeItem } from '../../storage/ShapeLibraryTypes';

function meta(partial: Partial<ShapeMetadata> & Pick<ShapeMetadata, 'type' | 'name' | 'category'>): ShapeMetadata {
  return {
    icon: '⬚',
    properties: [],
    supportsLabel: true,
    supportsIcon: false,
    defaultWidth: 100,
    defaultHeight: 70,
    ...partial,
  };
}

function customItem(partial: Partial<CustomShapeItem> & Pick<CustomShapeItem, 'id' | 'name'>): CustomShapeItem {
  return {
    libraryId: 'lib1',
    type: 'single',
    createdAt: 0,
    usageCount: 0,
    // shapeData isn't read by the entry builder.
    shapeData: {
      rootShape: {} as never,
      childShapes: [],
      originalBounds: { x: 0, y: 0, width: 0, height: 0 },
    },
    ...partial,
  };
}

describe('tokenize', () => {
  it('splits camelCase, spaces, and hyphens, lowercased', () => {
    expect(tokenize('UML Use-Case')).toEqual(['uml', 'use', 'case']);
    expect(tokenize('predefined-process')).toEqual(['predefined', 'process']);
    expect(tokenize('Fork/Join')).toEqual(['fork', 'join']);
  });

  it('drops single-character tokens', () => {
    expect(tokenize('a big X')).toEqual(['big']);
  });
});

describe('buildBuiltinEntries', () => {
  it('includes only allowlisted basic shapes', () => {
    const entries = buildBuiltinEntries([
      meta({ type: 'rectangle', name: 'Rectangle', category: 'basic' }),
      meta({ type: 'line', name: 'Line', category: 'basic' }),
      meta({ type: 'group', name: 'Group', category: 'basic' }),
    ]);
    expect(entries.map((e) => e.id)).toEqual(['rectangle']);
  });

  it('maps library shapes with kind builtin and a category label', () => {
    const [entry] = buildBuiltinEntries([
      meta({ type: 'diamond', name: 'Decision', category: 'flowchart' }),
    ]);
    expect(entry).toMatchObject({
      id: 'diamond',
      name: 'Decision',
      category: 'flowchart',
      categoryLabel: 'Flowchart',
      kind: 'builtin',
      toolType: 'diamond',
      builtinType: 'diamond',
    });
  });

  it('derives synonym keywords (decision → if/branch)', () => {
    const entry = buildBuiltinEntries([
      meta({ type: 'diamond', name: 'Decision', category: 'flowchart' }),
    ])[0]!;
    expect(entry.keywords).toEqual(expect.arrayContaining(['decision', 'if', 'branch', 'flowchart']));
  });

  it('skips custom-category metadata (custom comes from the custom store)', () => {
    expect(buildBuiltinEntries([meta({ type: 'x', name: 'X', category: 'custom' })])).toEqual([]);
  });
});

describe('buildCustomEntries', () => {
  it('namespaces ids and carries the thumbnail', () => {
    const [entry] = buildCustomEntries([
      customItem({ id: 'abc', name: 'My Box', thumbnail: 'data:image/png;base64,AA' }),
    ]);
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      id: 'custom-shape:abc',
      toolType: 'custom-shape:abc',
      kind: 'custom',
      category: 'custom',
      thumbnail: 'data:image/png;base64,AA',
    });
  });

  it('omits thumbnail key when absent', () => {
    const entry = buildCustomEntries([customItem({ id: 'abc', name: 'My Box' })])[0]!;
    expect('thumbnail' in entry).toBe(false);
  });
});

describe('buildEntries', () => {
  it('orders built-ins before custom', () => {
    const entries = buildEntries(
      [meta({ type: 'diamond', name: 'Decision', category: 'flowchart' })],
      [customItem({ id: 'abc', name: 'My Box' })]
    );
    expect(entries.map((e) => e.kind)).toEqual(['builtin', 'custom']);
  });
});

describe('categoryLabel', () => {
  it('falls back to the raw key for unknown categories', () => {
    expect(categoryLabel('uml-class')).toBe('UML Class');
    expect(categoryLabel('mystery')).toBe('mystery');
  });
});
