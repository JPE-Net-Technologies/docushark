/**
 * JP-495: a filename in a chip is truncated in the MIDDLE so the extension
 * survives. Tail truncation (what CSS ellipsis does) turns
 * `quarterly-report-final-v3.pdf` into `quarterly-repo…`, throwing away the one
 * part that tells a reader what the file actually is.
 */

import { describe, it, expect } from 'vitest';
import { truncateFileNameForDisplay } from './fileUtils';

describe('truncateFileNameForDisplay', () => {
  it('leaves a short name alone', () => {
    expect(truncateFileNameForDisplay('notes.txt', 28)).toBe('notes.txt');
  });

  it('keeps the extension when it truncates', () => {
    const out = truncateFileNameForDisplay('quarterly-report-final-v3.pdf', 28);
    expect(out.endsWith('.pdf')).toBe(true);
    expect(out).toContain('…');
    expect(out.length).toBeLessThanOrEqual(28);
    expect(out.startsWith('quarterly-report')).toBe(true);
  });

  it('never exceeds the budget', () => {
    for (const n of [10, 16, 28, 40]) {
      expect(truncateFileNameForDisplay('a'.repeat(120) + '.tar.gz', n).length).toBeLessThanOrEqual(n);
    }
  });

  it('tail-truncates a name with no extension', () => {
    const out = truncateFileNameForDisplay('a'.repeat(60), 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith('…')).toBe(true);
  });

  it('does not treat a long trailing segment as an extension', () => {
    // Matches sanitizeFileName's heuristic: a dot within 10 chars of the end.
    // Otherwise `archive.2026-annual-report` would be "preserved" whole.
    const out = truncateFileNameForDisplay('archive.2026-annual-reporting', 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith('…')).toBe(true);
  });

  it('does not mistake a leading dot for an extension', () => {
    const out = truncateFileNameForDisplay('.' + 'b'.repeat(50), 20);
    expect(out.length).toBeLessThanOrEqual(20);
  });
});
