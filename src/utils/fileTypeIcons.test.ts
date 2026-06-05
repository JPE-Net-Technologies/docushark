import { describe, it, expect } from 'vitest';
import { getFileTypeLucideIcon } from './fileTypeIcons';
import type { FileCategory } from './fileUtils';

describe('getFileTypeLucideIcon', () => {
  it('returns a lucide component for every file category', () => {
    const categories: FileCategory[] = ['pdf', 'spreadsheet', 'image', 'text', 'generic'];
    for (const category of categories) {
      expect(getFileTypeLucideIcon(category)).toBeTruthy();
    }
  });

  it('maps distinct categories to distinct glyphs', () => {
    const pdf = getFileTypeLucideIcon('pdf');
    const image = getFileTypeLucideIcon('image');
    const generic = getFileTypeLucideIcon('generic');
    expect(pdf).not.toBe(image);
    expect(pdf).not.toBe(generic);
    expect(image).not.toBe(generic);
  });
});
