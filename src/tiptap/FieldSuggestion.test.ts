/**
 * Tests for the `{{` field trigger (Phase 3 — Document Fields). The matcher and
 * option builder are pure; the rest of the plugin is DOM/PM-coupled.
 */
import { describe, it, expect } from 'vitest';
import { matchFieldTrigger, buildFieldOptions } from './FieldSuggestion';
import type { Field } from '../types/Field';

describe('matchFieldTrigger', () => {
  it('matches `{{` at the start with an empty query', () => {
    expect(matchFieldTrigger('{{')).toEqual({ query: '', from: 0 });
  });

  it('captures the query after `{{`', () => {
    expect(matchFieldTrigger('{{Comp')).toEqual({ query: 'Comp', from: 0 });
  });

  it('reports the `{` offset mid-text', () => {
    // "Hello {{na" → first brace at index 6
    expect(matchFieldTrigger('Hello {{na')).toEqual({ query: 'na', from: 6 });
  });

  it('allows spaces in the query (multi-word field names)', () => {
    expect(matchFieldTrigger('{{Effective Da')).toEqual({ query: 'Effective Da', from: 0 });
  });

  it('does not match without `{{`', () => {
    expect(matchFieldTrigger('just text')).toBeNull();
    expect(matchFieldTrigger('a { b')).toBeNull();
  });

  it('stops matching once the field is closed', () => {
    expect(matchFieldTrigger('{{name}}')).toBeNull();
    expect(matchFieldTrigger('{{name} ')).toBeNull();
  });

  it('does not re-trigger on a triple brace', () => {
    // The leading `[^{]` guard means `{{{` is not a fresh `{{` token.
    expect(matchFieldTrigger('{{{')).toBeNull();
  });
});

describe('buildFieldOptions', () => {
  const fields: Field[] = [
    { name: 'Company', value: 'Acme' },
    { name: 'Version', value: '2.0' },
  ];

  it('lists user fields then computed fields', () => {
    const opts = buildFieldOptions('', fields);
    const userNames = opts.filter((o) => o.kind === 'field').map((o) => o.name);
    const computedNames = opts.filter((o) => o.kind === 'computed').map((o) => o.name);
    expect(userNames).toEqual(['Company', 'Version']);
    expect(computedNames).toContain('today');
    expect(computedNames).toContain('now');
  });

  it('filters by query (case-insensitive)', () => {
    const opts = buildFieldOptions('comp', fields);
    expect(opts.filter((o) => o.kind === 'field').map((o) => o.name)).toEqual(['Company']);
  });

  it('offers a create row for a non-matching query', () => {
    const opts = buildFieldOptions('Brand New', fields);
    const create = opts.find((o) => o.kind === 'create');
    expect(create).toEqual({ kind: 'create', name: 'Brand New' });
  });

  it('omits the create row when the query exactly names an existing field', () => {
    const opts = buildFieldOptions('Company', fields);
    expect(opts.some((o) => o.kind === 'create')).toBe(false);
  });

  it('omits the create row for an empty query', () => {
    const opts = buildFieldOptions('', fields);
    expect(opts.some((o) => o.kind === 'create')).toBe(false);
  });
});
