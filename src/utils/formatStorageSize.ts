/**
 * Storage-meter number formatting (JP-477).
 *
 * `formatFileSize` (imageUtils) tops out at MB, so a workspace quota renders as
 * `20480.0 MB` and a device quota as `135266.5 MB` — technically correct, and
 * unreadable at the width of a sidebar meter. This helper is for *capacity*
 * numbers (quotas, workspace totals), where the useful unit is GB.
 *
 * Precision is deliberately unit-dependent: GB carries two decimals so a
 * workspace at 7.7 GB of 20 GB still moves the number visibly as it fills,
 * while smaller units keep one. The GB cutover is driven by **magnitude, not
 * plan** — the editor is the OSS side and has no tier claim to read (tier names
 * exist only in the Cloud control plane), so "is this a large allowance?" can
 * only be answered by the byte count itself. That happens to line up: a paid
 * workspace's quota clears 1 GB, a free one doesn't.
 */

const KB = 1024;
const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;
const TB = 1024 * 1024 * 1024 * 1024;

/**
 * Format a byte count for a capacity readout.
 *
 * ```
 *          512  → "512 B"
 *      1_536    → "1.5 KB"
 *  8_074_035    → "7.7 MB"
 * 21_474_836_480 → "20.00 GB"
 * ```
 */
export function formatStorageSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < KB) return `${Math.round(bytes)} B`;
  if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`;
  if (bytes < GB) return `${(bytes / MB).toFixed(1)} MB`;
  if (bytes < TB) return `${(bytes / GB).toFixed(2)} GB`;
  return `${(bytes / TB).toFixed(2)} TB`;
}

/**
 * Format a used/total pair for a meter.
 *
 * Each side keeps its own natural unit, so a nearly-empty workspace reads
 * `7.7 MB / 20.00 GB` rather than collapsing the used side to `0.01 GB` and
 * throwing away the only digits that are moving. A null/zero total means the
 * allowance is unknown or unmetered — say so instead of drawing a ratio
 * against a number we don't have.
 */
export function formatStoragePair(used: number, quota: number | null): string {
  if (quota === null || quota <= 0) return `${formatStorageSize(used)} used`;
  return `${formatStorageSize(used)} / ${formatStorageSize(quota)}`;
}

/** Whole-percent fill, clamped to 0–100. `null` when there's no quota to divide by. */
export function storagePercent(used: number, quota: number | null): number | null {
  if (quota === null || quota <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((used / quota) * 100)));
}
