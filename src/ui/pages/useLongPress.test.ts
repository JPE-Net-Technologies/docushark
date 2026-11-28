/**
 * Press and hold (DSK-260): a resting finger opens the menu; a moving one, or
 * a mouse, doesn't; and the click that ends a hold is swallowed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { LONG_PRESS_MS, useLongPress } from './useLongPress';

const target = document.createElement('div');

function pointer(pointerType: string, x = 10, y = 10) {
  return { pointerType, clientX: x, clientY: y, currentTarget: target } as unknown as React.PointerEvent<HTMLElement>;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useLongPress', () => {
  it('opens after a finger rests, at the finger', () => {
    const onHold = vi.fn();
    const { result } = renderHook(() => useLongPress(onHold));
    result.current.onPointerDown(pointer('touch', 40, 12));
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(onHold).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onHold).toHaveBeenCalledWith({ x: 40, y: 12 }, target);
  });

  it('lets a finger that moves scroll instead', () => {
    const onHold = vi.fn();
    const { result } = renderHook(() => useLongPress(onHold));
    result.current.onPointerDown(pointer('touch', 10, 10));
    result.current.onPointerMove(pointer('touch', 30, 10));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onHold).not.toHaveBeenCalled();
  });

  it('leaves a mouse to its right-click', () => {
    const onHold = vi.fn();
    const { result } = renderHook(() => useLongPress(onHold));
    result.current.onPointerDown(pointer('mouse'));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onHold).not.toHaveBeenCalled();
  });

  it('stops when the finger lifts early', () => {
    const onHold = vi.fn();
    const { result } = renderHook(() => useLongPress(onHold));
    result.current.onPointerDown(pointer('touch'));
    result.current.onPointerUp();
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onHold).not.toHaveBeenCalled();
  });

  it('swallows the click that ends a hold, and only that one', () => {
    const { result } = renderHook(() => useLongPress(vi.fn()));
    const click = () => {
      const e = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as React.MouseEvent<HTMLElement>;
      result.current.onClickCapture(e);
      return e;
    };
    result.current.onPointerDown(pointer('touch'));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(click().preventDefault).toHaveBeenCalled();
    expect(click().preventDefault).not.toHaveBeenCalled();
  });
});
