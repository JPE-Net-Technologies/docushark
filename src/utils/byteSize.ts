/**
 * Byte counts as text — the single home for turning bytes into something a
 * person reads (JP-478).
 *
 * There were two `formatFileSize` implementations before this: one in
 * `imageUtils` that stopped at MB (so a 20 GB quota rendered as `20480.0 MB`)
 * and one in `fileUtils` that continued to GB. Which one a screen got was
 * decided by an import, so the same byte count could read differently on two
 * surfaces of the same app.
 *
 * Two presentations survive, because they answer different questions:
 *
 * - `formatFileSize` — how big is this *thing*. One decimal: `1.5 GB` is the
 *   right amount of precision for a file, and `1.50 GB` is noise.
 * - `formatStorageSize` — how much of an *allowance* is left. Two decimals at
 *   GB and above, so a workspace filling up moves the number visibly instead of
 *   sitting at `7.7 GB` for a week.
 *
 * Both walk one ladder, so the unit boundaries and the rounding behaviour can
 * only be wrong in one place.
 */

const KB = 1024;
const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;
const TB = 1024 * 1024 * 1024 * 1024;

/** Decimal places used from GB up. Below GB the ladder is always 1 (or 0 for bytes). */
type LargePrecision = 1 | 2;

interface Rung {
  /** Exclusive upper bound in bytes — above this, try the next rung. */
  limit: number;
  /** Divisor to convert bytes into this rung's unit. */
  scale: number;
  decimals: number;
  suffix: string;
}

function ladder(largeDecimals: LargePrecision): Rung[] {
  return [
    { limit: KB, scale: 1, decimals: 0, suffix: 'B' },
    { limit: MB, scale: KB, decimals: 1, suffix: 'KB' },
    { limit: GB, scale: MB, decimals: 1, suffix: 'MB' },
    { limit: TB, scale: GB, decimals: largeDecimals, suffix: 'GB' },
    { limit: Infinity, scale: TB, decimals: largeDecimals, suffix: 'TB' },
  ];
}

function formatBytes(bytes: number, largeDecimals: LargePrecision): string {
  // Non-finite, negative and zero all mean "nothing here" — a meter would
  // rather read 0 than NaN, and no caller has a use for a negative size.
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';

  const rungs = ladder(largeDecimals);
  for (let i = 0; i < rungs.length; i += 1) {
    const rung = rungs[i]!;
    if (bytes >= rung.limit) continue;

    const text = (bytes / rung.scale).toFixed(rung.decimals);
    // Rounding can land exactly on the boundary this rung was chosen to be
    // below: 1048575 B is "1024.0 KB" at one decimal. Both old implementations
    // printed that. Promote to the next rung instead of showing a number the
    // ladder is supposed to have ruled out.
    const next = rungs[i + 1];
    if (next && Number(text) * rung.scale >= rung.limit) continue;

    return `${text} ${rung.suffix}`;
  }

  // Unreachable — the last rung's limit is Infinity — but the compiler wants a
  // terminal return, and a wrong answer is better than a thrown one here.
  return '0 B';
}

/**
 * A file's size.
 *
 * ```
 *        512 → "512 B"
 *      1_536 → "1.5 KB"
 *  8_074_035 → "7.7 MB"
 *  2 * 1024³ → "2.0 GB"
 * ```
 */
export function formatFileSize(bytes: number): string {
  return formatBytes(bytes, 1);
}

/**
 * A capacity — a quota, or a total measured against one.
 *
 * Gains a decimal from GB up so an allowance reads precisely:
 *
 * ```
 * 21_474_836_480 → "20.00 GB"
 *   8_074_035    → "7.7 MB"
 * ```
 *
 * The extra precision kicks in by **magnitude, not plan**: the editor is the
 * OSS side and has no tier claim to read, so the size of the number is the only
 * signal available for "is this a large allowance?". It happens to line up — a
 * paid workspace's quota clears a gigabyte, a free one doesn't.
 */
export function formatStorageSize(bytes: number): string {
  return formatBytes(bytes, 2);
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
