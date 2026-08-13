/**
 * The descriptor is the one boundary both file hosts pass through (JP-495), so
 * it is where the two blob-reference forms have to be reconciled: a canvas
 * `FileShape` stores a **bare hash**, a prose chip stores the **`blob://<hash>`
 * URI**. Getting that wrong doesn't throw — it produces a viewer that silently
 * fails to load, or a reference the blob walk can't see.
 */

import { describe, it, expect } from 'vitest';

import { toBlobHash, describeFileShape } from './fileDescriptor';
import type { FileShape, Shape } from '../shapes/Shape';

const HASH = 'a'.repeat(64);

function fileShape(overrides: Partial<FileShape> = {}): Shape {
  return {
    id: 'shape-1',
    type: 'file',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    blobRef: HASH,
    fileName: 'report.pdf',
    mimeType: 'application/pdf',
    fileSize: 2048,
    fileCategory: 'pdf',
    ...overrides,
  } as unknown as Shape;
}

describe('toBlobHash', () => {
  it('passes a bare hash through', () => {
    expect(toBlobHash(HASH)).toBe(HASH);
  });

  it('strips the blob:// URI form', () => {
    expect(toBlobHash(`blob://${HASH}`)).toBe(HASH);
  });

  it('never yields a double-prefixed value', () => {
    // The failure this guards: a caller that prefixes an already-prefixed ref.
    // A single `startsWith` strip would leave `blob://<hash>` and the blob would
    // simply never resolve, with nothing reporting why.
    expect(toBlobHash(`blob://blob://${HASH}`)).toBe(HASH);
    expect(toBlobHash(`blob://blob://blob://${HASH}`)).toBe(HASH);
  });

  it('leaves an empty ref empty rather than inventing one', () => {
    expect(toBlobHash('')).toBe('');
    expect(toBlobHash('blob://')).toBe('');
  });
});

describe('describeFileShape', () => {
  it('describes a file shape', () => {
    const d = describeFileShape(fileShape());
    expect(d).toMatchObject({
      blobRef: HASH,
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
      fileSize: 2048,
      fileCategory: 'pdf',
      sourceId: 'shape-1',
    });
  });

  it('normalizes a shape whose blobRef carries the URI form', () => {
    // Shapes store bare hashes today, but a prefixed value must still resolve
    // rather than producing a viewer stuck on "not found".
    const d = describeFileShape(fileShape({ blobRef: `blob://${HASH}` } as Partial<FileShape>));
    expect(d?.blobRef).toBe(HASH);
  });

  it('carries the stored category rather than re-deriving it', () => {
    // Deriving here would silently change which viewer opens for any shape
    // whose stored category disagrees with its mime.
    const d = describeFileShape(
      fileShape({ fileCategory: 'generic', mimeType: 'application/pdf' } as Partial<FileShape>),
    );
    expect(d?.fileCategory).toBe('generic');
  });

  it('returns null for a missing or non-file shape', () => {
    expect(describeFileShape(undefined)).toBeNull();
    expect(describeFileShape({ id: 'r1', type: 'rectangle' } as unknown as Shape)).toBeNull();
  });

  it('attaches host capabilities when given, and none otherwise', () => {
    // Absent capabilities are what make the viewer HIDE replace/recover for a
    // prose chip instead of offering an action with nowhere to write back to.
    const plain = describeFileShape(fileShape());
    expect(plain?.onReplace).toBeUndefined();
    expect(plain?.onRecover).toBeUndefined();

    const capable = describeFileShape(fileShape(), {
      onReplace: async () => true,
      onRecover: async () => true,
    });
    expect(typeof capable?.onReplace).toBe('function');
    expect(typeof capable?.onRecover).toBe('function');
  });
});
