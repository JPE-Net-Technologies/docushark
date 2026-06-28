/**
 * Collab-safety proof for the ephemeral style preview (JP-401).
 *
 * The live preview (hovering a style profile) must NEVER mutate the document —
 * if it did, a collaboration session would broadcast the temporary restyle to
 * every peer. This test pins that the override lives only in `sessionStore` and
 * leaves `documentStore` completely untouched.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionStore } from './sessionStore';
import { useDocumentStore } from './documentStore';
import type { Shape } from '../shapes/Shape';

describe('ephemeral style preview is collab-safe', () => {
  beforeEach(() => {
    useSessionStore.getState().clearStylePreview();
  });

  it('setStylePreview writes only sessionStore and never the document', () => {
    const shapesBefore = useDocumentStore.getState().shapes;
    const overrides: Record<string, Partial<Shape>> = { 's1': { fill: '#ff0000', strokeWidth: 9 } };

    useSessionStore.getState().setStylePreview(overrides);

    // Override is held in the ephemeral session store…
    expect(useSessionStore.getState().stylePreviewOverrides).toBe(overrides);
    // …and the document is byte-for-byte untouched (no updateShape → no CRDT
    // broadcast, no history). Reference equality proves no mutation happened.
    expect(useDocumentStore.getState().shapes).toBe(shapesBefore);
  });

  it('clearStylePreview empties the overrides', () => {
    useSessionStore.getState().setStylePreview({ 's1': { fill: '#00ff00' } });
    useSessionStore.getState().clearStylePreview();
    expect(useSessionStore.getState().stylePreviewOverrides).toEqual({});
  });
});
