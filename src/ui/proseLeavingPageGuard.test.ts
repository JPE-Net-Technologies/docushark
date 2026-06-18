import { describe, it, expect } from 'vitest';
import { shouldPersistLeavingPage } from './proseLeavingPageGuard';

describe('shouldPersistLeavingPage (JP-334)', () => {
  it('persists when the editor is bound to the page being left', () => {
    expect(shouldPersistLeavingPage('page-a', 'page-a')).toBe(true);
  });

  it('skips when the editor belongs to a different page (the read-only-page desync)', () => {
    // Leaving read-only page B, but the mounted editor is the incoming page A —
    // an unguarded save would write A's content into B's slot.
    expect(shouldPersistLeavingPage('page-a', 'page-b')).toBe(false);
  });

  it('skips when no editor is mounted (read-only ProsePreview page)', () => {
    expect(shouldPersistLeavingPage(null, 'page-b')).toBe(false);
  });

  it('skips when there is no leaving page', () => {
    expect(shouldPersistLeavingPage('page-a', null)).toBe(false);
    expect(shouldPersistLeavingPage(null, null)).toBe(false);
  });
});
