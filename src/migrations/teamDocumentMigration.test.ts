import { describe, it, expect, beforeEach } from 'vitest';
import type { DiagramDocument } from '../types/Document';
import {
  migrateTeamDocuments,
  _resetMigrationFlagForTesting,
  type MigrationFs,
  type DocumentSaver,
  type MigrationNotifier,
} from './teamDocumentMigration';

const APP_DATA = '/fake/appdata';

/** In-memory fs adapter — flat map of absolute path → contents. */
class MemoryFs implements MigrationFs {
  files = new Map<string, string>();
  dirs = new Set<string>([APP_DATA]);

  async appDataDir(): Promise<string> {
    return APP_DATA;
  }

  async dirExists(path: string): Promise<boolean> {
    return this.dirs.has(path);
  }

  async mkdirRecursive(path: string): Promise<void> {
    this.dirs.add(path);
  }

  async readDir(path: string): Promise<string[]> {
    const prefix = path.endsWith('/') ? path : `${path}/`;
    const out: string[] = [];
    for (const file of this.files.keys()) {
      if (file.startsWith(prefix) && !file.slice(prefix.length).includes('/')) {
        out.push(file.slice(prefix.length));
      }
    }
    return out;
  }

  async readTextFile(path: string): Promise<string> {
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`not found: ${path}`);
    return v;
  }

  async rename(from: string, to: string): Promise<void> {
    const v = this.files.get(from);
    if (v === undefined) throw new Error(`not found: ${from}`);
    this.files.delete(from);
    this.files.set(to, v);
  }

  /** Convenience: seed a team document at the conventional path. */
  seedTeamDoc(name: string, doc: object): void {
    const dir = `${APP_DATA}/team_documents`;
    this.dirs.add(dir);
    this.files.set(`${dir}/${name}`, JSON.stringify(doc));
  }
}

function makeDoc(id: string, overrides: Partial<DiagramDocument> = {}): DiagramDocument {
  return {
    id,
    name: `Doc ${id}`,
    createdAt: 1_000,
    modifiedAt: 2_000,
    pages: [],
    shapes: {},
    shapeOrder: [],
    connections: {},
    currentPageId: 'page-1',
    isRelayDocument: true,
    serverVersion: 7,
    sharedWith: [{ userId: 'u-2', userName: 'Alice', permission: 'editor' }],
    ownerId: 'u-1',
    ownerName: 'Bob',
    ...overrides,
  } as unknown as DiagramDocument;
}

describe('migrateTeamDocuments', () => {
  let fs: MemoryFs;
  let saved: DiagramDocument[];
  let notifications: string[];
  let saveDocument: DocumentSaver;
  let notify: MigrationNotifier;

  beforeEach(() => {
    _resetMigrationFlagForTesting();
    fs = new MemoryFs();
    saved = [];
    notifications = [];
    saveDocument = (doc) => {
      saved.push(doc);
    };
    notify = (msg) => {
      notifications.push(msg);
    };
  });

  it('is a no-op when the team_documents dir does not exist', async () => {
    const result = await migrateTeamDocuments(fs, saveDocument, notify);
    expect(result).toEqual({ ran: false, migratedCount: 0, failedCount: 0 });
    expect(saved).toHaveLength(0);
    expect(notifications).toHaveLength(0);
    expect(localStorage.getItem('docushark-team-doc-migration-done')).toBe('1');
  });

  it('is a no-op when the team_documents dir is empty', async () => {
    fs.dirs.add(`${APP_DATA}/team_documents`);
    const result = await migrateTeamDocuments(fs, saveDocument, notify);
    expect(result).toEqual({ ran: false, migratedCount: 0, failedCount: 0 });
    expect(saved).toHaveLength(0);
    expect(localStorage.getItem('docushark-team-doc-migration-done')).toBe('1');
  });

  it('migrates each team doc into a local doc and archives the source', async () => {
    fs.seedTeamDoc('doc-1.json', makeDoc('doc-1'));
    fs.seedTeamDoc('doc-2.json', makeDoc('doc-2', { name: 'Second' }));

    const result = await migrateTeamDocuments(fs, saveDocument, notify);

    expect(result).toEqual({ ran: true, migratedCount: 2, failedCount: 0 });
    expect(saved).toHaveLength(2);
    expect(saved.map((d) => d.id).sort()).toEqual(['doc-1', 'doc-2']);

    // Sources moved into archive.
    expect(fs.files.has(`${APP_DATA}/team_documents/doc-1.json`)).toBe(false);
    expect(fs.files.has(`${APP_DATA}/team_documents/doc-2.json`)).toBe(false);
    expect(fs.files.has(`${APP_DATA}/_archived_team_documents/doc-1.json`)).toBe(true);
    expect(fs.files.has(`${APP_DATA}/_archived_team_documents/doc-2.json`)).toBe(true);
  });

  it('strips relay-only fields from each migrated doc', async () => {
    fs.seedTeamDoc('doc-1.json', makeDoc('doc-1'));

    await migrateTeamDocuments(fs, saveDocument, notify);

    const doc = saved[0] as DiagramDocument & Record<string, unknown>;
    expect(doc.isRelayDocument).toBeUndefined();
    expect(doc['isTeamDocument']).toBeUndefined();
    expect(doc['serverVersion']).toBeUndefined();
    expect(doc['sharedWith']).toBeUndefined();
    expect(doc['lockedBy']).toBeUndefined();
    // Identity + content preserved.
    expect(doc.id).toBe('doc-1');
    expect(doc.name).toBe('Doc doc-1');
  });

  it('fires a single notification with the migrated count', async () => {
    fs.seedTeamDoc('doc-1.json', makeDoc('doc-1'));
    fs.seedTeamDoc('doc-2.json', makeDoc('doc-2'));
    fs.seedTeamDoc('doc-3.json', makeDoc('doc-3'));

    await migrateTeamDocuments(fs, saveDocument, notify);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain('3 team documents');
    expect(notifications[0]).toContain('Settings → Documents');
  });

  it('does not fire a notification when nothing was migrated', async () => {
    fs.dirs.add(`${APP_DATA}/team_documents`);
    await migrateTeamDocuments(fs, saveDocument, notify);
    expect(notifications).toHaveLength(0);
  });

  it('skips malformed files but continues with the rest', async () => {
    fs.seedTeamDoc('good.json', makeDoc('good'));
    // Malformed: missing required fields.
    fs.files.set(`${APP_DATA}/team_documents/bad.json`, JSON.stringify({ foo: 'bar' }));
    // Malformed: invalid JSON.
    fs.files.set(`${APP_DATA}/team_documents/broken.json`, '{not json');

    const result = await migrateTeamDocuments(fs, saveDocument, notify);

    expect(result.migratedCount).toBe(1);
    expect(result.failedCount).toBe(2);
    expect(saved.map((d) => d.id)).toEqual(['good']);
    // Bad files left in place (not archived) so a human can inspect.
    expect(fs.files.has(`${APP_DATA}/team_documents/bad.json`)).toBe(true);
    expect(fs.files.has(`${APP_DATA}/team_documents/broken.json`)).toBe(true);
    expect(fs.files.has(`${APP_DATA}/_archived_team_documents/good.json`)).toBe(true);
  });

  it('is idempotent — second call is a no-op even with files present', async () => {
    fs.seedTeamDoc('doc-1.json', makeDoc('doc-1'));
    await migrateTeamDocuments(fs, saveDocument, notify);

    // New file appears between calls — should be ignored on the second run
    // because the flag is set.
    fs.seedTeamDoc('doc-2.json', makeDoc('doc-2'));

    const second = await migrateTeamDocuments(fs, saveDocument, notify);
    expect(second).toEqual({ ran: false, migratedCount: 0, failedCount: 0 });
    expect(saved).toHaveLength(1);
  });

  it('ignores the host-side index.json manifest', async () => {
    fs.seedTeamDoc('doc-1.json', makeDoc('doc-1'));
    // index.json is the legacy host manifest, never a document.
    fs.files.set(
      `${APP_DATA}/team_documents/index.json`,
      JSON.stringify({ documents: ['doc-1'], version: 1 }),
    );

    const result = await migrateTeamDocuments(fs, saveDocument, notify);
    expect(result).toEqual({ ran: true, migratedCount: 1, failedCount: 0 });
    // index.json is left in place (not archived, not flagged as failed).
    expect(fs.files.has(`${APP_DATA}/team_documents/index.json`)).toBe(true);
  });

  it('ignores non-json entries in the source directory', async () => {
    fs.seedTeamDoc('doc-1.json', makeDoc('doc-1'));
    fs.dirs.add(`${APP_DATA}/team_documents`);
    fs.files.set(`${APP_DATA}/team_documents/README.txt`, 'note');
    fs.files.set(`${APP_DATA}/team_documents/.DS_Store`, '');

    const result = await migrateTeamDocuments(fs, saveDocument, notify);
    expect(result.migratedCount).toBe(1);
    // Non-json entries untouched.
    expect(fs.files.has(`${APP_DATA}/team_documents/README.txt`)).toBe(true);
    expect(fs.files.has(`${APP_DATA}/team_documents/.DS_Store`)).toBe(true);
  });
});
