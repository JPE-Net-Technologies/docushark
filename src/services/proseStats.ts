/**
 * Counts for the open prose page (DSK-211). `useProseStats`, mounted with the
 * prose editor, publishes them here for the status line and Document stats.
 */
import { create } from 'zustand';
import type { Node as PMNode } from '@tiptap/pm/model';

export interface ProseStats {
  words: number;
  characters: number;
  paragraphs: number;
  /** Words in the current selection; 0 when it's collapsed. */
  selectionWords: number;
}

/** A typical adult's silent-reading speed, in words per minute. */
export const READING_WORDS_PER_MINUTE = 230;

/** Words between two positions. Blocks are separated, so a paragraph's last word doesn't run into the next's first. */
export function countWordsBetween(doc: PMNode, from: number, to: number): number {
  return doc.textBetween(from, to, ' ', ' ').split(/\s+/).filter(Boolean).length;
}

/** Counts for a whole prose document; a paragraph is any text block with text in it. */
export function countProse(doc: PMNode): Omit<ProseStats, 'selectionWords'> {
  let paragraphs = 0;
  doc.descendants((node) => {
    if (!node.isTextblock) return true;
    if (node.textContent.trim()) paragraphs += 1;
    return false;
  });
  return {
    words: countWordsBetween(doc, 0, doc.content.size),
    characters: doc.textContent.length,
    paragraphs,
  };
}

/** Minutes to read `words`, rounded, and at least one for any text. */
export function readingMinutes(words: number): number {
  return words === 0 ? 0 : Math.max(1, Math.round(words / READING_WORDS_PER_MINUTE));
}

interface ProseStatsState {
  /** The open page's counts; null while no prose editor is mounted. */
  stats: ProseStats | null;
  setStats: (stats: ProseStats | null) => void;
}

export const useProseStatsStore = create<ProseStatsState>((set) => ({
  stats: null,
  setStats: (stats) => set({ stats }),
}));
