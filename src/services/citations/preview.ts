/**
 * Short, dependency-free preview text for a reference (JP-89).
 *
 * One shared helper so the inline-citation hover tooltip, the citation picker
 * rows, and the reference-manager rows all describe a reference the same way.
 * No `@citation-js` / CSL dependency — this is a cheap label, not formatting.
 */

import type { CSLItem } from '../../types/Citation';

/** `Author (year). Title` — falling back gracefully when fields are missing. */
export function referencePreview(item: CSLItem): string {
  const author = item.author?.[0];
  const name = author?.family ?? author?.literal ?? '';
  const year = item.issued?.['date-parts']?.[0]?.[0];
  const parts: string[] = [];
  if (name) parts.push(year ? `${name} (${year})` : name);
  if (item.title) parts.push(item.title);
  return parts.join('. ') || item.id || 'Reference';
}
