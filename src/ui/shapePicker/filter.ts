/**
 * Pure search/filter for the ShapePicker. Filters by category and ranks entries
 * against a query using staged matching (exact > prefix > substring > fuzzy
 * subsequence) over the entry name and its derived keywords. Multi-word queries
 * are AND-matched (every term must hit something) and scores summed, so "uml
 * class" or "start oval" narrow correctly. No React, no stores — unit-tested.
 */

import { ALL_CATEGORY, type PickerCategory, type PickerEntry } from './types';

/** Field-level score for a single term against a single field. */
function fieldScore(term: string, field: string): number {
  if (!field) return 0;
  if (field === term) return 100;
  if (field.startsWith(term)) return 70;
  if (field.includes(term)) return 40;
  // Fuzzy subsequence only for longer terms — short ones over-match.
  if (term.length >= 3 && isSubsequence(term, field)) return 15;
  return 0;
}

/** Best score of a term across an entry's name + keywords. */
function termScore(term: string, entry: PickerEntry): number {
  let best = fieldScore(term, entry.name.toLowerCase());
  for (const kw of entry.keywords) {
    if (best === 100) break;
    const s = fieldScore(term, kw);
    if (s > best) best = s;
  }
  return best;
}

/** True if every char of `needle` appears in `hay` in order. */
export function isSubsequence(needle: string, hay: string): boolean {
  if (needle.length > hay.length) return false;
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++;
  }
  return i === needle.length;
}

/**
 * Filter + rank entries.
 *
 * @param entries  the full entry list
 * @param query    raw search text (may be empty)
 * @param category category key, or `'all'` for no category restriction
 */
export function filterEntries(
  entries: PickerEntry[],
  query: string,
  category: PickerCategory = ALL_CATEGORY
): PickerEntry[] {
  const inCategory =
    category === ALL_CATEGORY
      ? entries
      : entries.filter((e) => e.category === category);

  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return inCategory;

  const terms = trimmed.split(/\s+/).filter(Boolean);

  const scored: Array<{ entry: PickerEntry; score: number }> = [];
  for (const entry of inCategory) {
    let total = 0;
    let matchedAll = true;
    for (const term of terms) {
      const s = termScore(term, entry);
      if (s === 0) {
        matchedAll = false;
        break;
      }
      total += s;
    }
    if (matchedAll) scored.push({ entry, score: total });
  }

  scored.sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.entry.name.localeCompare(b.entry.name)
  );
  return scored.map((s) => s.entry);
}
