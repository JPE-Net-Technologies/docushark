import { describe, it, expect } from 'vitest';
import { filterEntries, isSubsequence } from './filter';
import type { PickerEntry } from './types';

function entry(partial: Partial<PickerEntry> & Pick<PickerEntry, 'id' | 'name' | 'category'>): PickerEntry {
  return {
    categoryLabel: partial.category,
    keywords: [],
    kind: 'builtin',
    toolType: partial.id,
    ...partial,
  };
}

const entries: PickerEntry[] = [
  entry({ id: 'diamond', name: 'Decision', category: 'flowchart', keywords: ['decision', 'if', 'branch', 'flowchart'] }),
  entry({ id: 'terminator', name: 'Terminator', category: 'flowchart', keywords: ['terminator', 'start', 'end', 'flowchart'] }),
  entry({ id: 'uml-class', name: 'Class', category: 'uml-class', keywords: ['class', 'object', 'uml', 'class'] }),
  entry({ id: 'erd-entity', name: 'Entity', category: 'erd', keywords: ['entity', 'table', 'erd'] }),
  entry({ id: 'custom-shape:1', name: 'My Widget', category: 'custom', keywords: ['my', 'widget', 'custom'], kind: 'custom' }),
];

describe('isSubsequence', () => {
  it('matches in-order character gaps', () => {
    expect(isSubsequence('dcn', 'decision')).toBe(true);
    expect(isSubsequence('xyz', 'decision')).toBe(false);
    expect(isSubsequence('decisionx', 'decision')).toBe(false);
  });
});

describe('filterEntries', () => {
  it('returns everything in category order when query is empty', () => {
    expect(filterEntries(entries, '')).toHaveLength(entries.length);
  });

  it('filters by category', () => {
    const r = filterEntries(entries, '', 'flowchart');
    expect(r.map((e) => e.id)).toEqual(['diamond', 'terminator']);
  });

  it('matches by synonym keyword', () => {
    const r = filterEntries(entries, 'if');
    expect(r[0]?.id).toBe('diamond');
  });

  it('ranks exact/prefix name matches above fuzzy ones', () => {
    const r = filterEntries(entries, 'class');
    expect(r[0]?.id).toBe('uml-class');
  });

  it('AND-matches multi-word queries', () => {
    const r = filterEntries(entries, 'uml class');
    expect(r.map((e) => e.id)).toEqual(['uml-class']);
  });

  it('returns empty when no entry matches every term', () => {
    expect(filterEntries(entries, 'uml entity')).toEqual([]);
  });

  it('respects category + query together', () => {
    const r = filterEntries(entries, 'start', 'flowchart');
    expect(r.map((e) => e.id)).toEqual(['terminator']);
  });

  it('is case-insensitive', () => {
    expect(filterEntries(entries, 'DECISION')[0]?.id).toBe('diamond');
  });
});
