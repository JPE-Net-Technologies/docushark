import { describe, it, expect } from 'vitest';
import {
  detectFileCategory,
  formatFileSize,
  getFileTypeIcon,
  getMimeType,
  isPreviewableFile,
} from './fileUtils';

describe('detectFileCategory', () => {
  it('detects PDFs by MIME type', () => {
    expect(detectFileCategory('application/pdf', 'doc.pdf')).toBe('pdf');
  });

  it('detects PDFs by extension fallback', () => {
    expect(detectFileCategory('application/octet-stream', 'doc.pdf')).toBe('pdf');
  });

  it('detects spreadsheets', () => {
    expect(detectFileCategory('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'data.xlsx')).toBe('spreadsheet');
    expect(detectFileCategory('text/csv', 'data.csv')).toBe('spreadsheet');
    expect(detectFileCategory('application/octet-stream', 'data.ods')).toBe('spreadsheet');
  });

  it('detects images', () => {
    expect(detectFileCategory('image/png', 'photo.png')).toBe('image');
    expect(detectFileCategory('image/jpeg', 'photo.jpg')).toBe('image');
    expect(detectFileCategory('image/svg+xml', 'icon.svg')).toBe('image');
    expect(detectFileCategory('application/octet-stream', 'photo.webp')).toBe('image');
  });

  it('detects text/code files', () => {
    expect(detectFileCategory('text/plain', 'readme.txt')).toBe('text');
    expect(detectFileCategory('application/json', 'config.json')).toBe('text');
    expect(detectFileCategory('application/octet-stream', 'main.py')).toBe('text');
    expect(detectFileCategory('application/octet-stream', 'app.tsx')).toBe('text');
    expect(detectFileCategory('text/markdown', 'README.md')).toBe('text');
  });

  it('falls back to generic for unknown types', () => {
    expect(detectFileCategory('application/octet-stream', 'file.xyz')).toBe('generic');
    expect(detectFileCategory('application/octet-stream', 'archive.7z')).toBe('generic');
  });
});

describe('formatFileSize', () => {
  it('formats bytes', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(512)).toBe('512 B');
  });

  it('formats kilobytes', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
  });

  it('formats megabytes', () => {
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatFileSize(5.5 * 1024 * 1024)).toBe('5.5 MB');
  });

  it('formats gigabytes', () => {
    expect(formatFileSize(1024 * 1024 * 1024)).toBe('1.0 GB');
  });

  it('handles negative values', () => {
    expect(formatFileSize(-1)).toBe('0 B');
  });
});

describe('getFileTypeIcon', () => {
  it('returns icons for each category', () => {
    expect(getFileTypeIcon('pdf')).toBe('📕');
    expect(getFileTypeIcon('spreadsheet')).toBe('📊');
    expect(getFileTypeIcon('image')).toBe('🖼️');
    expect(getFileTypeIcon('text')).toBe('📝');
    expect(getFileTypeIcon('generic')).toBe('📄');
  });
});

describe('getMimeType', () => {
  it('detects common MIME types', () => {
    expect(getMimeType('doc.pdf')).toBe('application/pdf');
    expect(getMimeType('photo.png')).toBe('image/png');
    expect(getMimeType('data.json')).toBe('application/json');
    expect(getMimeType('style.css')).toBe('text/css');
  });

  it('returns octet-stream for unknown extensions', () => {
    expect(getMimeType('file.xyz')).toBe('application/octet-stream');
    expect(getMimeType('noext')).toBe('application/octet-stream');
  });
});

describe('isPreviewableFile', () => {
  it('returns true for previewable types', () => {
    expect(isPreviewableFile('application/pdf')).toBe(true);
    expect(isPreviewableFile('image/png')).toBe(true);
    expect(isPreviewableFile('text/plain')).toBe(true);
  });

  it('returns false for generic types', () => {
    expect(isPreviewableFile('application/octet-stream')).toBe(false);
    expect(isPreviewableFile('application/zip')).toBe(false);
  });
});
