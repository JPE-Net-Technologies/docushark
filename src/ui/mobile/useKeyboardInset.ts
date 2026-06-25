/**
 * useKeyboardInset — the height (px) the on-screen keyboard currently occupies,
 * derived from `window.visualViewport` (JP-332).
 *
 * On mobile the soft keyboard shrinks the visual viewport without changing the
 * layout viewport, so a bottom-anchored toolbar would otherwise be hidden behind
 * it. Reserving this inset as padding lifts the editing column above the
 * keyboard. Returns 0 where `visualViewport` is unavailable (desktop, older
 * browsers, jsdom).
 */

import { useEffect, useState } from 'react';

export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return;
    const update = () => {
      // Keyboard height ≈ layout viewport minus the visible (visual) viewport.
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setInset(Math.round(kb));
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  return inset;
}
