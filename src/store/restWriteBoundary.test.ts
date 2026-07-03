/**
 * REST-bound document-body write boundary (JP-423).
 *
 * Every document body that leaves for the relay over REST — a live save or a
 * queued replay — must pass through `serializeDocForRest` (the withhold of
 * pending-sync prose + future sanitization). That function is applied inside
 * the two deep seams (`relayDocumentStore.saveToHost` at the wire,
 * `SyncStateManager.queueSave` at enqueue), so the invariant holds for every
 * caller OF those seams — what's left to police is the caller set itself:
 * a new module pushing bodies at the relay is a new integration surface and
 * must be a deliberate, reviewed decision.
 *
 * If this fails: do NOT add your file to the allowlist to make it pass. Route
 * the save through `persistenceStore.pushRelaySaveOrQueue` (or the seams'
 * existing callers). A path that genuinely cannot must still send
 * `serializeDocForRest(doc)` and be allowlisted here with a WHY.
 *
 * Detection modeled on `proseWriteBoundary.test.ts`: the dot-call forms
 * `.saveToHost(` / `.queueSave(` / `.enqueueSave(` — interface/method
 * declarations don't match, `getState().`/`this.deps.`/variable-held forms do.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(__dirname, '..');

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

/** REST-push vectors: live wire save, queue-for-replay, raw queue append. */
const REST_WRITE_RE = /\.(?:saveToHost|queueSave|enqueueSave)\s*\(/g;

/**
 * Modules permitted to push document bodies at the REST seams, each with WHY.
 * Keep it small — every entry is a surface `serializeDocForRest` must cover.
 */
const ALLOWLIST = new Set<string>([
  'store/persistenceStore.ts', // pushRelaySaveOrQueue + versioned direct saves + reattach/on-connect queueing
  'collaboration/SyncStateManager.ts', // defines queueSave (applies serializeDocForRest), wraps enqueueSave
  'collaboration/OfflineQueue.ts', // defines the queue; only doc-comment usage examples match
  'ui/App.tsx', // wires the transfer-service + conflict-resolution deps to relayDocumentStore.saveToHost
  'services/DocumentTransferService.ts', // pushes via its injected saveToHost dep (wired in App.tsx)
]);

describe('REST-bound body write boundary (JP-423)', () => {
  const files = listSourceFiles(SRC_ROOT);

  it('smoke: found a representative number of source files', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('only allowlisted modules push document bodies at the REST seams', () => {
    const offenders: Array<{ file: string; match: string }> = [];
    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split(sep).join('/');
      if (ALLOWLIST.has(rel)) continue;
      const source = readFileSync(file, 'utf-8');
      for (const m of source.matchAll(REST_WRITE_RE)) {
        offenders.push({ file: rel, match: m[0] });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('smoke: the allowlisted writers actually match (regex works)', () => {
    const writers = [...ALLOWLIST].filter((rel) => {
      const source = readFileSync(resolve(SRC_ROOT, rel), 'utf-8');
      REST_WRITE_RE.lastIndex = 0;
      return REST_WRITE_RE.test(source);
    });
    // Near-empty means the detection regex silently stopped working.
    expect(writers.length).toBeGreaterThanOrEqual(4);
  });
});
