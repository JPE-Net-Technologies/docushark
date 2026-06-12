import { describe, it, expect } from 'vitest';
import { withRecent } from './shapePickerStore';

describe('withRecent', () => {
  it('prepends a new id', () => {
    expect(withRecent(['a', 'b'], 'c')).toEqual(['c', 'a', 'b']);
  });

  it('promotes an existing id to the front without duplicating', () => {
    expect(withRecent(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
  });

  it('caps the list at the max', () => {
    expect(withRecent(['a', 'b', 'c'], 'd', 3)).toEqual(['d', 'a', 'b']);
  });

  it('is a no-op-ish promotion when re-adding the head', () => {
    expect(withRecent(['a', 'b'], 'a')).toEqual(['a', 'b']);
  });
});
