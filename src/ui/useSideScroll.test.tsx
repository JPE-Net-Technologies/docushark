/**
 * The ribbon's sideways scroll (DSK-200). jsdom has no layout, so the strip's
 * widths and scroll position are set by hand.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { useRef } from 'react';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { useSideScroll } from './useSideScroll';

function Strip({ enabled = true }: { enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useSideScroll(ref, enabled);
  return (
    <div ref={ref} data-testid="strip">
      <div />
    </div>
  );
}

/** Give the strip a width, a content width and a scroll position jsdom can't compute. */
function layOut(strip: HTMLElement, clientWidth: number, scrollWidth: number) {
  let left = 0;
  Object.defineProperty(strip, 'clientWidth', { configurable: true, get: () => clientWidth });
  Object.defineProperty(strip, 'scrollWidth', { configurable: true, get: () => scrollWidth });
  Object.defineProperty(strip, 'scrollLeft', {
    configurable: true,
    get: () => left,
    set: (value: number) => {
      left = Math.max(0, Math.min(value, scrollWidth - clientWidth));
    },
  });
}

afterEach(cleanup);

describe('useSideScroll (DSK-200)', () => {
  it('marks the ends scrolled out of view', () => {
    const { getByTestId } = render(<Strip />);
    const strip = getByTestId('strip');
    layOut(strip, 300, 500);
    fireEvent.scroll(strip);
    expect(strip.dataset['overflow']).toBe('end');
    strip.scrollLeft = 100;
    fireEvent.scroll(strip);
    expect(strip.dataset['overflow']).toBe('start end');
    strip.scrollLeft = 200;
    fireEvent.scroll(strip);
    expect(strip.dataset['overflow']).toBe('start');
  });

  it('turns a vertical wheel into a sideways scroll while the strip overflows', () => {
    const { getByTestId } = render(<Strip />);
    const strip = getByTestId('strip');
    layOut(strip, 300, 500);
    expect(fireEvent.wheel(strip, { deltaY: 80 })).toBe(false);
    expect(strip.scrollLeft).toBe(80);
    // A sideways swipe is the browser's to handle.
    expect(fireEvent.wheel(strip, { deltaX: 40, deltaY: 10 })).toBe(true);
    expect(strip.scrollLeft).toBe(80);
  });

  it('leaves the wheel alone when everything fits', () => {
    const { getByTestId } = render(<Strip />);
    const strip = getByTestId('strip');
    layOut(strip, 500, 500);
    expect(fireEvent.wheel(strip, { deltaY: 80 })).toBe(true);
    expect(strip.scrollLeft).toBe(0);
  });

  it('does nothing while disabled', () => {
    const { getByTestId } = render(<Strip enabled={false} />);
    const strip = getByTestId('strip');
    layOut(strip, 300, 500);
    expect(fireEvent.wheel(strip, { deltaY: 80 })).toBe(true);
    fireEvent.scroll(strip);
    expect(strip.dataset['overflow']).toBeUndefined();
  });
});
