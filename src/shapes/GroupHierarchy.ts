/**
 * Group Hierarchy Utilities
 *
 * Utilities for validating and manipulating group hierarchies.
 * Prevents infinite cycles when nesting groups.
 *
 * Phase 14.9.2 - Group nesting cycle detection
 */

import { Shape, GroupShape, isGroup } from './Shape';

/**
 * What a page draws at the top level, from an order that came from outside the
 * store: a shared document or a snapshot (DSK-221).
 *
 * The order decides the stacking of what it names, but every shape is drawn
 * exactly once. A group's children leave the order, because the group draws
 * them. A shape the order leaves out joins at the top unless a group draws it,
 * because nothing else would; `current` keeps those in their present order.
 *
 * @returns The order to draw, and the shapes the incoming order left out
 */
export function resolveDrawOrder(
  shapes: Record<string, Shape>,
  order: readonly string[],
  current: readonly string[] = []
): { order: string[]; leftOut: string[] } {
  const drawnByGroup = new Set<string>();
  for (const shape of Object.values(shapes)) {
    if (isGroup(shape)) {
      for (const id of shape.childIds) drawnByGroup.add(id);
    }
  }

  const seen = new Set<string>();
  const take = (ids: readonly string[]): string[] =>
    ids.filter((id) => {
      if (!shapes[id] || drawnByGroup.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });

  const named = take(order);
  const leftOut = take([...current, ...Object.keys(shapes)]);
  return { order: [...named, ...leftOut], leftOut };
}

/**
 * Check if adding a shape to a target group would create a cycle.
 * A cycle occurs when:
 * 1. The target group is the same as the shape being moved
 * 2. The target group is a descendant of the shape being moved (when shape is a group)
 *
 * @param shapeId - The ID of the shape being moved
 * @param targetGroupId - The ID of the group to move the shape into
 * @param shapes - All shapes in the document
 * @returns true if adding would create a cycle, false if safe
 */
export function wouldCreateCycle(
  shapeId: string,
  targetGroupId: string,
  shapes: Record<string, Shape>
): boolean {
  // Can't move a shape into itself
  if (shapeId === targetGroupId) {
    return true;
  }

  const shape = shapes[shapeId];

  // Only groups can create cycles (non-groups have no children)
  if (!shape || !isGroup(shape)) {
    return false;
  }

  // Check if targetGroupId is a descendant of shapeId
  return isDescendantOf(targetGroupId, shapeId, shapes);
}

/**
 * Check if a shape is a descendant of a potential ancestor group.
 *
 * @param shapeId - The ID of the potential descendant
 * @param ancestorId - The ID of the potential ancestor
 * @param shapes - All shapes in the document
 * @returns true if shapeId is a descendant of ancestorId
 */
export function isDescendantOf(
  shapeId: string,
  ancestorId: string,
  shapes: Record<string, Shape>
): boolean {
  const ancestor = shapes[ancestorId];

  if (!ancestor || !isGroup(ancestor)) {
    return false;
  }

  // Check direct children
  if (ancestor.childIds.includes(shapeId)) {
    return true;
  }

  // Check recursively through all descendants
  for (const childId of ancestor.childIds) {
    if (isDescendantOf(shapeId, childId, shapes)) {
      return true;
    }
  }

  return false;
}

/**
 * Get all ancestor group IDs for a shape (from immediate parent to root).
 *
 * @param shapeId - The ID of the shape
 * @param shapes - All shapes in the document
 * @returns Array of ancestor group IDs (empty if shape is at root level)
 */
export function getAncestorGroups(
  shapeId: string,
  shapes: Record<string, Shape>
): string[] {
  const ancestors: string[] = [];
  let currentId = shapeId;

  // Find parent iteratively to avoid deep recursion
  while (true) {
    const parent = findParentGroup(currentId, shapes);
    if (!parent) break;
    ancestors.push(parent.id);
    currentId = parent.id;
  }

  return ancestors;
}

/**
 * Find the immediate parent group of a shape.
 *
 * @param shapeId - The ID of the shape
 * @param shapes - All shapes in the document
 * @returns The parent group, or null if shape is at root level
 */
export function findParentGroup(
  shapeId: string,
  shapes: Record<string, Shape>
): GroupShape | null {
  for (const shape of Object.values(shapes)) {
    if (isGroup(shape) && shape.childIds.includes(shapeId)) {
      return shape;
    }
  }
  return null;
}

/**
 * Get all descendant shape IDs of a group (recursive).
 *
 * @param groupId - The ID of the group
 * @param shapes - All shapes in the document
 * @returns Set of all descendant shape IDs (including nested groups and their children)
 */
export function getAllDescendants(
  groupId: string,
  shapes: Record<string, Shape>
): Set<string> {
  const descendants = new Set<string>();
  const group = shapes[groupId];

  if (!group || !isGroup(group)) {
    return descendants;
  }

  for (const childId of group.childIds) {
    descendants.add(childId);
    // Recursively add descendants of child groups
    const childDescendants = getAllDescendants(childId, shapes);
    for (const id of childDescendants) {
      descendants.add(id);
    }
  }

  return descendants;
}

/**
 * Validate group hierarchy integrity.
 * Checks for cycles, orphaned references, and other inconsistencies.
 *
 * @param shapes - All shapes in the document
 * @returns Validation result with issues found
 */
export function validateGroupHierarchy(
  shapes: Record<string, Shape>
): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();

  // Check for cycles using DFS
  function checkForCycles(groupId: string): boolean {
    if (inStack.has(groupId)) {
      issues.push(`Cycle detected involving group "${groupId}"`);
      return true;
    }

    if (visited.has(groupId)) {
      return false;
    }

    const group = shapes[groupId];
    if (!group || !isGroup(group)) {
      return false;
    }

    visited.add(groupId);
    inStack.add(groupId);

    for (const childId of group.childIds) {
      if (checkForCycles(childId)) {
        return true;
      }
    }

    inStack.delete(groupId);
    return false;
  }

  // Check all groups for cycles
  for (const shape of Object.values(shapes)) {
    if (isGroup(shape)) {
      checkForCycles(shape.id);
    }
  }

  // Check for orphaned child references
  for (const shape of Object.values(shapes)) {
    if (isGroup(shape)) {
      for (const childId of shape.childIds) {
        if (!shapes[childId]) {
          issues.push(`Group "${shape.id}" references missing child "${childId}"`);
        }
      }
    }
  }

  // Check for shapes in multiple groups
  const parentMap = new Map<string, string[]>();
  for (const shape of Object.values(shapes)) {
    if (isGroup(shape)) {
      for (const childId of shape.childIds) {
        const parents = parentMap.get(childId) ?? [];
        parents.push(shape.id);
        parentMap.set(childId, parents);
      }
    }
  }

  for (const [childId, parents] of parentMap) {
    if (parents.length > 1) {
      issues.push(`Shape "${childId}" is in multiple groups: ${parents.join(', ')}`);
    }
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Get the depth of a shape in the group hierarchy.
 * Root-level shapes have depth 0.
 *
 * @param shapeId - The ID of the shape
 * @param shapes - All shapes in the document
 * @returns Depth level (0 = root, 1 = in a group, 2 = in a nested group, etc.)
 */
export function getHierarchyDepth(
  shapeId: string,
  shapes: Record<string, Shape>
): number {
  return getAncestorGroups(shapeId, shapes).length;
}

/**
 * Maximum allowed nesting depth for groups.
 * Prevents deeply nested hierarchies that could cause performance issues.
 */
export const MAX_GROUP_NESTING_DEPTH = 10;

/**
 * Check if adding a shape to a group would exceed the maximum nesting depth.
 *
 * @param shapeId - The ID of the shape being moved
 * @param targetGroupId - The ID of the group to move the shape into
 * @param shapes - All shapes in the document
 * @returns true if would exceed max depth, false if ok
 */
export function wouldExceedMaxDepth(
  shapeId: string,
  targetGroupId: string,
  shapes: Record<string, Shape>
): boolean {
  const targetDepth = getHierarchyDepth(targetGroupId, shapes) + 1;
  const shape = shapes[shapeId];

  if (!shape) return false;

  // For groups, we need to check the deepest descendant
  if (isGroup(shape)) {
    const descendants = getAllDescendants(shapeId, shapes);
    let maxDescendantDepth = 0;

    for (const descId of descendants) {
      const relativeDepth = getHierarchyDepth(descId, shapes) - getHierarchyDepth(shapeId, shapes);
      maxDescendantDepth = Math.max(maxDescendantDepth, relativeDepth);
    }

    return targetDepth + maxDescendantDepth >= MAX_GROUP_NESTING_DEPTH;
  }

  return targetDepth >= MAX_GROUP_NESTING_DEPTH;
}
