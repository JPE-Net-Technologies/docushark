/**
 * Sharing from the editor (DSK-257): when the open document can be shared with
 * people, and what each Share command does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConnectionStore } from '../store/connectionStore';
import { useDocumentRegistry } from '../store/documentRegistry';
import { usePersistenceStore } from '../store/persistenceStore';
import { useUserStore } from '../store/userStore';
import type { DocumentRecord } from '../types/DocumentRegistry';
import { useAccessPanelStore } from '../ui/access/accessPanelStore';
import { currentShareActions, downloadCopy, SHARE_BLOCK_REASONS, shareBlock } from './shareActions';

const download = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../storage/DocumentArchiveService', () => ({ exportAndDownloadDocumentArchive: download }));

const DOC = 'doc-1';

function open(record: Partial<DocumentRecord> | null): void {
  useDocumentRegistry.setState({
    activeDocumentId: record ? DOC : null,
    entries: record ? { [DOC]: { record: { id: DOC, name: 'Report', ...record } as DocumentRecord, isLoading: false } } : {},
  });
  usePersistenceStore.setState({ currentDocumentId: record ? DOC : null });
}

function signIn(role: string | null): void {
  useConnectionStore.setState({ token: role ? 'token' : null, tokenExpiresAt: null });
  useUserStore.setState({ currentUser: role ? ({ id: 'me', role } as never) : null });
}

beforeEach(() => {
  download.mockClear();
  useAccessPanelStore.setState({ isOpen: false, documentId: null, focus: null });
});
afterEach(() => {
  open(null);
  signIn(null);
});

describe('shareBlock', () => {
  it('lets the owner of a workspace document share it', () => {
    open({ type: 'remote', permission: 'owner' });
    signIn('member');
    expect(shareBlock()).toBeNull();
  });

  it('lets a workspace owner share any workspace document', () => {
    open({ type: 'remote', permission: 'editor' });
    signIn('owner');
    expect(shareBlock()).toBeNull();
  });

  it('says why a document can’t be shared', () => {
    open({ type: 'local' });
    signIn('member');
    expect(shareBlock()).toBe('local');
    open({ type: 'remote', permission: 'editor' });
    expect(shareBlock()).toBe('notOwner');
    open({ type: 'cached', permission: 'owner' });
    expect(shareBlock()).toBe('offline');
    open({ type: 'remote', permission: 'owner' });
    signIn(null);
    expect(shareBlock()).toBe('signedOut');
    open(null);
    expect(shareBlock()).toBe('noDocument');
  });

  it('has a reason for every block', () => {
    for (const reason of Object.values(SHARE_BLOCK_REASONS)) expect(reason.length).toBeGreaterThan(0);
  });
});

describe('the Share commands', () => {
  const command = (id: string) => currentShareActions().find((c) => c.id === id)!;

  it('are offered in the palette, the Tools grid and the Share menu', () => {
    for (const c of currentShareActions()) {
      expect(c.category).toBe('Share');
      expect(c.surfaces).toEqual(['palette', 'tools', 'shareMenu']);
      expect(c.icon).toBeTruthy();
    }
  });

  it('open the access panel for this document, at publishing for a link', () => {
    open({ type: 'remote', permission: 'owner' });
    signIn('member');
    expect(command('share.people').canExecute!()).toBe(true);
    command('share.people').execute();
    expect(useAccessPanelStore.getState()).toMatchObject({ isOpen: true, scope: 'document', documentId: DOC, focus: null });
    command('share.publish').execute();
    expect(useAccessPanelStore.getState()).toMatchObject({ isOpen: true, documentId: DOC, focus: 'publish' });
  });

  it('can’t share a document that is only on this device', () => {
    open({ type: 'local' });
    signIn('member');
    expect(command('share.people').canExecute!()).toBe(false);
    expect(command('share.publish').canExecute!()).toBe(false);
    expect(command('share.downloadCopy').canExecute!()).toBe(true);
  });

  it('don’t offer a copy of a published document to a guest reading it', async () => {
    // A guest's snapshot is never stored on the device, and its owner
    // published a view of it, not its source.
    open({ type: 'external', source: 'share-link' });
    expect(command('share.downloadCopy').canExecute!()).toBe(false);
    await downloadCopy();
    expect(download).not.toHaveBeenCalled();
  });

  it('saves the document before downloading a copy', async () => {
    open({ type: 'local' });
    const save = vi.fn();
    usePersistenceStore.setState({ saveDocument: save });
    await downloadCopy();
    expect(save).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledWith(DOC);
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(download.mock.invocationCallOrder[0]!);
  });
});
