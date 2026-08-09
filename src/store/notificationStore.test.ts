import { beforeEach, afterEach, vi } from 'vitest';
import { useNotificationStore } from './notificationStore';

/**
 * The auto-dismiss countdown (JP-479). It used to be a bare `setTimeout` that
 * ran whether or not anyone was reading the toast; these pin the pausable
 * version, including the leak cases that only show up under eviction.
 */
describe('notification auto-dismiss', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useNotificationStore.getState().dismissAll();
  });

  afterEach(() => {
    useNotificationStore.getState().dismissAll();
    vi.useRealTimers();
  });

  const ids = () => useNotificationStore.getState().notifications.map((n) => n.id);

  it('dismisses itself once the duration elapses', () => {
    const id = useNotificationStore.getState().info('hello', { duration: 1000 });
    expect(ids()).toContain(id);
    vi.advanceTimersByTime(1001);
    expect(ids()).not.toContain(id);
  });

  it('never auto-dismisses a duration-0 toast', () => {
    const id = useNotificationStore.getState().info('sticky', { duration: 0 });
    vi.advanceTimersByTime(120_000);
    expect(ids()).toContain(id);
  });

  it('holds the countdown while paused', () => {
    const store = useNotificationStore.getState();
    const id = store.info('hello', { duration: 1000 });
    vi.advanceTimersByTime(600);
    store.pauseDismiss(id);
    // Well past the original deadline — a paused toast must not expire.
    vi.advanceTimersByTime(10_000);
    expect(ids()).toContain(id);
  });

  it('resumes with only the remaining time, not a fresh full duration', () => {
    const store = useNotificationStore.getState();
    const id = store.info('hello', { duration: 1000 });
    vi.advanceTimersByTime(600);
    store.pauseDismiss(id);
    vi.advanceTimersByTime(5000);
    store.resumeDismiss(id);
    // 400ms were owed. Just short of it, still here.
    vi.advanceTimersByTime(350);
    expect(ids()).toContain(id);
    vi.advanceTimersByTime(100);
    expect(ids()).not.toContain(id);
  });

  it('grants a minimum grace period to a toast paused past its deadline', () => {
    const store = useNotificationStore.getState();
    const id = store.info('hello', { duration: 1000 });
    // Pausing at 999ms leaves ~1ms owed; resuming shouldn't vanish it instantly
    // the moment the pointer leaves.
    vi.advanceTimersByTime(999);
    store.pauseDismiss(id);
    store.resumeDismiss(id);
    vi.advanceTimersByTime(200);
    expect(ids()).toContain(id);
    vi.advanceTimersByTime(300);
    expect(ids()).not.toContain(id);
  });

  it('is idempotent — a second pause does not lose the remaining time', () => {
    const store = useNotificationStore.getState();
    const id = store.info('hello', { duration: 1000 });
    vi.advanceTimersByTime(400);
    store.pauseDismiss(id);
    store.pauseDismiss(id);
    store.resumeDismiss(id);
    vi.advanceTimersByTime(550);
    expect(ids()).toContain(id);
    vi.advanceTimersByTime(100);
    expect(ids()).not.toContain(id);
  });

  it('ignores pause/resume for an unknown id', () => {
    const store = useNotificationStore.getState();
    expect(() => store.pauseDismiss('nope')).not.toThrow();
    expect(() => store.resumeDismiss('nope')).not.toThrow();
  });

  it('does not resurrect a toast dismissed while paused', () => {
    const store = useNotificationStore.getState();
    const id = store.info('hello', { duration: 1000 });
    store.pauseDismiss(id);
    store.dismiss(id);
    store.resumeDismiss(id);
    vi.advanceTimersByTime(10_000);
    expect(ids()).not.toContain(id);
  });

  it('drops the countdown of a toast evicted by the max-notifications cap', () => {
    const store = useNotificationStore.getState();
    const max = store.maxNotifications;
    const first = store.info('oldest', { duration: 1000 });
    for (let i = 0; i < max; i += 1) store.info(`filler ${i}`, { duration: 60_000 });

    // `first` was pushed out by the cap, not dismissed.
    expect(ids()).not.toContain(first);
    const before = ids().length;
    // Its orphaned timer would fire here; it must not disturb the survivors.
    vi.advanceTimersByTime(2000);
    expect(ids().length).toBe(before);
  });

  it('clears every countdown on dismissAll', () => {
    const store = useNotificationStore.getState();
    store.info('a', { duration: 1000 });
    store.info('b', { duration: 1000 });
    store.dismissAll();
    const late = store.info('c', { duration: 5000 });
    // The cleared timers must not fire and take the new toast's place.
    vi.advanceTimersByTime(2000);
    expect(ids()).toEqual([late]);
  });
});

describe('notification title (JP-479)', () => {
  beforeEach(() => useNotificationStore.getState().dismissAll());

  it('is omitted entirely when not supplied, so existing callers are unchanged', () => {
    const id = useNotificationStore.getState().success('Saved');
    const n = useNotificationStore.getState().notifications.find((x) => x.id === id);
    expect(n).toBeDefined();
    expect('title' in n!).toBe(false);
  });

  it('is carried through notify()', () => {
    const id = useNotificationStore.getState().notify({
      title: 'Import finished',
      message: '12 pages added.',
      severity: 'success',
    });
    const n = useNotificationStore.getState().notifications.find((x) => x.id === id);
    expect(n?.title).toBe('Import finished');
  });

  it('can be set on an existing toast via update()', () => {
    const store = useNotificationStore.getState();
    const id = store.info('Importing…', { duration: 0 });
    store.update(id, { title: 'Import finished', message: 'Done.' });
    const n = useNotificationStore.getState().notifications.find((x) => x.id === id);
    expect(n?.title).toBe('Import finished');
    expect(n?.message).toBe('Done.');
  });
});
