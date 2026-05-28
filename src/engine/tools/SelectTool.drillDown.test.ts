/**
 * JP-16 — sticky + transient group drill-down.
 *
 * SelectTool.resolveHitToSelection has two modes:
 *   - default: walk up from the hit to the top-level group (today's
 *     behaviour) so the user can grab whole groups in one click.
 *   - drill (editingGroupId set): clicks inside G's subtree return the
 *     raw hit directly, including click-through into nested child
 *     groups. Clicks outside G exit drill mode.
 *
 * Tests exercise the resolver through the public class via a typed
 * accessor to keep the production class clean (no exported helpers).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SelectTool } from './SelectTool';
import type { ToolContext } from './Tool';
import { useDocumentStore } from '../../store/documentStore';
import { useSessionStore } from '../../store/sessionStore';
import type { RectangleShape, GroupShape } from '../../shapes/Shape';

import '../../shapes/Rectangle';
import '../../shapes/Group';

function rect(id: string, x = 0, y = 0): RectangleShape {
  return {
    id,
    type: 'rectangle',
    x,
    y,
    width: 100,
    height: 60,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    fill: '#4a90d9',
    stroke: '#2c5282',
    strokeWidth: 2,
    cornerRadius: 0,
  };
}

function grp(id: string, childIds: string[]): GroupShape {
  return {
    id,
    type: 'group',
    x: 0,
    y: 0,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    fill: null,
    stroke: null,
    strokeWidth: 0,
    childIds,
  };
}

/** Minimal ToolContext stub — only the methods resolveHitToSelection touches. */
function makeCtx(): ToolContext {
  return {
    getShapes: () => useDocumentStore.getState().shapes,
    getSelectedIds: () => Array.from(useSessionStore.getState().selectedIds),
  } as unknown as ToolContext;
}

/** Typed accessor for the private resolver. */
function resolve(tool: SelectTool, hitId: string, ctx: ToolContext): string {
  return (tool as unknown as {
    resolveHitToSelection: (id: string, ctx: ToolContext) => string;
  }).resolveHitToSelection(hitId, ctx);
}

describe('SelectTool — group drill-down (JP-16)', () => {
  let tool: SelectTool;
  let ctx: ToolContext;

  beforeEach(() => {
    // Layout:
    //   outer contains [inner, sibling]
    //   inner contains [leaf]
    useDocumentStore.setState({
      shapes: {
        leaf: rect('leaf'),
        sibling: rect('sibling', 300, 0),
        inner: grp('inner', ['leaf']),
        outer: grp('outer', ['inner', 'sibling']),
      },
      shapeOrder: ['outer', 'inner', 'leaf', 'sibling'],
    });
    useSessionStore.getState().clearSelection();
    useSessionStore.getState().setEditingGroupId(null);
    tool = new SelectTool();
    ctx = makeCtx();
  });

  it('cold click on a group descendant resolves to the top-level group', () => {
    expect(resolve(tool, 'leaf', ctx)).toBe('outer');
  });

  it('progressive resolution: selecting outer then clicking leaf resolves one level down to inner', () => {
    useSessionStore.getState().select(['outer']);
    // This is the existing pre-JP-16 click-through behaviour: each click
    // peels one layer. JP-16's drill mode short-circuits that.
    expect(resolve(tool, 'leaf', ctx)).toBe('inner');
  });

  it('drill mode: click inside G returns the raw leaf, even through nested groups', () => {
    useSessionStore.getState().setEditingGroupId('outer');
    // leaf is inside inner, which is inside outer — drill-through.
    expect(resolve(tool, 'leaf', ctx)).toBe('leaf');
    // Drill state preserved.
    expect(useSessionStore.getState().editingGroupId).toBe('outer');
  });

  it('drill mode: click on direct child of G returns that child', () => {
    useSessionStore.getState().setEditingGroupId('outer');
    expect(resolve(tool, 'sibling', ctx)).toBe('sibling');
    expect(useSessionStore.getState().editingGroupId).toBe('outer');
  });

  it('drill mode: click on an ungrouped top-level shape exits drill and selects the shape', () => {
    useDocumentStore.setState((s) => ({
      ...s,
      shapes: { ...s.shapes, lone: rect('lone', 500, 500) },
      shapeOrder: [...s.shapeOrder, 'lone'],
    }));
    useSessionStore.getState().setEditingGroupId('outer');

    expect(resolve(tool, 'lone', ctx)).toBe('lone');
    expect(useSessionStore.getState().editingGroupId).toBeNull();
  });

  it('drill mode: click into a different top-level group transfers drill to that group', () => {
    // Add a separate top-level group containing its own leaf.
    useDocumentStore.setState((s) => ({
      ...s,
      shapes: {
        ...s.shapes,
        otherLeaf: rect('otherLeaf', 500, 500),
        other: grp('other', ['otherLeaf']),
      },
      shapeOrder: [...s.shapeOrder, 'other', 'otherLeaf'],
    }));
    useSessionStore.getState().setEditingGroupId('outer');

    // Click on a leaf inside the other top-level group.
    expect(resolve(tool, 'otherLeaf', ctx)).toBe('otherLeaf');
    // Drill transferred — user can now freely click around inside 'other'.
    expect(useSessionStore.getState().editingGroupId).toBe('other');
  });

  it('drill mode: if the drilled group was deleted, drop drill and resolve normally', () => {
    useSessionStore.getState().setEditingGroupId('ghost-group-id');
    // Cold-style resolution (no ancestor changes) — should resolve to 'outer'.
    expect(resolve(tool, 'leaf', ctx)).toBe('outer');
    expect(useSessionStore.getState().editingGroupId).toBeNull();
  });

  it('clearSelection clears editingGroupId', () => {
    useSessionStore.getState().setEditingGroupId('outer');
    useSessionStore.getState().clearSelection();
    expect(useSessionStore.getState().editingGroupId).toBeNull();
  });

  it('setActiveTool clears editingGroupId', () => {
    useSessionStore.getState().setEditingGroupId('outer');
    useSessionStore.getState().setActiveTool('rectangle');
    expect(useSessionStore.getState().editingGroupId).toBeNull();
  });
});
