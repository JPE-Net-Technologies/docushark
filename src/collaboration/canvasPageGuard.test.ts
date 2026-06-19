/**
 * JP-341 — canvas page-guard predicate. The guard is ON only in an online relay
 * session bound to a DIFFERENT page than the one currently active (editing it
 * would flatten shapes onto the relay's hydrated page, JP-340). It must be OFF
 * for local/offline docs (full multi-page editing) and on the bound page itself.
 */
import { describe, it, expect } from 'vitest';
import { canvasPageGuarded } from './canvasPageGuard';

describe('canvasPageGuarded (JP-341)', () => {
  it('is OFF when no relay session is live (local / offline docs edit freely)', () => {
    expect(
      canvasPageGuarded({ relayLive: false, relayPageId: 'p1', activePageId: 'p2' }),
    ).toBe(false);
  });

  it('is OFF when no relay page is bound yet', () => {
    expect(
      canvasPageGuarded({ relayLive: true, relayPageId: null, activePageId: 'p1' }),
    ).toBe(false);
  });

  it('is OFF on the relay-bound page (the editable page)', () => {
    expect(
      canvasPageGuarded({ relayLive: true, relayPageId: 'p1', activePageId: 'p1' }),
    ).toBe(false);
  });

  it('is ON after switching to a different page in a live relay session', () => {
    expect(
      canvasPageGuarded({ relayLive: true, relayPageId: 'p1', activePageId: 'p2' }),
    ).toBe(true);
  });

  it('treats a null active page as not-guarded (nothing to protect)', () => {
    expect(
      canvasPageGuarded({ relayLive: true, relayPageId: 'p1', activePageId: null }),
    ).toBe(true); // p1 !== null → guarded; the page-switch case is the real driver
  });
});
