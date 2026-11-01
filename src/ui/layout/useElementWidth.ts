/**
 * useElementWidth — an element's content-box width, kept current.
 *
 * For a JS decision paired with a CSS size container query on the same
 * element: ResizeObserver's `contentRect` is the content box, which is what a
 * container query measures, so both switch at the same pixel. Null until the
 * element mounts and is measured.
 *
 * The ref callback owns the observer's whole life: React calls it with null
 * when the element goes away. (An unmount effect would be wrong as well as
 * redundant — StrictMode runs effect cleanups once on mount, which
 * disconnected the observer for good, since the ref isn't re-attached.)
 */

import { useCallback, useRef, useState } from 'react';

export function useElementWidth<T extends HTMLElement>(): [(el: T | null) => void, number | null] {
  const [width, setWidth] = useState<number | null>(null);
  const observer = useRef<ResizeObserver | null>(null);

  const ref = useCallback((el: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) {
      setWidth(null);
      return;
    }
    const ro = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    observer.current = ro;
  }, []);

  return [ref, width];
}
