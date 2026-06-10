/**
 * Citation hover card (JP-89 delight slice).
 *
 * Hovering an inline citation shows a small popover with the *full* formatted
 * reference (the bibliography-style entry) in the document's active style — a
 * quick "what is this?" without scrolling to the bibliography.
 *
 * A single shared card element (one per app, reused across every citation)
 * managed imperatively, the same approach as the `@`-trigger suggestion popup.
 * The CSL formatter is lazy-loaded (citation-js + vendored CSL), so the heavy
 * chunk only loads when someone actually hovers a citation; until it resolves
 * (or if it fails / we're offline) the card shows the cheap, dependency-free
 * `referencePreview` label.
 */

import type { CSLItem, CitationStyle } from '../types/Citation';
import { referencePreview } from '../services/citations/preview';
import './citationHoverCard.css';

type FormatModule = typeof import('../services/citations/format');
let formatModule: Promise<FormatModule> | null = null;
function getFormat(): Promise<FormatModule> {
  if (!formatModule) formatModule = import('../services/citations/format');
  return formatModule;
}

let card: HTMLDivElement | null = null;
/** Bumped on every show/hide so a slow async format can't paint a stale card. */
let token = 0;

function ensureCard(): HTMLDivElement {
  if (!card) {
    card = document.createElement('div');
    card.className = 'citation-card';
    card.setAttribute('role', 'tooltip');
    // The card is non-interactive; pointer events would steal hover from the
    // citation and flicker it away.
    card.style.pointerEvents = 'none';
    card.style.display = 'none';
    document.body.appendChild(card);
  }
  return card;
}

function position(el: HTMLDivElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  // Measure after content is set; clamp into the viewport.
  el.style.left = '0px';
  el.style.top = '0px';
  const cardRect = el.getBoundingClientRect();
  const margin = 8;
  let left = rect.left;
  if (left + cardRect.width > window.innerWidth - margin) {
    left = Math.max(margin, window.innerWidth - margin - cardRect.width);
  }
  // Prefer below; flip above when it would overflow the bottom.
  let top = rect.bottom + 6;
  if (top + cardRect.height > window.innerHeight - margin) {
    top = Math.max(margin, rect.top - cardRect.height - 6);
  }
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

/** Show the hover card for `item` anchored to `anchor`, formatted in `style`. */
export function showCitationCard(anchor: HTMLElement, item: CSLItem, style: CitationStyle): void {
  const el = ensureCard();
  const my = ++token;
  // Cheap, synchronous content first so the card never appears empty.
  el.textContent = referencePreview(item);
  el.style.display = 'block';
  position(el, anchor);

  void getFormat()
    .then(({ formatBibliography }) => formatBibliography([item], style))
    .then((html) => {
      if (my !== token) return; // superseded by another hover / a hide
      if (html) {
        el.innerHTML = `<div class="citation-card-entry">${html}</div>`;
        position(el, anchor); // re-measure: formatted entry may be taller
      }
    })
    .catch(() => {
      /* keep the preview-text fallback */
    });
}

/** Hide the hover card (and cancel any in-flight async render). */
export function hideCitationCard(): void {
  token++;
  if (card) card.style.display = 'none';
}
