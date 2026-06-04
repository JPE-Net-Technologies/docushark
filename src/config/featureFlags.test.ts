import { describe, it, expect, afterEach } from 'vitest';
import { isCollabProseEnabled } from './featureFlags';

describe('featureFlags', () => {
  afterEach(() => {
    localStorage.removeItem('docushark:flags:collabProse');
  });

  it('isCollabProseEnabled defaults off', () => {
    expect(isCollabProseEnabled()).toBe(false);
  });

  it('isCollabProseEnabled reads the localStorage flag', () => {
    localStorage.setItem('docushark:flags:collabProse', '1');
    expect(isCollabProseEnabled()).toBe(true);
  });

  it('only "1" enables the flag', () => {
    localStorage.setItem('docushark:flags:collabProse', 'true');
    expect(isCollabProseEnabled()).toBe(false);
  });
});
