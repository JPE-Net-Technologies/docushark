import { describe, it, expect, afterEach } from 'vitest';
import { isOfflineFirstEngineEnabled } from './offlineFirstEngine';

const FLAG_KEY = 'docushark:flags:offlineFirstEngine';

describe('isOfflineFirstEngineEnabled', () => {
  afterEach(() => {
    localStorage.removeItem(FLAG_KEY);
  });

  it('defaults ON when the flag is unset', () => {
    expect(isOfflineFirstEngineEnabled()).toBe(true);
  });

  it('stays ON for any value other than "0"', () => {
    localStorage.setItem(FLAG_KEY, '1');
    expect(isOfflineFirstEngineEnabled()).toBe(true);
  });

  it('is disabled only by an explicit "0"', () => {
    localStorage.setItem(FLAG_KEY, '0');
    expect(isOfflineFirstEngineEnabled()).toBe(false);
  });
});
