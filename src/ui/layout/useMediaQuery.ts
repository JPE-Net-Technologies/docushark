/**
 * useMediaQuery — subscribe to one CSS media query.
 *
 * For a JS decision that pairs with a stylesheet rule: the document browser
 * hides its column header at the same width that its CSS turns list rows into
 * two-line rows, and moves sorting into the View menu at that width too. Both
 * sides reading the same query string means they switch at the same pixel;
 * `useBreakpoint`'s bands are `<` comparisons in JS and can disagree with a
 * `max-width` rule by one pixel.
 *
 * jsdom/SSR-safe: without `matchMedia` it reports no match.
 */

import { useEffect, useState } from 'react';

/**
 * The --bp-compact breakpoint (index.css) as a media query: phone width. CSS
 * `@media (max-width: 640px)` blocks pair with JS decisions made on this, such
 * as the Documents surface's narrow layout (DSK-196).
 */
export const COMPACT_WIDTH_QUERY = '(max-width: 640px)';

function readQuery(query: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query).matches
    : false;
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => readQuery(query));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const sync = () => setMatches(mq.matches);
    // Re-sync in case the viewport changed between first render and effect.
    sync();
    mq.addEventListener?.('change', sync);
    return () => mq.removeEventListener?.('change', sync);
  }, [query]);

  return matches;
}
