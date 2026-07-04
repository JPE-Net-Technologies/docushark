/**
 * Version-history summary helpers (JP-185).
 *
 * Pure functions that reduce a document body (the JSON returned by the relay's
 * recovery-point content endpoint) to a lightweight, renderable summary, and
 * compare two summaries so the panel can show what restoring a version would
 * change relative to the current document. No DOM, no store access.
 */

import type { DiagramDocument } from '../types/Document';
import type { RelayRecoveryPoint } from '../api/relayClient';

export interface CanvasPageSummary {
  id: string;
  name: string;
  shapeCount: number;
}

export interface ProsePageSummary {
  id: string;
  name: string;
  wordCount: number;
}

export interface VersionSummary {
  canvasPages: CanvasPageSummary[];
  prosePages: ProsePageSummary[];
  totalShapes: number;
  totalWords: number;
}

/** Rough word count of an HTML fragment: strip tags, split on whitespace. */
export function countWordsInHtml(html: string): number {
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .trim();
  if (text === '') return 0;
  return text.split(/\s+/).length;
}

/** Reduce a document body to per-page counts, in page order. */
export function summarizeDocument(doc: DiagramDocument): VersionSummary {
  const canvasPages: CanvasPageSummary[] = [];
  for (const pageId of doc.pageOrder) {
    const page = doc.pages[pageId];
    if (!page) continue;
    canvasPages.push({
      id: page.id,
      name: page.name,
      shapeCount: page.shapeOrder.length,
    });
  }

  const prosePages: ProsePageSummary[] = [];
  const rtp = doc.richTextPages;
  if (rtp) {
    for (const pageId of rtp.pageOrder) {
      const page = rtp.pages[pageId];
      if (!page) continue;
      prosePages.push({
        id: page.id,
        name: page.name,
        wordCount: countWordsInHtml(page.content),
      });
    }
  }

  return {
    canvasPages,
    prosePages,
    totalShapes: canvasPages.reduce((n, p) => n + p.shapeCount, 0),
    totalWords: prosePages.reduce((n, p) => n + p.wordCount, 0),
  };
}

export interface VersionDelta {
  /** Page names present in the version but not in the current document. */
  pagesOnlyInVersion: string[];
  /** Page names present in the current document but not in the version. */
  pagesOnlyInCurrent: string[];
  /** version.totalShapes − current.totalShapes */
  shapeDelta: number;
  /** version.totalWords − current.totalWords */
  wordDelta: number;
}

/**
 * Compare a version's summary against the current document's: what restoring
 * the version would add/remove. Pages are matched by id across both the canvas
 * and prose collections.
 */
export function diffVersionSummaries(
  current: VersionSummary,
  version: VersionSummary,
): VersionDelta {
  const collect = (s: VersionSummary) =>
    new Map<string, string>(
      [...s.canvasPages, ...s.prosePages].map((p) => [p.id, p.name]),
    );
  const currentPages = collect(current);
  const versionPages = collect(version);

  const pagesOnlyInVersion: string[] = [];
  for (const [id, name] of versionPages) {
    if (!currentPages.has(id)) pagesOnlyInVersion.push(name);
  }
  const pagesOnlyInCurrent: string[] = [];
  for (const [id, name] of currentPages) {
    if (!versionPages.has(id)) pagesOnlyInCurrent.push(name);
  }

  return {
    pagesOnlyInVersion,
    pagesOnlyInCurrent,
    shapeDelta: version.totalShapes - current.totalShapes,
    wordDelta: version.totalWords - current.totalWords,
  };
}

export interface VersionDayGroup {
  /** "Today", "Yesterday", or a locale date string. */
  label: string;
  points: RelayRecoveryPoint[];
}

/** Start of the local day containing `ms`. */
function dayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Group recovery points (assumed newest-first, as the relay returns them) into
 * day buckets with friendly labels, preserving order.
 */
export function groupPointsByDay(
  points: RelayRecoveryPoint[],
  now: number = Date.now(),
): VersionDayGroup[] {
  const today = dayStart(now);
  const yesterday = dayStart(today - 1);
  const groups: VersionDayGroup[] = [];
  for (const point of points) {
    const start = dayStart(point.createdAt);
    const label =
      start === today
        ? 'Today'
        : start === yesterday
          ? 'Yesterday'
          : new Date(point.createdAt).toLocaleDateString(undefined, {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            });
    const last = groups[groups.length - 1];
    if (last && last.label === label) {
      last.points.push(point);
    } else {
      groups.push({ label, points: [point] });
    }
  }
  return groups;
}
