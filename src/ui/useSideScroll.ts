/**
 * A strip of controls that scrolls sideways instead of wrapping (DSK-200): the
 * prose ribbon keeps one row in a narrow panel. The ends scrolled out of view
 * are marked (`data-overflow="start end"`) so CSS can fade them, and a
 * vertical wheel scrolls the strip sideways.
 *
 * Scrolling rather than a "More" menu: the Insert tab's upload buttons
 * register the /image, /file and /gallery commands, and moving a control into
 * a menu remounts it, so closing the menu would unregister them.
 */
import { useEffect, type RefObject } from 'react';

/** Mark which ends of `strip` are scrolled out of view. */
export function markOverflow(strip: HTMLElement): void {
  const start = strip.scrollLeft > 0;
  const end = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1;
  strip.dataset['overflow'] = [start && 'start', end && 'end'].filter(Boolean).join(' ');
}

export function useSideScroll(ref: RefObject<HTMLElement>, enabled: boolean): void {
  useEffect(() => {
    const strip = ref.current;
    if (!enabled || !strip) return undefined;
    const update = () => markOverflow(strip);
    const onWheel = (event: WheelEvent) => {
      // A vertical wheel on a strip that overflows. A sideways swipe scrolls natively.
      if (strip.scrollWidth <= strip.clientWidth || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      event.preventDefault();
      strip.scrollLeft += event.deltaY;
    };
    update();
    strip.addEventListener('scroll', update, { passive: true });
    strip.addEventListener('wheel', onWheel, { passive: false });
    // The strip's size, and its content's: switching tabs changes the content.
    const observer = new ResizeObserver(update);
    observer.observe(strip);
    if (strip.firstElementChild) observer.observe(strip.firstElementChild);
    return () => {
      strip.removeEventListener('scroll', update);
      strip.removeEventListener('wheel', onWheel);
      observer.disconnect();
    };
  }, [ref, enabled]);
}
