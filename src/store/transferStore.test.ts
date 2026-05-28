import { describe, it, expect, beforeEach } from 'vitest';
import {
  useTransferStore,
  isTransferRunning,
  transferPhaseLabel,
} from './transferStore';

describe('transferStore', () => {
  beforeEach(() => {
    useTransferStore.getState().reset();
  });

  it('starts idle', () => {
    const s = useTransferStore.getState();
    expect(s.phase).toBe('idle');
    expect(s.docId).toBeNull();
    expect(s.direction).toBeNull();
    expect(s.error).toBeNull();
  });

  it('begin sets docId + direction and clears prior error', () => {
    useTransferStore.getState().fail('previous failure');
    useTransferStore.getState().begin('doc-1', 'to-relay');
    const s = useTransferStore.getState();
    expect(s.phase).toBe('preparing');
    expect(s.docId).toBe('doc-1');
    expect(s.direction).toBe('to-relay');
    expect(s.error).toBeNull();
  });

  it('setPhase mirrors transfer-service progress callbacks', () => {
    useTransferStore.getState().begin('doc-1', 'to-relay');
    for (const phase of ['prepared', 'executing', 'committing', 'committed'] as const) {
      useTransferStore.getState().setPhase(phase);
      expect(useTransferStore.getState().phase).toBe(phase);
    }
  });

  it('fail records the error and a failed phase', () => {
    useTransferStore.getState().begin('doc-1', 'to-personal');
    useTransferStore.getState().fail('relay rejected');
    const s = useTransferStore.getState();
    expect(s.phase).toBe('failed');
    expect(s.error).toBe('relay rejected');
  });

  it('reset returns to the idle state', () => {
    useTransferStore.getState().begin('doc-1', 'to-relay');
    useTransferStore.getState().reset();
    expect(useTransferStore.getState().phase).toBe('idle');
    expect(useTransferStore.getState().docId).toBeNull();
  });
});

describe('isTransferRunning', () => {
  it('is true only for in-flight phases', () => {
    expect(isTransferRunning('preparing')).toBe(true);
    expect(isTransferRunning('prepared')).toBe(true);
    expect(isTransferRunning('executing')).toBe(true);
    expect(isTransferRunning('committing')).toBe(true);
    expect(isTransferRunning('rolling-back')).toBe(true);
  });

  it('is false for idle and terminal phases', () => {
    expect(isTransferRunning('idle')).toBe(false);
    expect(isTransferRunning('committed')).toBe(false);
    expect(isTransferRunning('rolled-back')).toBe(false);
    expect(isTransferRunning('failed')).toBe(false);
  });
});

describe('transferPhaseLabel', () => {
  it('names the target direction', () => {
    expect(transferPhaseLabel('to-relay', 'executing')).toBe('Moving to Relay…');
    expect(transferPhaseLabel('to-personal', 'executing')).toBe('Moving to Personal…');
  });

  it('returns empty for terminal/idle phases', () => {
    expect(transferPhaseLabel('to-relay', 'committed')).toBe('');
    expect(transferPhaseLabel('to-relay', 'idle')).toBe('');
  });
});
