/**
 * Cold-start regression for JP-8.
 *
 * The bug: on initial app launch, the SpatialIndex used by HitTester is
 * empty until the user does *something* (tab switch, page change) that
 * triggers a documentStore mutation post-mount. Cold start results in
 * unselectable shapes — subgroups in production, all shapes in dev.
 *
 * This test simulates the cold-start sequence in isolation:
 *
 *   1. Construct an empty `SpatialIndex` and wire a `documentStore`
 *      subscription that mirrors the Engine's behavior (initial empty
 *      sync, then incremental updates that fall back to a full rebuild
 *      when `previousOrder.length === 0`).
 *   2. Trigger `documentStore.loadSnapshot()` exactly as
 *      `pageStore.syncDocumentToCurrentPage()` does on cold start.
 *   3. Run `HitTester.hitTestPoint()` against a known shape's bounds
 *      and assert a hit.
 *
 * If this test passes, the Engine's data-flow contract is correct and
 * the cold-start race must be elsewhere (React mount ordering,
 * StrictMode timing, persist-middleware rehydrate). If it fails, the
 * race is reproducible at the store-layer level and we can iterate
 * here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useDocumentStore } from '../store/documentStore';
import { SpatialIndex } from './SpatialIndex';
import { HitTester } from './HitTester';
import { Vec2 } from '../math/Vec2';
import type { RectangleShape, GroupShape } from '../shapes/Shape';

// Register shape handlers (Rectangle + Group are needed for the
// hit-test + SpatialIndex bounds resolution).
import '../shapes/Rectangle';
import '../shapes/Group';

function rect(id: string, x: number, y: number, overrides: Partial<RectangleShape> = {}): RectangleShape {
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
    ...overrides,
  };
}

function group(id: string, x: number, y: number, childIds: string[], overrides: Partial<GroupShape> = {}): GroupShape {
  return {
    id,
    type: 'group',
    x,
    y,
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    fill: null,
    stroke: null,
    strokeWidth: 0,
    childIds,
    ...overrides,
  };
}

describe('Cold-start cycle (JP-8 regression)', () => {
  // Mirror of Engine's incremental-update tracking. We don't need a real
  // Engine instance — just the subscription contract that's relevant to
  // the bug.
  let spatialIndex: SpatialIndex;
  let previousOrder: string[];
  let unsubscribe: () => void;

  function wireEngineLikeSubscription(): void {
    spatialIndex = new SpatialIndex();
    const initial = useDocumentStore.getState();
    previousOrder = initial.shapeOrder;
    // Initial sync (Engine.syncFromStores does this at construction).
    spatialIndex.rebuild(Object.values(initial.shapes));

    unsubscribe = useDocumentStore.subscribe((state) => {
      // Engine.updateSpatialIndexIncremental — first-sync fallback.
      if (previousOrder.length === 0 || Math.abs(state.shapeOrder.length - previousOrder.length) > state.shapeOrder.length * 0.5) {
        spatialIndex.rebuild(Object.values(state.shapes));
      }
      // Incremental branch omitted; the regression target is the
      // first-sync rebuild on cold start.
      previousOrder = state.shapeOrder;
    });
  }

  beforeEach(() => {
    // Pop the document store back to empty before each test, mirroring
    // the state at app boot before any document has been loaded.
    useDocumentStore.setState({ shapes: {}, shapeOrder: [] });
    wireEngineLikeSubscription();
  });

  afterEach(() => {
    unsubscribe();
  });

  it('hit-tests a top-level rectangle loaded post-Engine-mount', () => {
    // Simulate pageStore.syncDocumentToCurrentPage → documentStore.loadSnapshot
    useDocumentStore.getState().loadSnapshot({
      shapes: { 'r1': rect('r1', 0, 0) },
      shapeOrder: ['r1'],
      version: 1,
    });

    const hitTester = new HitTester(spatialIndex);
    const state = useDocumentStore.getState();
    // (0,0) is the top-left corner of the rect; the rect spans
    // (0,0)..(100,60).
    const result = hitTester.hitTestPoint(new Vec2(50, 30), state.shapes, state.shapeOrder);

    expect(result.id).toBe('r1');
  });

  it('hit-tests a child shape inside a nested subgroup loaded post-mount', () => {
    // Layout:
    //   outerGroup contains [subGroup, sibling]
    //   subGroup contains [child]
    //   child is a 100x60 rect at (0,0)
    const child = rect('child', 0, 0);
    const sibling = rect('sibling', 300, 300);
    const subGroup = group('subgroup', 0, 0, ['child']);
    const outerGroup = group('outer', 0, 0, ['subgroup', 'sibling']);

    useDocumentStore.getState().loadSnapshot({
      shapes: {
        child,
        sibling,
        subgroup: subGroup,
        outer: outerGroup,
      },
      shapeOrder: ['outer', 'subgroup', 'child', 'sibling'],
      version: 1,
    });

    const hitTester = new HitTester(spatialIndex);
    const state = useDocumentStore.getState();
    // Point inside the child's bounds. HitTester recurses into groups
    // via findHitChildInGroup, so this should resolve to the innermost
    // child even though groups are first-hit candidates from the
    // spatial index.
    const result = hitTester.hitTestPoint(new Vec2(50, 30), state.shapes, state.shapeOrder);

    expect(result.id).toBe('child');
  });

  it('handles the StrictMode double-subscribe pattern without dropping shapes', () => {
    // Simulate React.StrictMode's dev-only mount → unmount → mount cycle:
    // the Engine wires sub1, then is destroyed (unsubscribed), then a
    // fresh Engine wires sub2. The store mutation (initial document
    // load) fires between #1's wire and #2's wire when timing is
    // unfortunate — or before/after the whole cycle. We assert that as
    // long as the FINAL subscription rebuilds against the populated
    // store, hit-testing works.
    unsubscribe(); // Drop "sub1" from beforeEach.
    useDocumentStore.getState().loadSnapshot({
      shapes: { 'r1': rect('r1', 0, 0) },
      shapeOrder: ['r1'],
      version: 1,
    });
    // Now "Engine #2" wires up fresh — should see populated store via
    // its initial sync.
    wireEngineLikeSubscription();

    const hitTester = new HitTester(spatialIndex);
    const state = useDocumentStore.getState();
    const result = hitTester.hitTestPoint(new Vec2(50, 30), state.shapes, state.shapeOrder);

    expect(result.id).toBe('r1');
  });
});
