/**
 * Origin-blindness invariant for `documentStore.ts`.
 *
 * `documentStore` holds the live shape graph for whichever document
 * is currently being edited — local or relay. It must stay
 * transport-agnostic: it should never import any relay/auth/sync
 * code, because doing so would make local-document editing depend
 * on the relay layer being initialized.
 *
 * This test guards against regressions where someone wires "just a
 * quick connectionStore selector" or "let me read the user from
 * userStore" into documentStore — both of which create circular or
 * unnecessary coupling.
 *
 * The set of forbidden modules below matches the post-Slice-E
 * architecture: relay client/REST/persistence helpers, sync/CRDT
 * provider, connection/auth stores, and any tauri commands. If a
 * future refactor genuinely needs one of these in documentStore,
 * the right move is to discuss it explicitly — not to silently
 * update this allow-list.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCUMENT_STORE_PATH = resolve(__dirname, './documentStore.ts');

/**
 * Module *basenames* (last path segment, no extension) that must not
 * appear in any `import` specifier in `documentStore.ts`. Matched as
 * a regex anchored on `/` or end-of-string so both relative
 * (`./connectionStore`) and parent (`../api/relayClient`) forms are
 * caught, but unrelated paths that happen to contain the substring
 * are not (e.g. `'./foo/connectionStoreView'` would not match
 * `'connectionStore'`).
 */
const FORBIDDEN_MODULE_BASENAMES = [
  // Relay REST surface.
  'relayClient',
  'relayConnection',
  'restDocumentProvider',
  // Relay document store + sync provider.
  'relayDocumentStore',
  'UnifiedSyncProvider',
  'collaborationStore',
  'BlobSyncService',
  // Auth + session.
  'connectionStore',
  'userStore',
  'permissionStore',
  // Tauri IPC.
  'commands',
];

/** Package-prefix matches (entire import specifier must start with one). */
const FORBIDDEN_PACKAGE_PREFIXES = ['@tauri-apps/'];

function isForbidden(specifier: string): string | null {
  for (const prefix of FORBIDDEN_PACKAGE_PREFIXES) {
    if (specifier.startsWith(prefix)) return prefix;
  }
  for (const basename of FORBIDDEN_MODULE_BASENAMES) {
    // Match `<basename>` as the trailing segment of the path.
    const re = new RegExp(`(?:^|/)${basename}$`);
    if (re.test(specifier)) return basename;
  }
  return null;
}

describe('documentStore.ts is origin-blind', () => {
  const source = readFileSync(DOCUMENT_STORE_PATH, 'utf-8');

  // Match all `import ... from '<path>'` statements (covers
  // side-effect, default, named, and namespace forms; ignores
  // dynamic `import(...)` calls — see separate assertion below).
  const importRegex = /^import\s[^;]*?from\s+['"]([^'"]+)['"]/gm;
  const importSpecifiers: string[] = [];
  for (const match of source.matchAll(importRegex)) {
    importSpecifiers.push(match[1]!);
  }

  it('has at least one import (smoke check for the regex)', () => {
    expect(importSpecifiers.length).toBeGreaterThan(0);
  });

  it('forbids all relay/auth/sync/tauri imports', () => {
    const offending = importSpecifiers
      .map((spec) => ({ spec, match: isForbidden(spec) }))
      .filter((entry) => entry.match !== null);
    expect(offending).toEqual([]);
  });

  it('also forbids dynamic imports of the same modules', () => {
    // Catches `await import('../api/relayClient')` or any `import(...)`
    // lazy-load shortcut sneaking the dependency back in.
    const dynamicImportRegex = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    const dynamicSpecifiers: string[] = [];
    for (const match of source.matchAll(dynamicImportRegex)) {
      dynamicSpecifiers.push(match[1]!);
    }

    const offending = dynamicSpecifiers
      .map((spec) => ({ spec, match: isForbidden(spec) }))
      .filter((entry) => entry.match !== null);
    expect(offending).toEqual([]);
  });

  // Self-test: the `isForbidden` helper would actually catch a
  // regression. Demonstrates that future maintainers don't need to
  // trust the regex blindly.
  describe('isForbidden self-test', () => {
    const positives: Array<[string, string]> = [
      ['./connectionStore', 'connectionStore'],
      ['../api/relayClient', 'relayClient'],
      ['../collaboration/UnifiedSyncProvider', 'UnifiedSyncProvider'],
      ['../tauri/commands', 'commands'],
      ['@tauri-apps/plugin-fs', '@tauri-apps/'],
    ];

    for (const [spec, expectedMatch] of positives) {
      it(`flags ${spec}`, () => {
        expect(isForbidden(spec)).toBe(expectedMatch);
      });
    }

    const negatives = [
      './documentStore',
      './historyStore',
      '../shapes/Shape',
      'zustand',
      'zustand/middleware/immer',
      './connectionStoreView', // basename anchor — not a match
    ];

    for (const spec of negatives) {
      it(`does not flag ${spec}`, () => {
        expect(isForbidden(spec)).toBeNull();
      });
    }
  });
});
