/**
 * Unit tests for the Version History panel's pure save-to-local helper
 * (JP-428): version content skips the normal document-open path, so the copy
 * builder must run the JP-347 migration funnel and strip relay ownership.
 */
import { describe, it, expect } from 'vitest';
import { buildLocalCopyFromVersion } from './VersionHistoryPanel';
import { DOCUMENT_VERSION } from '../types/Document';
import type { DiagramDocument } from '../types/Document';

function versionContent(overrides: Partial<DiagramDocument> = {}): DiagramDocument {
  return {
    id: 'doc-cloud',
    name: 'Cloud Doc',
    pages: {
      p1: {
        id: 'p1',
        name: 'Page 1',
        shapes: {},
        shapeOrder: [],
        createdAt: 1,
        modifiedAt: 2,
      },
    },
    pageOrder: ['p1'],
    activePageId: 'p1',
    createdAt: 1,
    modifiedAt: 2,
    version: 1, // an older-format recovery point
    ownerId: 'alice',
    ownerName: 'Alice',
    serverVersion: 7,
    isRelayDocument: true,
    ...overrides,
  } as DiagramDocument;
}

describe('buildLocalCopyFromVersion', () => {
  it('runs the migration funnel (old version → current format)', () => {
    const copy = buildLocalCopyFromVersion(versionContent(), 'Cloud Doc', 1_700_000_000_000);
    expect(copy.version).toBe(DOCUMENT_VERSION);
  });

  it('mints a fresh id, names the copy with the version time, and strips relay ownership', () => {
    const createdAt = 1_700_000_000_000;
    const copy = buildLocalCopyFromVersion(versionContent(), 'Cloud Doc', createdAt);
    expect(copy.id).not.toBe('doc-cloud');
    expect(copy.name).toContain('Cloud Doc (Restored ');
    // Same-day copies must stay distinguishable, so the name carries the full
    // timestamp (date AND time), not just the date.
    expect(copy.name).toContain(new Date(createdAt).toLocaleString());
    expect(copy.isRelayDocument).toBe(false);
    expect('ownerId' in copy).toBe(false);
    expect('ownerName' in copy).toBe(false);
    expect('serverVersion' in copy).toBe(false);
  });

  it('drops a fossilized legacy richTextContent when richTextPages exists', () => {
    const copy = buildLocalCopyFromVersion(
      versionContent({
        // Frozen at the relay doc's first REST save — never updated again
        // (the relay only maintains richTextPages). Carrying it into the
        // local copy makes the copy open as the first-save prose.
        richTextContent: {
          content: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }],
          },
          version: 1,
        },
        richTextPages: {
          pageOrder: ['r1'],
          pages: {
            r1: {
              id: 'r1',
              name: 'Notes',
              content: '<p>Hello</p><h1>After</h1>',
              order: 0,
              createdAt: 1,
              modifiedAt: 2,
            },
          },
          activePageId: 'r1',
        },
      }),
      'Cloud Doc',
      1,
    );
    expect('richTextContent' in copy).toBe(false);
    // The restore funnel runs migrateDocument, so the heading gains a durable
    // block id (JP-432 Pillar C) on the way through.
    expect(copy.richTextPages?.pages['r1']?.content).toMatch(
      /<h1 id="blk-[A-Za-z0-9_-]{10}">After<\/h1>/,
    );
  });

  it('preserves prose content untouched', () => {
    const copy = buildLocalCopyFromVersion(
      versionContent({
        richTextPages: {
          pageOrder: ['r1'],
          pages: {
            r1: {
              id: 'r1',
              name: 'Notes',
              content: '<p>text</p><div data-gallery data-layout="grid"><div class="gallery-items"><img src="blob://a"></div></div><p>after</p>',
              order: 0,
              createdAt: 1,
              modifiedAt: 2,
            },
          },
          activePageId: 'r1',
        },
      }),
      'Cloud Doc',
      1,
    );
    const content = copy.richTextPages?.pages['r1']?.content ?? '';
    expect(content).toContain('data-gallery');
    expect(content).toContain('<p>after</p>');
  });
});
