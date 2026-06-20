import { describe, it, expect } from 'vitest';
import { resolveIconCacheKey } from './iconCache';

describe('resolveIconCacheKey', () => {
  it('keys single-color icons per color variant', () => {
    expect(resolveIconCacheKey('builtin:server', '#ff0000', false)).toBe('builtin:server:#ff0000');
    expect(resolveIconCacheKey('builtin:server', '#00ff00', false)).toBe('builtin:server:#00ff00');
  });

  it('uses the colorless key when no color is requested', () => {
    expect(resolveIconCacheKey('builtin:server', undefined, false)).toBe('builtin:server');
  });

  it('shares one colorless entry for multi-color (cloud) icons regardless of color', () => {
    // Cloud icons ignore the requested color, so every variant must collapse to
    // a single entry — otherwise each recolor forks a transparent-until-loaded
    // entry (the JP-325 #3 transparency bug).
    expect(resolveIconCacheKey('builtin:aws-s3', '#ff0000', true)).toBe('builtin:aws-s3');
    expect(resolveIconCacheKey('builtin:aws-s3', '#123456', true)).toBe('builtin:aws-s3');
    expect(resolveIconCacheKey('builtin:aws-s3', undefined, true)).toBe('builtin:aws-s3');
  });
});
