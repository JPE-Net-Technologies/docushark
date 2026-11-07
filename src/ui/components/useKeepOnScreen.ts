/**
 * A picker portalled to <body> hangs from its trigger, and near the bottom of the
 * screen part of it would be out of reach, with nothing to scroll (DSK-223). This
 * slides it up until it fits, and lets one taller than the screen scroll. It covers
 * the trigger if it must: a picker you can reach beats one beside its button.
 *
 * It runs after every render, since what's in the picker and where it hangs can
 * both change while it's open. `visualViewport` leaves out an on-screen keyboard.
 */
import { useLayoutEffect, type RefObject } from 'react';

const MARGIN = 8;

export function useKeepOnScreen(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const screenHeight = window.visualViewport?.height ?? window.innerHeight;
    element.style.maxHeight = `${screenHeight - MARGIN * 2}px`;
    element.style.overflowY = 'auto';
    const { top, height } = element.getBoundingClientRect();
    const highestThatFits = Math.max(MARGIN, screenHeight - height - MARGIN);
    if (top > highestThatFits) element.style.top = `${highestThatFits}px`;
  });
}
