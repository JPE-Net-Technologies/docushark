import { describe, it, expect, beforeEach } from 'vitest';
import { useConfirmStore, confirmDialog } from './confirmStore';

describe('confirmDialog store', () => {
  beforeEach(() => useConfirmStore.setState({ current: null, queue: [] }));

  it('enqueues a request and resolves with the confirm result', async () => {
    const p = confirmDialog({ title: 'Delete it?' });
    expect(useConfirmStore.getState().current?.title).toBe('Delete it?');

    useConfirmStore.getState()._resolve(true);

    await expect(p).resolves.toBe(true);
    expect(useConfirmStore.getState().current).toBeNull();
  });

  it('queues concurrent requests and advances to the next on resolve', async () => {
    const p1 = confirmDialog({ title: 'A' });
    const p2 = confirmDialog({ title: 'B' });

    expect(useConfirmStore.getState().current?.title).toBe('A');
    expect(useConfirmStore.getState().queue).toHaveLength(1);

    useConfirmStore.getState()._resolve(false);
    await expect(p1).resolves.toBe(false);
    expect(useConfirmStore.getState().current?.title).toBe('B');

    useConfirmStore.getState()._resolve(true);
    await expect(p2).resolves.toBe(true);
    expect(useConfirmStore.getState().current).toBeNull();
  });
});
