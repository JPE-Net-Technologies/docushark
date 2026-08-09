import { describe, it, expect } from 'vitest';
import {
  detectFileCategory,
  getMimeType,
  isPreviewableFile,
  resolveViewerCategory,
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

  it('detects audio by MIME prefix and extension fallback', () => {
    expect(detectFileCategory('audio/mpeg', 'song.mp3')).toBe('audio');
    expect(detectFileCategory('audio/ogg', 'clip.oga')).toBe('audio');
    expect(detectFileCategory('application/octet-stream', 'take.flac')).toBe('audio');
  });

  it('detects video by MIME prefix and extension fallback', () => {
    expect(detectFileCategory('video/mp4', 'demo.mp4')).toBe('video');
    expect(detectFileCategory('video/webm', 'screen.webm')).toBe('video');
    expect(detectFileCategory('application/octet-stream', 'clip.mkv')).toBe('video');
  });

  it('falls back to generic for unknown types', () => {
    expect(detectFileCategory('application/octet-stream', 'file.xyz')).toBe('generic');
    expect(detectFileCategory('application/octet-stream', 'archive.7z')).toBe('generic');
  });
});

describe('resolveViewerCategory', () => {
  it('upgrades pre-media generic shapes from their stored MIME', () => {
    expect(resolveViewerCategory('generic', 'audio/mpeg')).toBe('audio');
    expect(resolveViewerCategory('generic', 'video/mp4')).toBe('video');
  });

  it('leaves non-generic categories untouched', () => {
    expect(resolveViewerCategory('pdf', 'audio/mpeg')).toBe('pdf');
    expect(resolveViewerCategory('image', 'video/mp4')).toBe('image');
  });

  it('keeps truly generic files generic', () => {
    expect(resolveViewerCategory('generic', 'application/octet-stream')).toBe('generic');
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
