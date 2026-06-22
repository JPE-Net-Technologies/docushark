import { describe, it, expect } from 'vitest';
import { CANVAS_PAGE_BASE, PROSE_PAGE_BASE, nextDefaultPageName } from './pageNaming';

describe('nextDefaultPageName', () => {
  it('names the first page with the bare base', () => {
    expect(nextDefaultPageName(CANVAS_PAGE_BASE, [])).toBe('Canvas');
    expect(nextDefaultPageName(PROSE_PAGE_BASE, [])).toBe('Prose');
  });

  it('increments to p.2 once a bare base exists', () => {
    expect(nextDefaultPageName('Canvas', ['Canvas'])).toBe('Canvas p.2');
    expect(nextDefaultPageName('Prose', ['Prose'])).toBe('Prose p.2');
  });

  it('continues the sequence from existing p.N pages', () => {
    expect(nextDefaultPageName('Prose', ['Prose', 'Prose p.2', 'Prose p.3'])).toBe('Prose p.4');
  });

  it('is monotonic (max+1) — never reuses a deleted number', () => {
    // [Prose, Prose p.2, Prose p.3] with p.2 deleted → highest is 3 → next is p.4
    expect(nextDefaultPageName('Prose', ['Prose', 'Prose p.3'])).toBe('Prose p.4');
  });

  it('counts the bare base as p.1 even with a gap', () => {
    // only "Prose p.3" survives (bare + p.2 deleted) → max 3 → next p.4
    expect(nextDefaultPageName('Prose', ['Prose p.3'])).toBe('Prose p.4');
  });

  it('ignores names that do not match the base pattern', () => {
    expect(nextDefaultPageName('Prose', ['Intro', 'Appendix'])).toBe('Prose');
    expect(nextDefaultPageName('Prose', ['Intro', 'Prose p.2'])).toBe('Prose p.3');
  });

  it('keeps canvas and prose counters independent', () => {
    const names = ['Canvas', 'Prose', 'Prose p.2'];
    expect(nextDefaultPageName('Canvas', names)).toBe('Canvas p.2');
    expect(nextDefaultPageName('Prose', names)).toBe('Prose p.3');
  });

  it('does not treat non-integer or zero suffixes as matches', () => {
    expect(nextDefaultPageName('Prose', ['Prose p.x', 'Prose p.0', 'Prose p.2.5'])).toBe('Prose');
  });
});
