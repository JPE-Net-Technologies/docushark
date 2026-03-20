/**
 * Tests for ArchiveUtils — the shared archive infrastructure.
 *
 * Tests ZIP round-trip, checksum computation, manifest validation,
 * JSON encoding/decoding, and blob reference collection.
 */

/// <reference types="vitest/globals" />

import {
  createArchiveZip,
  readArchiveZip,
  computeChecksum,
  validateChecksums,
  validateManifest,
  encodeJSON,
  decodeJSON,
  buildContents,
  collectBlobsForDocuments,
} from './ArchiveUtils';
import type { ArchiveManifest } from './ArchiveTypes';
import type { ArchiveEntry } from './ArchiveTypes';

// Helper to create entries with standard TextEncoder (avoids cross-realm issues with fflate's strToU8)
function textToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function bytesToText(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

// ---------------------------------------------------------------------------
// ZIP round-trip
// ---------------------------------------------------------------------------

describe('ArchiveUtils', () => {
  describe('createArchiveZip / readArchiveZip', () => {
    it('round-trips a single text entry', () => {
      const entries: ArchiveEntry[] = [
        { path: 'hello.txt', data: textToBytes('Hello, world!') },
      ];

      const zip = createArchiveZip(entries);
      expect(zip.byteLength).toBeGreaterThan(0);

      const extracted = readArchiveZip(zip);
      expect(extracted).toHaveLength(1);
      expect(extracted[0]!.path).toBe('hello.txt');
      expect(bytesToText(extracted[0]!.data)).toBe('Hello, world!');
    });

    it('round-trips multiple entries in nested paths', () => {
      const entries: ArchiveEntry[] = [
        { path: 'manifest.json', data: textToBytes('{}') },
        { path: 'documents/doc1.json', data: textToBytes('{"id":"1"}') },
        { path: 'documents/doc2.json', data: textToBytes('{"id":"2"}') },
        { path: 'blobs/abc.bin', data: new Uint8Array([0, 1, 2, 3, 255]) },
      ];

      const zip = createArchiveZip(entries);
      const extracted = readArchiveZip(zip);

      expect(extracted).toHaveLength(4);

      const byPath = new Map(extracted.map((e) => [e.path, e]));
      expect(byPath.has('manifest.json')).toBe(true);
      expect(byPath.has('documents/doc1.json')).toBe(true);
      expect(byPath.has('documents/doc2.json')).toBe(true);
      expect(byPath.has('blobs/abc.bin')).toBe(true);

      // Verify binary data integrity
      const blobEntry = byPath.get('blobs/abc.bin')!;
      expect(Array.from(blobEntry.data)).toEqual([0, 1, 2, 3, 255]);
    });

    it('handles empty entry list', () => {
      const zip = createArchiveZip([]);
      const extracted = readArchiveZip(zip);
      expect(extracted).toHaveLength(0);
    });

    it('preserves large binary data', () => {
      const largeData = new Uint8Array(100_000);
      for (let i = 0; i < largeData.length; i++) {
        largeData[i] = i % 256;
      }

      const entries: ArchiveEntry[] = [
        { path: 'large.bin', data: largeData },
      ];

      const zip = createArchiveZip(entries);
      const extracted = readArchiveZip(zip);

      expect(extracted).toHaveLength(1);
      expect(extracted[0]!.data.byteLength).toBe(100_000);
      expect(extracted[0]!.data[0]).toBe(0);
      expect(extracted[0]!.data[255]).toBe(255);
      expect(extracted[0]!.data[256]).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Checksum
  // ---------------------------------------------------------------------------

  describe('computeChecksum', () => {
    it('returns a 64-character hex string', async () => {
      const hash = await computeChecksum(textToBytes('test'));
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('produces consistent hashes for the same data', async () => {
      const data = textToBytes('hello world');
      const hash1 = await computeChecksum(data);
      const hash2 = await computeChecksum(data);
      expect(hash1).toBe(hash2);
    });

    it('produces different hashes for different data', async () => {
      const hash1 = await computeChecksum(textToBytes('hello'));
      const hash2 = await computeChecksum(textToBytes('world'));
      expect(hash1).not.toBe(hash2);
    });

    it('handles empty data', async () => {
      const hash = await computeChecksum(new Uint8Array(0));
      expect(hash).toHaveLength(64);
      // SHA-256 of empty string is well-known
      expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });
  });

  // ---------------------------------------------------------------------------
  // Checksum validation
  // ---------------------------------------------------------------------------

  describe('validateChecksums', () => {
    it('returns empty array when all checksums match', async () => {
      const data1 = textToBytes('file1 contents');
      const data2 = textToBytes('file2 contents');

      const entries: ArchiveEntry[] = [
        { path: 'file1.txt', data: data1 },
        { path: 'file2.txt', data: data2 },
      ];

      const checksums: Record<string, string> = {
        'file1.txt': await computeChecksum(data1),
        'file2.txt': await computeChecksum(data2),
      };

      const mismatches = await validateChecksums(entries, checksums);
      expect(mismatches).toEqual([]);
    });

    it('reports mismatched files', async () => {
      const entries: ArchiveEntry[] = [
        { path: 'good.txt', data: textToBytes('correct') },
        { path: 'bad.txt', data: textToBytes('corrupted') },
      ];

      const checksums: Record<string, string> = {
        'good.txt': await computeChecksum(textToBytes('correct')),
        'bad.txt': await computeChecksum(textToBytes('original')), // Wrong hash
      };

      const mismatches = await validateChecksums(entries, checksums);
      expect(mismatches).toEqual(['bad.txt']);
    });

    it('reports missing files', async () => {
      const entries: ArchiveEntry[] = [];

      const checksums: Record<string, string> = {
        'missing.txt': 'abc123',
      };

      const mismatches = await validateChecksums(entries, checksums);
      expect(mismatches).toEqual(['missing.txt']);
    });
  });

  // ---------------------------------------------------------------------------
  // Manifest validation
  // ---------------------------------------------------------------------------

  describe('validateManifest', () => {
    const validManifest: ArchiveManifest = {
      version: 1,
      type: 'diagrammer-backup',
      createdAt: Date.now(),
      appVersion: '1.0.0',
      contents: {
        documentCount: 2,
        documentIds: ['doc1', 'doc2'],
        blobCount: 5,
        blobTotalSize: 1024,
        shapeLibraryCount: 1,
        shapeLibraryItemCount: 3,
        styleProfileCount: 2,
        hasSettings: true,
        hasColorPalette: true,
        hasIconLibrary: false,
        hasUiPreferences: true,
        hasIconPresets: false,
      },
      checksums: { 'file.json': 'abc123' },
    };

    it('accepts a valid backup manifest', () => {
      const result = validateManifest(validManifest);
      expect(result.version).toBe(1);
      expect(result.type).toBe('diagrammer-backup');
    });

    it('accepts a valid document-archive manifest', () => {
      const docManifest = { ...validManifest, type: 'diagrammer-document-archive' as const };
      const result = validateManifest(docManifest);
      expect(result.type).toBe('diagrammer-document-archive');
    });

    it('rejects null input', () => {
      expect(() => validateManifest(null)).toThrow('not an object');
    });

    it('rejects unsupported version', () => {
      expect(() => validateManifest({ ...validManifest, version: 99 })).toThrow('Unsupported manifest version');
    });

    it('rejects unknown type', () => {
      expect(() => validateManifest({ ...validManifest, type: 'invalid' })).toThrow('Unknown archive type');
    });

    it('rejects missing createdAt', () => {
      const { createdAt: _, ...noTimestamp } = validManifest;
      expect(() => validateManifest(noTimestamp)).toThrow('createdAt');
    });

    it('rejects missing appVersion', () => {
      const { appVersion: _, ...noVersion } = validManifest;
      expect(() => validateManifest(noVersion)).toThrow('appVersion');
    });

    it('rejects missing contents', () => {
      const { contents: _, ...noContents } = validManifest;
      expect(() => validateManifest(noContents)).toThrow('contents');
    });

    it('rejects missing checksums', () => {
      const { checksums: _, ...noChecksums } = validManifest;
      expect(() => validateManifest(noChecksums)).toThrow('checksums');
    });
  });

  // ---------------------------------------------------------------------------
  // JSON encoding/decoding
  // ---------------------------------------------------------------------------

  describe('encodeJSON / decodeJSON', () => {
    it('round-trips an object', () => {
      const original = { name: 'test', count: 42, nested: { a: [1, 2, 3] } };
      const encoded = encodeJSON(original);
      expect(encoded.byteLength).toBeGreaterThan(0);
      const decoded = decodeJSON(encoded);
      expect(decoded).toEqual(original);
    });

    it('handles null values', () => {
      const encoded = encodeJSON(null);
      expect(decodeJSON(encoded)).toBeNull();
    });

    it('handles arrays', () => {
      const original = [1, 'two', { three: 3 }];
      const encoded = encodeJSON(original);
      expect(decodeJSON(encoded)).toEqual(original);
    });
  });

  // ---------------------------------------------------------------------------
  // buildContents
  // ---------------------------------------------------------------------------

  describe('buildContents', () => {
    it('builds contents summary from inputs', () => {
      const result = buildContents({
        documentIds: ['a', 'b'],
        blobCount: 10,
        blobTotalSize: 5000,
        shapeLibraryCount: 2,
        shapeLibraryItemCount: 15,
        styleProfileCount: 3,
        hasSettings: true,
        hasColorPalette: false,
        hasIconLibrary: true,
        hasUiPreferences: false,
        hasIconPresets: true,
      });

      expect(result.documentCount).toBe(2);
      expect(result.documentIds).toEqual(['a', 'b']);
      expect(result.blobCount).toBe(10);
      expect(result.blobTotalSize).toBe(5000);
      expect(result.hasSettings).toBe(true);
      expect(result.hasColorPalette).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // collectBlobsForDocuments
  // ---------------------------------------------------------------------------

  describe('collectBlobsForDocuments', () => {
    it('returns empty set for non-existent documents', () => {
      const result = collectBlobsForDocuments(['non-existent-id']);
      expect(result.size).toBe(0);
    });

    it('returns empty set for empty input', () => {
      const result = collectBlobsForDocuments([]);
      expect(result.size).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Integration: ZIP + checksum round-trip
  // ---------------------------------------------------------------------------

  describe('integration: ZIP + checksum', () => {
    it('checksums validate after ZIP round-trip', async () => {
      const data1 = encodeJSON({ hello: 'world' });
      const data2 = new Uint8Array([10, 20, 30, 40, 50]);

      const entries: ArchiveEntry[] = [
        { path: 'data.json', data: data1 },
        { path: 'binary.bin', data: data2 },
      ];

      // Compute checksums BEFORE zipping
      const checksums: Record<string, string> = {};
      for (const entry of entries) {
        checksums[entry.path] = await computeChecksum(entry.data);
      }

      // Zip and unzip
      const zip = createArchiveZip(entries);
      const extracted = readArchiveZip(zip);

      // Recompute checksums on extracted data and compare
      for (const entry of extracted) {
        const hash = await computeChecksum(entry.data);
        expect(hash).toBe(checksums[entry.path]);
      }
    });
  });
});
