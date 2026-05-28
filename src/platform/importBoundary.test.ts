/**
 * Platform import-boundary invariant (JP-76 acceptance gate; Final OSS App
 * Design §11.1).
 *
 * The shared React engine must compile into both the Tauri desktop shell and
 * the PWA bundle without `@tauri-apps/*` leaking into the web build. The
 * mechanism is: only `src/platform/` imports `@tauri-apps/*`, and those Tauri
 * implementation modules are reached through `__IS_TAURI__`-gated dynamic
 * imports so the web build tree-shakes them out entirely.
 *
 * This test enforces the first half — no `@tauri-apps` import (static or
 * dynamic) anywhere under `src/` except `src/platform/`. If a future change
 * genuinely needs a Tauri API in some other module, the right move is to add
 * a capability to the platform layer, not to relax this guard.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(__dirname, '..');
const PLATFORM_DIR = resolve(SRC_ROOT, 'platform');

/** Recursively collect non-test `.ts`/`.tsx` files under `dir`. */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Matches `from '@tauri-apps/…'` and `import('@tauri-apps/…')` specifiers. */
const TAURI_IMPORT_RE = /(?:from\s+|import\s*\(\s*)['"](@tauri-apps\/[^'"]+)['"]/g;

describe('@tauri-apps imports are confined to src/platform/', () => {
  const files = listSourceFiles(SRC_ROOT);

  it('found a representative number of source files (smoke check)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('no module outside src/platform/ imports @tauri-apps/*', () => {
    const offenders: Array<{ file: string; specifier: string }> = [];
    for (const file of files) {
      if (file === PLATFORM_DIR || file.startsWith(PLATFORM_DIR + sep)) continue;
      const source = readFileSync(file, 'utf-8');
      for (const match of source.matchAll(TAURI_IMPORT_RE)) {
        offenders.push({ file: relative(SRC_ROOT, file), specifier: match[1]! });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('src/platform/ does contain the Tauri impls (smoke check the regex works)', () => {
    const platformFiles = listSourceFiles(PLATFORM_DIR);
    const withTauri = platformFiles.filter(
      (f) => [...readFileSync(f, 'utf-8').matchAll(TAURI_IMPORT_RE)].length > 0,
    );
    expect(withTauri.length).toBeGreaterThan(0);
  });
});
