import {
  formatFileSize,
  formatStorageSize,
  formatStoragePair,
  storagePercent,
} from './byteSize';

const KB = 1024;
const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

// The two presentations share one ladder (JP-478), so the boundary and
// rounding cases are exercised through both.
describe('formatFileSize', () => {
  it('formats bytes', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(512)).toBe('512 B');
  });

  it('formats kilobytes', () => {
    expect(formatFileSize(KB)).toBe('1.0 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
  });

  it('formats megabytes', () => {
    expect(formatFileSize(MB)).toBe('1.0 MB');
    expect(formatFileSize(5.5 * MB)).toBe('5.5 MB');
  });

  it('formats gigabytes at one decimal — a file does not need two', () => {
    expect(formatFileSize(GB)).toBe('1.0 GB');
    expect(formatFileSize(2 * GB)).toBe('2.0 GB');
  });

  it('carries a gigabyte-scale value instead of stopping at MB', () => {
    // The regression this consolidation exists to prevent: the `imageUtils`
    // copy stopped at MB and rendered this as "20480.0 MB".
    expect(formatFileSize(20 * GB)).toBe('20.0 GB');
  });

  it('handles negative, zero and non-finite values', () => {
    expect(formatFileSize(-1)).toBe('0 B');
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(Number.NaN)).toBe('0 B');
    expect(formatFileSize(Number.POSITIVE_INFINITY)).toBe('0 B');
  });
});

describe('formatStorageSize', () => {
  it('renders sub-kilobyte values as whole bytes', () => {
    expect(formatStorageSize(285)).toBe('285 B');
    expect(formatStorageSize(1023)).toBe('1023 B');
  });

  it('renders KB and MB with one decimal', () => {
    expect(formatStorageSize(1536)).toBe('1.5 KB');
    expect(formatStorageSize(8_074_035)).toBe('7.7 MB');
  });

  it('renders GB with two decimals', () => {
    // The exact numbers the sidebar meter was cramping before JP-477.
    expect(formatStorageSize(20 * GB)).toBe('20.00 GB');
    expect(formatStorageSize(141_838_925_824)).toBe('132.10 GB');
  });

  it('carries on into TB rather than printing five-digit GB', () => {
    expect(formatStorageSize(2048 * GB)).toBe('2.00 TB');
  });

  it('treats zero, negative and non-finite input as empty', () => {
    expect(formatStorageSize(0)).toBe('0 B');
    expect(formatStorageSize(-5)).toBe('0 B');
    expect(formatStorageSize(Number.NaN)).toBe('0 B');
  });
});

describe('unit boundaries', () => {
  it('switches unit exactly at each threshold', () => {
    expect(formatStorageSize(KB - 1)).toBe('1023 B');
    expect(formatStorageSize(KB)).toBe('1.0 KB');
    expect(formatStorageSize(MB)).toBe('1.0 MB');
    expect(formatStorageSize(GB)).toBe('1.00 GB');
  });

  it('promotes a value that rounds up onto the next unit (JP-478)', () => {
    // Both old implementations printed "1024.0 KB" here — a number the ladder
    // is supposed to have ruled out. One byte short of a megabyte IS a
    // megabyte once you round to one decimal, so say so.
    expect(formatStorageSize(MB - 1)).toBe('1.0 MB');
    expect(formatFileSize(MB - 1)).toBe('1.0 MB');
    expect(formatStorageSize(GB - 1)).toBe('1.00 GB');
    expect(formatFileSize(GB - 1)).toBe('1.0 GB');
  });

  it('does not promote a value that stays below the threshold', () => {
    expect(formatStorageSize(MB - KB)).toBe('1023.0 KB');
    expect(formatFileSize(1023)).toBe('1023 B');
  });
});

describe('formatStoragePair', () => {
  it('keeps each side in its own natural unit', () => {
    // The used side stays in MB so its moving digits survive; only the
    // allowance gets the GB treatment.
    expect(formatStoragePair(8_074_035, 20 * GB)).toBe('7.7 MB / 20.00 GB');
  });

  it('states "used" when there is no allowance to divide by', () => {
    expect(formatStoragePair(8_074_035, null)).toBe('7.7 MB used');
    expect(formatStoragePair(8_074_035, 0)).toBe('7.7 MB used');
  });
});

describe('storagePercent', () => {
  it('rounds to a whole percent', () => {
    expect(storagePercent(GB / 2, GB)).toBe(50);
    expect(storagePercent(1, GB)).toBe(0);
  });

  it('clamps an over-quota workspace to 100', () => {
    expect(storagePercent(3 * GB, GB)).toBe(100);
  });

  it('returns null without a quota, so callers can hide the readout', () => {
    expect(storagePercent(GB, null)).toBeNull();
    expect(storagePercent(GB, 0)).toBeNull();
  });
});
