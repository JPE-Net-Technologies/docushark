/**
 * JP-335 — pending-sync page markers + the REST body-withhold.
 *
 * The withhold is the double-safety keystone: a pending page's HTML must never
 * reach the relay's stored JSON (its sole-seeder hydration would mint a
 * deterministic prose lineage that merge-doubles against the client's live
 * fragment — the JP-282 class).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  usePendingSyncPages,
  isPagePendingSync,
  pendingPagesForDoc,
  withholdPendingProseFromBody,
} from './pendingSyncPages';
import type { DiagramDocument } from '../types/Document';

function docWithProse(pages: Record<string, string>): DiagramDocument {
  return {
    id: 'doc-1',
    name: 'Doc',
    pages: {},
    pageOrder: [],
    activePageId: null,
    createdAt: 0,
    modifiedAt: 0,
    version: 2,
    richTextPages: {
      pages: Object.fromEntries(
        Object.entries(pages).map(([id, content]) => [
          id,
          { id, name: id, content, order: 0, createdAt: 0, modifiedAt: 0 },
        ]),
      ),
      pageOrder: Object.keys(pages),
      activePageId: Object.keys(pages)[0] ?? null,
    },
  } as unknown as DiagramDocument;
}

describe('pendingSyncPages store', () => {
  beforeEach(() => {
    usePendingSyncPages.setState({ pending: {} });
  });

  it('marks, queries, and clears per page', () => {
    usePendingSyncPages.getState().markPending('p1', 'doc-1');
    usePendingSyncPages.getState().markPending('p2', 'doc-2');

    expect(isPagePendingSync('p1')).toBe(true);
    expect(isPagePendingSync('nope')).toBe(false);
    expect(pendingPagesForDoc('doc-1')).toEqual(['p1']);

    usePendingSyncPages.getState().clearPending('p1');
    expect(isPagePendingSync('p1')).toBe(false);
    expect(pendingPagesForDoc('doc-1')).toEqual([]);
  });

  it('clearDoc drops only that doc’s markers', () => {
    usePendingSyncPages.getState().markPending('p1', 'doc-1');
    usePendingSyncPages.getState().markPending('p2', 'doc-2');
    usePendingSyncPages.getState().clearDoc('doc-1');
    expect(isPagePendingSync('p1')).toBe(false);
    expect(isPagePendingSync('p2')).toBe(true);
  });
});

describe('withholdPendingProseFromBody', () => {
  beforeEach(() => {
    usePendingSyncPages.setState({ pending: {} });
  });

  it('blanks a pending page’s content but keeps its meta/tab', () => {
    usePendingSyncPages.getState().markPending('new-page', 'doc-1');
    const doc = docWithProse({ 'new-page': '<p>offline words</p>', stable: '<p>synced</p>' });

    const out = withholdPendingProseFromBody(doc);

    expect(out.richTextPages?.pages['new-page']?.content).toBe('');
    // Meta survives — the tab must not vanish from the body.
    expect(out.richTextPages?.pages['new-page']?.name).toBe('new-page');
    expect(out.richTextPages?.pageOrder).toContain('new-page');
    // Non-pending pages are untouched.
    expect(out.richTextPages?.pages['stable']?.content).toBe('<p>synced</p>');
    // Input is not mutated.
    expect(doc.richTextPages?.pages['new-page']?.content).toBe('<p>offline words</p>');
  });

  it('returns the input unchanged when nothing is pending', () => {
    const doc = docWithProse({ a: '<p>x</p>' });
    expect(withholdPendingProseFromBody(doc)).toBe(doc);
  });

  it('content flows again once the marker clears', () => {
    usePendingSyncPages.getState().markPending('new-page', 'doc-1');
    const doc = docWithProse({ 'new-page': '<p>offline words</p>' });
    usePendingSyncPages.getState().clearPending('new-page');
    expect(withholdPendingProseFromBody(doc)).toBe(doc);
  });
});
