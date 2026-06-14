/**
 * Unit tests for the slash-menu matcher + filter (the pure, DOM-free parts).
 * Mirrors CitationSuggestion.test.ts.
 */

import { matchSlashTrigger, filterCommands, SLASH_COMMANDS } from './slashCommands';

describe('matchSlashTrigger', () => {
  it('matches a bare slash at the start of a block', () => {
    expect(matchSlashTrigger('/')).toEqual({ query: '', from: 0 });
  });

  it('captures the query typed after the slash', () => {
    expect(matchSlashTrigger('/head')).toEqual({ query: 'head', from: 0 });
  });

  it('matches a slash after whitespace and reports the slash offset', () => {
    // "foo /tab" → the `/` sits at index 4.
    expect(matchSlashTrigger('foo /tab')).toEqual({ query: 'tab', from: 4 });
  });

  it('does not fire inside a URL (slash not at a word boundary)', () => {
    expect(matchSlashTrigger('see http://')).toBeNull();
  });

  it('does not fire inside a path segment', () => {
    expect(matchSlashTrigger('a/b')).toBeNull();
  });

  it('does not match when the query contains a space (token ended)', () => {
    expect(matchSlashTrigger('/head ')).toBeNull();
  });

  it('returns null when there is no slash', () => {
    expect(matchSlashTrigger('hello world')).toBeNull();
  });
});

describe('filterCommands', () => {
  it('returns the first `limit` commands for an empty query', () => {
    const out = filterCommands('', 5);
    expect(out).toHaveLength(5);
    expect(out[0]).toBe(SLASH_COMMANDS[0]);
  });

  it('matches against the title', () => {
    const ids = filterCommands('heading').map((c) => c.id);
    expect(ids).toContain('h1');
    expect(ids).toContain('h2');
  });

  it('matches against keywords', () => {
    const ids = filterCommands('todo').map((c) => c.id);
    expect(ids).toContain('task');
  });

  it('matches against the id', () => {
    const ids = filterCommands('hr').map((c) => c.id);
    expect(ids).toContain('divider');
  });

  it('is case-insensitive', () => {
    expect(filterCommands('TABLE').map((c) => c.id)).toContain('table');
  });

  it('returns nothing for a non-matching query', () => {
    expect(filterCommands('zzzznope')).toEqual([]);
  });

  it('respects the limit', () => {
    expect(filterCommands('', 3)).toHaveLength(3);
  });
});
