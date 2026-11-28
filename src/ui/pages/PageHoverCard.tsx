/**
 * A page's hover card (DSK-260).
 *
 * Resting the mouse on a tab shows the page's full name, its kind, its size
 * and where it prints, as Chrome's tab hover cards do. The first card waits a
 * moment; moving along the strip then shows the next one at once. It's for a
 * mouse only: on touch the same facts head the page's menu instead.
 *
 * One card serves a whole strip: `bind(pageId)` gives a tab its handlers.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PageFacts } from './pageFacts';
import './pages.css';

const SHOW_DELAY_MS = 500;
/** After a card closes, the next one in this window shows without waiting. */
const WARM_MS = 800;
const CARD_WIDTH = 260;

export interface PageCardContent {
  title: string;
  facts: PageFacts;
}

interface CardState extends PageCardContent {
  left: number;
  top: number;
}

export interface PageHoverCardHandlers {
  onPointerEnter: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerLeave: () => void;
  onPointerDown: () => void;
}

export function usePageHoverCard(describe: (pageId: string) => PageCardContent | null) {
  const [card, setCard] = useState<CardState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const warmUntil = useRef(0);
  const shown = useRef(false);
  const describeRef = useRef(describe);
  describeRef.current = describe;

  const hide = useCallback(() => {
    clearTimeout(timer.current);
    if (shown.current) warmUntil.current = Date.now() + WARM_MS;
    shown.current = false;
    setCard(null);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  const show = useCallback((pageId: string, el: HTMLElement) => {
    if (!el.isConnected) return;
    const content = describeRef.current(pageId);
    if (!content) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - CARD_WIDTH - 8));
    shown.current = true;
    setCard({ ...content, left, top: r.bottom + 6 });
  }, []);

  const bind = useCallback(
    (pageId: string): PageHoverCardHandlers => ({
      onPointerEnter: (e) => {
        if (e.pointerType !== 'mouse') return;
        const el = e.currentTarget;
        clearTimeout(timer.current);
        if (Date.now() < warmUntil.current) show(pageId, el);
        else timer.current = setTimeout(() => show(pageId, el), SHOW_DELAY_MS);
      },
      onPointerLeave: hide,
      onPointerDown: hide,
    }),
    [hide, show],
  );

  const element = card
    ? createPortal(
        <div className="page-hover-card" role="tooltip" style={{ left: card.left, top: card.top, width: CARD_WIDTH }}>
          <span className="page-hover-card-title">{card.title}</span>
          <span className="page-hover-card-row">
            {card.facts.kind} · {card.facts.size}
          </span>
          <span className="page-hover-card-row">{card.facts.print}</span>
        </div>,
        document.body,
      )
    : null;

  return { bind, element, hide };
}
