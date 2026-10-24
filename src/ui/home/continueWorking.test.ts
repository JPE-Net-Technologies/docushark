import { describe, it, expect } from 'vitest';
import { pickContinueWorking } from './continueWorking';
import type { LocalDocument } from '../../types/DocumentRegistry';

function doc(id: string, modifiedAt: number): LocalDocument {
  return { type: 'local', id, name: id, pageCount: 1, createdAt: 0, modifiedAt };
}

describe('pickContinueWorking (DSK-196)', () => {
  it('takes the most recently edited documents, whatever order the list is in', () => {
    // A list sorted by name: alphabetical order says nothing about recency.
    const byName = [doc('alpha', 10), doc('bravo', 70), doc('charlie', 30), doc('delta', 90)];
    expect(pickContinueWorking(byName, 2).map((d) => d.id)).toEqual(['delta', 'bravo']);
  });

  it('shows six by default and leaves the list itself untouched', () => {
    const list = Array.from({ length: 9 }, (_, i) => doc(`d${i}`, i));
    const before = list.map((d) => d.id);
    const picked = pickContinueWorking(list);
    expect(picked.map((d) => d.id)).toEqual(['d8', 'd7', 'd6', 'd5', 'd4', 'd3']);
    expect(list.map((d) => d.id)).toEqual(before);
  });
});
