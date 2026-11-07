/**
 * Group Hierarchy Tests
 *
 * Phase 14.9.2 - Group nesting cycle detection
 */

import { describe, it, expect } from 'vitest';
import {
  resolveDrawOrder,
  wouldCreateCycle,
  isDescendantOf,
  getAncestorGroups,
  findParentGroup,
  getAllDescendants,
  validateGroupHierarchy,
  getHierarchyDepth,
  wouldExceedMaxDepth,
  MAX_GROUP_NESTING_DEPTH,
} from './GroupHierarchy';
import type { Shape, GroupShape } from './Shape';

// Helper to create a minimal shape
function createShape(id: string, type: string = 'rectangle'): Shape {
  return {
    id,
    type,
    x: 0,
    y: 0,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    fill: '#fff',
    stroke: '#000',
    strokeWidth: 1,
  } as Shape;
}

// Helper to create a group
function createGroup(id: string, childIds: string[]): GroupShape {
  return {
    ...createShape(id, 'group'),
    type: 'group',
    childIds,
  } as GroupShape;
}

describe('GroupHierarchy', () => {
  describe('wouldCreateCycle', () => {
    it('returns true when moving shape into itself', () => {
      const shapes: Record<string, Shape> = {
        'group-1': createGroup('group-1', ['shape-1']),
        'shape-1': createShape('shape-1'),
      };
      expect(wouldCreateCycle('group-1', 'group-1', shapes)).toBe(true);
    });

    it('returns true when moving group into its child', () => {
      const shapes: Record<string, Shape> = {
        'parent': createGroup('parent', ['child']),
        'child': createGroup('child', []),
      };
      expect(wouldCreateCycle('parent', 'child', shapes)).toBe(true);
    });

    it('returns true when moving group into its grandchild', () => {
      const shapes: Record<string, Shape> = {
        'grandparent': createGroup('grandparent', ['parent']),
        'parent': createGroup('parent', ['child']),
        'child': createGroup('child', []),
      };
      expect(wouldCreateCycle('grandparent', 'child', shapes)).toBe(true);
    });

    it('returns false for valid move (sibling groups)', () => {
      const shapes: Record<string, Shape> = {
        'group-a': createGroup('group-a', ['shape-1']),
        'group-b': createGroup('group-b', ['shape-2']),
        'shape-1': createShape('shape-1'),
        'shape-2': createShape('shape-2'),
      };
      expect(wouldCreateCycle('group-a', 'group-b', shapes)).toBe(false);
    });

    it('returns false for non-group shapes', () => {
      const shapes: Record<string, Shape> = {
        'shape-1': createShape('shape-1'),
        'group-1': createGroup('group-1', []),
      };
      expect(wouldCreateCycle('shape-1', 'group-1', shapes)).toBe(false);
    });
  });

  describe('isDescendantOf', () => {
    it('returns true for direct child', () => {
      const shapes: Record<string, Shape> = {
        'parent': createGroup('parent', ['child']),
        'child': createShape('child'),
      };
      expect(isDescendantOf('child', 'parent', shapes)).toBe(true);
    });

    it('returns true for nested descendant', () => {
      const shapes: Record<string, Shape> = {
        'grandparent': createGroup('grandparent', ['parent']),
        'parent': createGroup('parent', ['child']),
        'child': createShape('child'),
      };
      expect(isDescendantOf('child', 'grandparent', shapes)).toBe(true);
    });

    it('returns false for non-descendant', () => {
      const shapes: Record<string, Shape> = {
        'group-a': createGroup('group-a', ['shape-1']),
        'group-b': createGroup('group-b', ['shape-2']),
        'shape-1': createShape('shape-1'),
        'shape-2': createShape('shape-2'),
      };
      expect(isDescendantOf('shape-2', 'group-a', shapes)).toBe(false);
    });

    it('returns false when ancestor is not a group', () => {
      const shapes: Record<string, Shape> = {
        'shape-1': createShape('shape-1'),
        'shape-2': createShape('shape-2'),
      };
      expect(isDescendantOf('shape-2', 'shape-1', shapes)).toBe(false);
    });
  });

  describe('getAncestorGroups', () => {
    it('returns empty array for root-level shape', () => {
      const shapes: Record<string, Shape> = {
        'shape-1': createShape('shape-1'),
      };
      expect(getAncestorGroups('shape-1', shapes)).toEqual([]);
    });

    it('returns parent for direct child', () => {
      const shapes: Record<string, Shape> = {
        'parent': createGroup('parent', ['child']),
        'child': createShape('child'),
      };
      expect(getAncestorGroups('child', shapes)).toEqual(['parent']);
    });

    it('returns all ancestors in order', () => {
      const shapes: Record<string, Shape> = {
        'grandparent': createGroup('grandparent', ['parent']),
        'parent': createGroup('parent', ['child']),
        'child': createShape('child'),
      };
      expect(getAncestorGroups('child', shapes)).toEqual(['parent', 'grandparent']);
    });
  });

  describe('findParentGroup', () => {
    it('returns null for root-level shape', () => {
      const shapes: Record<string, Shape> = {
        'shape-1': createShape('shape-1'),
      };
      expect(findParentGroup('shape-1', shapes)).toBe(null);
    });

    it('returns parent group', () => {
      const shapes: Record<string, Shape> = {
        'parent': createGroup('parent', ['child']),
        'child': createShape('child'),
      };
      const parent = findParentGroup('child', shapes);
      expect(parent?.id).toBe('parent');
    });
  });

  describe('getAllDescendants', () => {
    it('returns empty set for non-group', () => {
      const shapes: Record<string, Shape> = {
        'shape-1': createShape('shape-1'),
      };
      expect(getAllDescendants('shape-1', shapes).size).toBe(0);
    });

    it('returns direct children', () => {
      const shapes: Record<string, Shape> = {
        'parent': createGroup('parent', ['child-1', 'child-2']),
        'child-1': createShape('child-1'),
        'child-2': createShape('child-2'),
      };
      const descendants = getAllDescendants('parent', shapes);
      expect(descendants.size).toBe(2);
      expect(descendants.has('child-1')).toBe(true);
      expect(descendants.has('child-2')).toBe(true);
    });

    it('returns nested descendants', () => {
      const shapes: Record<string, Shape> = {
        'grandparent': createGroup('grandparent', ['parent']),
        'parent': createGroup('parent', ['child']),
        'child': createShape('child'),
      };
      const descendants = getAllDescendants('grandparent', shapes);
      expect(descendants.size).toBe(2);
      expect(descendants.has('parent')).toBe(true);
      expect(descendants.has('child')).toBe(true);
    });
  });

  describe('validateGroupHierarchy', () => {
    it('returns valid for healthy hierarchy', () => {
      const shapes: Record<string, Shape> = {
        'group-1': createGroup('group-1', ['shape-1', 'shape-2']),
        'shape-1': createShape('shape-1'),
        'shape-2': createShape('shape-2'),
      };
      const result = validateGroupHierarchy(shapes);
      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('detects orphaned child references', () => {
      const shapes: Record<string, Shape> = {
        'group-1': createGroup('group-1', ['missing-shape']),
      };
      const result = validateGroupHierarchy(shapes);
      expect(result.valid).toBe(false);
      expect(result.issues.some(i => i.includes('missing child'))).toBe(true);
    });

    it('detects shapes in multiple groups', () => {
      const shapes: Record<string, Shape> = {
        'group-a': createGroup('group-a', ['shape-1']),
        'group-b': createGroup('group-b', ['shape-1']),
        'shape-1': createShape('shape-1'),
      };
      const result = validateGroupHierarchy(shapes);
      expect(result.valid).toBe(false);
      expect(result.issues.some(i => i.includes('multiple groups'))).toBe(true);
    });
  });

  describe('getHierarchyDepth', () => {
    it('returns 0 for root-level shape', () => {
      const shapes: Record<string, Shape> = {
        'shape-1': createShape('shape-1'),
      };
      expect(getHierarchyDepth('shape-1', shapes)).toBe(0);
    });

    it('returns correct depth for nested shapes', () => {
      const shapes: Record<string, Shape> = {
        'grandparent': createGroup('grandparent', ['parent']),
        'parent': createGroup('parent', ['child']),
        'child': createShape('child'),
      };
      expect(getHierarchyDepth('grandparent', shapes)).toBe(0);
      expect(getHierarchyDepth('parent', shapes)).toBe(1);
      expect(getHierarchyDepth('child', shapes)).toBe(2);
    });
  });

  describe('wouldExceedMaxDepth', () => {
    it('returns false for shallow nesting', () => {
      const shapes: Record<string, Shape> = {
        'group-1': createGroup('group-1', []),
        'shape-1': createShape('shape-1'),
      };
      expect(wouldExceedMaxDepth('shape-1', 'group-1', shapes)).toBe(false);
    });

    it('returns true when exceeding max depth', () => {
      // Create exactly MAX_GROUP_NESTING_DEPTH groups nested
      const testShapes: Record<string, Shape> = {};
      let currentChildId: string | undefined = undefined;

      for (let i = 0; i < MAX_GROUP_NESTING_DEPTH; i++) {
        const groupId = `level-${i}`;
        testShapes[groupId] = createGroup(groupId, currentChildId ? [currentChildId] : []);
        currentChildId = groupId;
      }

      // level-9 is root (depth 0), level-0 is deepest (depth 9)
      // Try to add a shape to level-0, which is already at depth 9
      // Adding there would make the new shape at depth 10, which equals MAX
      testShapes['new-shape'] = createShape('new-shape');
      expect(wouldExceedMaxDepth('new-shape', 'level-0', testShapes)).toBe(true);
    });
  });
});

describe('resolveDrawOrder', () => {
  const shapes = (...list: Shape[]) => Object.fromEntries(list.map((shape) => [shape.id, shape]));
  const group = (id: string, childIds: string[]) => ({ ...createShape(id, 'group'), childIds }) as GroupShape;
  const [a, b, c] = ['a', 'b', 'c'].map((id) => createShape(id));

  it('takes the order as it is when it accounts for every shape', () => {
    expect(resolveDrawOrder(shapes(a!, b!, c!), ['c', 'a', 'b'])).toEqual({ order: ['c', 'a', 'b'], leftOut: [] });
  });

  it('drops ids with no shape, and keeps the first of a doubled id', () => {
    expect(resolveDrawOrder(shapes(a!, b!), ['b', 'ghost', 'a', 'b']).order).toEqual(['b', 'a']);
  });

  it("drops a group's children from the order, at any depth", () => {
    const list = shapes(a!, b!, c!, group('inner', ['a']), group('outer', ['inner', 'b']));
    expect(resolveDrawOrder(list, ['a', 'inner', 'b', 'outer', 'c'])).toEqual({ order: ['outer', 'c'], leftOut: [] });
  });

  it('does not count a group\'s children as left out', () => {
    expect(resolveDrawOrder(shapes(a!, b!, group('g', ['a', 'b'])), ['g']).leftOut).toEqual([]);
  });

  it('adds what the order leaves out on top, in the current order', () => {
    expect(resolveDrawOrder(shapes(a!, b!, c!), ['b'], ['c', 'a', 'b'])).toEqual({ order: ['b', 'c', 'a'], leftOut: ['c', 'a'] });
  });

  it('finds what is in neither the order nor the current order', () => {
    expect(resolveDrawOrder(shapes(a!, b!, c!), ['b'], ['b']).order).toEqual(['b', 'a', 'c']);
  });

  it('ignores ids in the current order that have no shape', () => {
    expect(resolveDrawOrder(shapes(a!), [], ['ghost', 'a'])).toEqual({ order: ['a'], leftOut: ['a'] });
  });

  it('frees the children of a group that has gone', () => {
    expect(resolveDrawOrder(shapes(a!, b!), ['a', 'b']).order).toEqual(['a', 'b']);
  });
});
