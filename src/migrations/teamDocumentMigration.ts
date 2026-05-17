/**
 * First-launch team-document migration (Phase 20.3 Slice F).
 *
 * Beta builds wrote team documents (the precursor to "relay
 * documents") into `<app-data-dir>/team_documents/<id>.json` via the
 * Tauri host. The v2 desktop is a pure relay client and no longer
 * has a local team-documents store — but a returning user's docs are
 * still sitting on disk waiting to be rescued.
 *
 * This migration runs once at boot, in Tauri only:
 *   1. Reads every `*.json` in `<app-data-dir>/team_documents/`.
 *   2. Parses each as a `DiagramDocument`, strips the
 *      `isRelayDocument` flag (the doc becomes purely local), writes
 *      it through the renderer's persistence path so it shows up
 *      alongside other local docs.
 *   3. Moves the source file into
 *      `<app-data-dir>/_archived_team_documents/` (rename, never
 *      delete — preserves a recovery path for paranoid users).
 *   4. Fires a one-time toast.
 *   5. Records `diagrammer-team-doc-migration-done: '1'` in
 *      localStorage so re-runs are no-ops.
 *
 * Outside Tauri (web build) or on subsequent launches the function
 * is a near-no-op (sets the flag once and returns).
 */

import type { DiagramDocument } from '../types/Document';

const MIGRATION_FLAG_KEY = 'diagrammer-team-doc-migration-done';
const TEAM_DOCS_DIR = 'team_documents';
// Beta builds nested the actual `.json` docs one level deeper. The parent
// `team_documents/` directory holds `index.json`, a `blobs/` dir, and a
// `docs/` dir — the latter is where each document file lives.
const TEAM_DOCS_SUBDIR = 'docs';
const ARCHIVE_DIR = '_archived_team_documents';

/**
 * Minimal filesystem surface this migration needs. Real Tauri uses
 * `@tauri-apps/plugin-fs` + the app-data-dir from `@tauri-apps/api/path`.
 * Tests inject a memory-backed implementation.
 */
export interface MigrationFs {
  /** Absolute path to the app's per-user data dir. */
  appDataDir(): Promise<string>;
  /** True if the directory exists. */
  dirExists(path: string): Promise<boolean>;
  /** Create `path` (and any missing parent dirs). */
  mkdirRecursive(path: string): Promise<void>;
  /** Return the names of all entries directly under `path`. */
  readDir(path: string): Promise<string[]>;
  /** Read a file as a UTF-8 string. */
  readTextFile(path: string): Promise<string>;
  /** Move `from` → `to`. Same volume; no copy semantics required. */
  rename(from: string, to: string): Promise<void>;
}

/**
 * Callback for surfacing the post-migration toast. Decoupled so the
 * migration module doesn't import `notificationStore` (and the test
 * can capture without a store dance).
 */
export type MigrationNotifier = (message: string) => void;

/**
 * Save the converted document into localStorage and register it in
 * the persistence index. Decoupled the same way as the notifier so
 * tests can capture without bootstrapping the full store.
 */
export type DocumentSaver = (doc: DiagramDocument) => void;

export interface MigrationResult {
  /** Whether migration actually ran (false when flag was already set or not in Tauri). */
  ran: boolean;
  /** Number of documents migrated. Always 0 when `ran` is false. */
  migratedCount: number;
  /** Number of files skipped due to parse/save errors. */
  failedCount: number;
}

/** Slash-join a directory and a child name without `path` dependency. */
function join(dir: string, child: string): string {
  return dir.endsWith('/') || dir.endsWith('\\') ? `${dir}${child}` : `${dir}/${child}`;
}

/**
 * Core migration logic. Pure given its dependencies — no Tauri or
 * localStorage references beyond the flag itself. The thin Tauri
 * wrapper lives in `runTeamDocumentMigration`.
 */
export async function migrateTeamDocuments(
  fs: MigrationFs,
  saveDocument: DocumentSaver,
  notify: MigrationNotifier,
): Promise<MigrationResult> {
  if (typeof localStorage !== 'undefined' && localStorage.getItem(MIGRATION_FLAG_KEY) === '1') {
    return { ran: false, migratedCount: 0, failedCount: 0 };
  }

  const appData = await fs.appDataDir();
  const teamDir = join(appData, TEAM_DOCS_DIR);
  const docsSubDir = join(teamDir, TEAM_DOCS_SUBDIR);
  // Prefer the nested `team_documents/docs/` layout (used by released
  // beta builds). Fall back to the flat layout for older dev installs
  // that wrote `*.json` directly under `team_documents/`.
  const sourceDir = (await fs.dirExists(docsSubDir)) ? docsSubDir : teamDir;
  const archiveDir = join(appData, ARCHIVE_DIR);

  if (!(await fs.dirExists(sourceDir))) {
    setFlag();
    return { ran: false, migratedCount: 0, failedCount: 0 };
  }

  const entries = await fs.readDir(sourceDir);
  const jsonFiles = entries.filter((name) => {
    const lower = name.toLowerCase();
    if (!lower.endsWith('.json')) return false;
    // `index.json` is the host's manifest, not a document.
    if (lower === 'index.json') return false;
    return true;
  });

  if (jsonFiles.length === 0) {
    setFlag();
    return { ran: false, migratedCount: 0, failedCount: 0 };
  }

  await fs.mkdirRecursive(archiveDir);

  let migratedCount = 0;
  let failedCount = 0;

  for (const fileName of jsonFiles) {
    const sourcePath = join(sourceDir, fileName);
    try {
      const raw = await fs.readTextFile(sourcePath);
      const parsed = JSON.parse(raw) as Partial<DiagramDocument> & Record<string, unknown>;
      if (typeof parsed.id !== 'string' || typeof parsed.name !== 'string') {
        throw new Error('missing required `id` / `name` fields');
      }

      // Strip relay-document flags + relay-only metadata so the doc
      // looks like a local doc to the rest of the renderer.
      const doc = { ...parsed } as DiagramDocument & Record<string, unknown>;
      delete (doc as Record<string, unknown>)['isRelayDocument'];
      delete (doc as Record<string, unknown>)['isTeamDocument'];
      delete (doc as Record<string, unknown>)['serverVersion'];
      delete (doc as Record<string, unknown>)['lockedBy'];
      delete (doc as Record<string, unknown>)['lockedByName'];
      delete (doc as Record<string, unknown>)['lockedAt'];
      delete (doc as Record<string, unknown>)['sharedWith'];
      doc.modifiedAt = Date.now();

      saveDocument(doc as DiagramDocument);

      await fs.rename(sourcePath, join(archiveDir, fileName));
      migratedCount++;
    } catch (err) {
      console.error('[teamDocMigration] Failed to migrate', fileName, err);
      failedCount++;
    }
  }

  setFlag();

  if (migratedCount > 0) {
    notify(
      `${migratedCount} team document${migratedCount === 1 ? '' : 's'} were converted to local documents. ` +
        'To collaborate on them again, upload them to a relay from Settings → Documents.',
    );
  }

  return { ran: true, migratedCount, failedCount };
}

function setFlag(): void {
  try {
    localStorage.setItem(MIGRATION_FLAG_KEY, '1');
  } catch {
    /* ignore — quota errors mean we just re-run next launch */
  }
}

/**
 * Production entry point. Wires the migration to Tauri's fs plugin
 * + path helpers, the persistence store's local save path, and the
 * notification store. Safe to call unconditionally — exits early
 * outside Tauri or on subsequent launches.
 */
export async function runTeamDocumentMigration(): Promise<MigrationResult> {
  const { isTauri } = await import('../tauri/commands');
  if (!isTauri()) {
    setFlag();
    return { ran: false, migratedCount: 0, failedCount: 0 };
  }

  const fs = await import('@tauri-apps/plugin-fs');
  const { appDataDir } = await import('@tauri-apps/api/path');

  const adapter: MigrationFs = {
    appDataDir,
    dirExists: (path) => fs.exists(path),
    mkdirRecursive: async (path) => {
      if (!(await fs.exists(path))) {
        await fs.mkdir(path, { recursive: true });
      }
    },
    readDir: async (path) => {
      const entries = await fs.readDir(path);
      return entries.map((e) => e.name);
    },
    readTextFile: (path) => fs.readTextFile(path),
    rename: (from, to) => fs.rename(from, to),
  };

  const { usePersistenceStore } = await import('../store/persistenceStore');
  const { saveDocumentToStorage, registerLocalDocument } = await import('./teamDocumentMigrationHelpers');

  const saveDocument: DocumentSaver = (doc) => {
    saveDocumentToStorage(doc);
    registerLocalDocument(usePersistenceStore, doc);
  };

  const { useNotificationStore } = await import('../store/notificationStore');
  const notify: MigrationNotifier = (message) => {
    useNotificationStore.getState().info(message, { category: 'permanent' });
  };

  return migrateTeamDocuments(adapter, saveDocument, notify);
}

/** Test helper — flips the flag back so unit tests can re-run. */
export function _resetMigrationFlagForTesting(): void {
  try {
    localStorage.removeItem(MIGRATION_FLAG_KEY);
  } catch {
    /* ignore */
  }
}
