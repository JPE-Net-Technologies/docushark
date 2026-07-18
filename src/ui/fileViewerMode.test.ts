import { describe, it, expect } from 'vitest';
import { resolveViewerMode } from './fileViewerMode';

describe('resolveViewerMode', () => {
  it('honors the requested mode on desktop', () => {
    expect(resolveViewerMode('modal', false)).toBe('modal');
    expect(resolveViewerMode('floating', false)).toBe('floating');
  });

  it('coerces to modal when the mobile adaptation is active', () => {
    expect(resolveViewerMode('floating', true)).toBe('modal');
    expect(resolveViewerMode('modal', true)).toBe('modal');
  });
});
