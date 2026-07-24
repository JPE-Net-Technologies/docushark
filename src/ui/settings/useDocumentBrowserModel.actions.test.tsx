/**
 * Hook-level coverage for the JP-385 delete + rename policy in
 * useDocumentBrowserModel, against real stores:
 *
 * - Local soft delete is one click — no confirm dialog, an Undo toast.
 * - Workspace (remote) delete keeps a styled danger confirm (it affects every
 *   member and Undo can't round-trip), and only deletes on OK.
 * - Rename of a NON-open document routes through renameDocumentById
 *   (previously a silent no-op) and surfaces failures as an error toast.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import { useDocumentBrowserModel } from './useDocumentBrowserModel';
import { useDocumentRegistry } from '../../store/documentRegistry';
import { usePersistenceStore, saveDocumentToStorage } from '../../store/persistenceStore';
import { useRelayDocumentStore } from '../../store/relayDocumentStore';
import { useNotificationStore } from '../../store/notificationStore';
import { useConfirmStore } from '../confirm/confirmStore';
import { getDocumentMetadata, type DiagramDocument } from '../../types/Document';

// The delete path purges the doc's local CRDT room (y-indexeddb) — not
// available under jsdom, so stub just that export.
vi.mock('../../collaboration', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../collaboration')>();
  return { ...mod, purgeLocalDocRoom: vi.fn().mockResolvedValue(undefined) };
});

function makeDoc(id: string, name: string, tags?: string[]): DiagramDocument {
  return {
    id,
    name,
    pages: {},
    pageOrder: [],
    activePageId: '',
    createdAt: 1,
    modifiedAt: 1,
    version: 2,
    ...(tags ? { tags } : {}),
  } as unknown as DiagramDocument;
}

function seedLocalDoc(id: string, name: string, tags?: string[]): void {
  const doc = makeDoc(id, name, tags);
  saveDocumentToStorage(doc);
  useDocumentRegistry.getState().registerLocal(getDocumentMetadata(doc));
}

function toastMessages() {
  return useNotificationStore.getState().notifications;
}

describe('useDocumentBrowserModel — delete + rename policy (JP-385)', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    useDocumentRegistry.setState({ entries: {} });
    useNotificationStore.getState().dismissAll();
    useConfirmStore.setState({ current: null, queue: [] });
  });

  it('soft-deletes a local doc with no confirm and an Undo toast', async () => {
    seedLocalDoc('l1', 'My Doc');
    const { result } = renderHook(() => useDocumentBrowserModel());

    await act(async () => {
      await result.current.handleDelete('l1');
    });

    // No dialog was raised…
    expect(useConfirmStore.getState().current).toBeNull();
    // …the doc left the registry…
    expect(useDocumentRegistry.getState().getRecord('l1')).toBeUndefined();
    // …and the toast carries the Undo action.
    const undoToast = toastMessages().find((n) => n.actionLabel === 'Undo');
    expect(undoToast).toBeTruthy();
    expect(undoToast?.message).toContain('Trash');
  });

  it('confirms before deleting a workspace doc, and cancels cleanly', async () => {
    const trashMock = vi.fn().mockResolvedValue(undefined);
    useRelayDocumentStore.setState({ trashRelayDocument: trashMock });
    const remoteDoc = makeDoc('r1', 'Relay Doc');
    useDocumentRegistry
      .getState()
      .registerRemote(getDocumentMetadata(remoteDoc), 'localhost:9876', 'owner');

    const { result } = renderHook(() => useDocumentBrowserModel());

    // Cancel path: the dialog appears, resolving false deletes nothing.
    let pending: Promise<void>;
    act(() => {
      pending = result.current.handleDelete('r1');
    });
    await waitFor(() => expect(useConfirmStore.getState().current?.kind).toBe('confirm'));
    act(() => useConfirmStore.getState()._resolve(false));
    await act(async () => {
      await pending;
    });
    expect(trashMock).not.toHaveBeenCalled();
    expect(useDocumentRegistry.getState().getRecord('r1')).toBeTruthy();

    // Confirm path: resolving true performs the relay delete.
    act(() => {
      pending = result.current.handleDelete('r1');
    });
    await waitFor(() => expect(useConfirmStore.getState().current?.kind).toBe('confirm'));
    act(() => useConfirmStore.getState()._resolve(true));
    await act(async () => {
      await pending;
    });
    expect(trashMock).toHaveBeenCalledWith('r1');
  });

  it('renames a NON-open doc through renameDocumentById', async () => {
    seedLocalDoc('l2', 'Old Name');
    const renameMock = vi
      .fn()
      .mockResolvedValue({ ok: true } as Awaited<
        ReturnType<ReturnType<typeof usePersistenceStore.getState>['renameDocumentById']>
      >);
    usePersistenceStore.setState({ renameDocumentById: renameMock, currentDocumentId: null });

    const { result } = renderHook(() => useDocumentBrowserModel());
    act(() => {
      result.current.handleRename('l2', 'New Name');
    });

    await waitFor(() => expect(renameMock).toHaveBeenCalledWith('l2', 'New Name'));
    expect(toastMessages().some((n) => n.severity === 'error')).toBe(false);
  });

  it('surfaces a rename failure as an error toast', async () => {
    seedLocalDoc('l3', 'Old Name');
    const renameMock = vi.fn().mockResolvedValue({ ok: false, reason: 'version-conflict' });
    usePersistenceStore.setState({ renameDocumentById: renameMock, currentDocumentId: null });

    const { result } = renderHook(() => useDocumentBrowserModel());
    act(() => {
      result.current.handleRename('l3', 'New Name');
    });

    await waitFor(() =>
      expect(toastMessages().some((n) => n.severity === 'error' && /refresh/i.test(n.message))).toBe(
        true,
      ),
    );
  });

  it('searches tags: plain query matches name OR tags, # targets tags only', async () => {
    seedLocalDoc('s1', 'Alpha Report', ['research']);
    seedLocalDoc('s2', 'research notes');
    seedLocalDoc('s3', 'Misc');
    const { result } = renderHook(() => useDocumentBrowserModel());

    act(() => result.current.setSearchQuery('research'));
    await waitFor(() =>
      expect(result.current.documentList.map((d) => d.id).sort()).toEqual(['s1', 's2']),
    );

    act(() => result.current.setSearchQuery('#research'));
    await waitFor(() =>
      expect(result.current.documentList.map((d) => d.id)).toEqual(['s1']),
    );

    // Bare '#' lists every tagged document.
    act(() => result.current.setSearchQuery('#'));
    await waitFor(() =>
      expect(result.current.documentList.map((d) => d.id)).toEqual(['s1']),
    );
  });

  it('allTags unions registry tags case-insensitively with first casing kept', async () => {
    seedLocalDoc('t1', 'One', ['Research', 'ops']);
    seedLocalDoc('t2', 'Two', ['research', 'Draft']);
    const { result } = renderHook(() => useDocumentBrowserModel());

    await waitFor(() => expect(result.current.allTags).toEqual(['Draft', 'ops', 'Research']));
  });

  it('selects every visible document with handleSelectAll', async () => {
    seedLocalDoc('a1', 'Alpha');
    seedLocalDoc('a2', 'Bravo');
    const { result } = renderHook(() => useDocumentBrowserModel());

    act(() => {
      result.current.handleSelectAll();
    });

    await waitFor(() => expect(result.current.selectedIds).toEqual(new Set(['a1', 'a2'])));
  });
});
