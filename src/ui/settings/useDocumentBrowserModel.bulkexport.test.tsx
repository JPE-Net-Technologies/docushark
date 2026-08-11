/**
 * Bulk export (JP-480).
 *
 * There's no archive-of-archives format — each document downloads as its own
 * `.docushark` file — so selecting ten documents means ten downloads and a
 * likely browser permission prompt. That gets a warning first. And a failure
 * used to be logged to the console only, so a bulk export could quietly deliver
 * four of five files and look like it had worked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import { useDocumentBrowserModel } from './useDocumentBrowserModel';
import { useDocumentRegistry } from '../../store/documentRegistry';
import { saveDocumentToStorage } from '../../store/persistenceStore';
import { useNotificationStore } from '../../store/notificationStore';
import { useConfirmStore } from '../confirm/confirmStore';
import { exportAndDownloadDocumentArchive } from '../../storage/DocumentArchiveService';
import { getDocumentMetadata, type DiagramDocument } from '../../types/Document';

vi.mock('../../collaboration', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../collaboration')>();
  return { ...mod, purgeLocalDocRoom: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../../storage/DocumentArchiveService', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../storage/DocumentArchiveService')>();
  return { ...mod, exportAndDownloadDocumentArchive: vi.fn().mockResolvedValue(undefined) };
});

const exportMock = vi.mocked(exportAndDownloadDocumentArchive);

function seedLocalDoc(id: string, name: string): void {
  const doc = {
    id,
    name,
    pages: {},
    pageOrder: [],
    activePageId: '',
    createdAt: 1,
    modifiedAt: 1,
    version: 2,
  } as unknown as DiagramDocument;
  saveDocumentToStorage(doc);
  useDocumentRegistry.getState().registerLocal(getDocumentMetadata(doc));
}

const toasts = () => useNotificationStore.getState().notifications;
const dialog = () => useConfirmStore.getState().current;

describe('useDocumentBrowserModel — bulk export', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    useDocumentRegistry.setState({ entries: {} });
    useNotificationStore.getState().dismissAll();
    useConfirmStore.setState({ current: null, queue: [] });
    exportMock.mockReset();
    exportMock.mockResolvedValue(undefined);
  });

  async function selectAllOf(ids: string[]) {
    for (const [i, id] of ids.entries()) seedLocalDoc(id, `Doc ${i + 1}`);
    const { result } = renderHook(() => useDocumentBrowserModel());
    await waitFor(() => expect(result.current.documentList.length).toBe(ids.length));
    act(() => result.current.handleSelectAll());
    return result;
  }

  it('warns before exporting more than one document, naming the count', async () => {
    const result = await selectAllOf(['a', 'b', 'c']);

    let pending: Promise<void>;
    act(() => {
      pending = result.current.handleBulkExport();
    });

    await waitFor(() => expect(dialog()).not.toBeNull());
    const request = dialog();
    // Narrow off the confirm|prompt union so `details` is reachable.
    expect(request?.kind).toBe('confirm');
    if (request?.kind !== 'confirm') throw new Error('expected a confirm dialog');
    expect(request.title).toContain('3');
    // The warning has to say WHY it's warning: separate files, one download each.
    expect(request.message).toMatch(/own \.docushark file/i);
    expect(request.message).toContain('3 downloads');
    expect(request.details).toMatch(/multiple files/i);

    act(() => useConfirmStore.getState()._resolve(true));
    await act(async () => {
      await pending!;
    });
    expect(exportMock).toHaveBeenCalledTimes(3);
  });

  it('exports nothing when the warning is dismissed', async () => {
    const result = await selectAllOf(['a', 'b']);

    let pending: Promise<void>;
    act(() => {
      pending = result.current.handleBulkExport();
    });
    await waitFor(() => expect(dialog()).not.toBeNull());
    act(() => useConfirmStore.getState()._resolve(false));
    await act(async () => {
      await pending!;
    });

    expect(exportMock).not.toHaveBeenCalled();
  });

  it('does not warn for a single document — one file is what Export obviously does', async () => {
    const result = await selectAllOf(['a']);

    await act(async () => {
      await result.current.handleBulkExport();
    });

    expect(dialog()).toBeNull();
    expect(exportMock).toHaveBeenCalledTimes(1);
  });

  it('does nothing at all with an empty selection', async () => {
    const { result } = renderHook(() => useDocumentBrowserModel());
    await act(async () => {
      await result.current.handleBulkExport();
    });
    expect(dialog()).toBeNull();
    expect(exportMock).not.toHaveBeenCalled();
    expect(toasts()).toHaveLength(0);
  });

  it('reports a partial failure instead of looking successful', async () => {
    const result = await selectAllOf(['a', 'b', 'c']);
    exportMock.mockResolvedValueOnce(undefined);
    exportMock.mockRejectedValueOnce(new Error('disk full'));
    exportMock.mockResolvedValueOnce(undefined);

    let pending: Promise<void>;
    act(() => {
      pending = result.current.handleBulkExport();
    });
    await waitFor(() => expect(dialog()).not.toBeNull());
    act(() => useConfirmStore.getState()._resolve(true));
    await act(async () => {
      await pending!;
    });

    const warned = toasts().find((n) => n.severity === 'warning');
    expect(warned?.message).toContain('2 of 3');
    expect(warned?.message).toContain('1 failed');
  });

  it('reports a total failure as an error', async () => {
    const result = await selectAllOf(['a', 'b']);
    exportMock.mockRejectedValue(new Error('nope'));

    let pending: Promise<void>;
    act(() => {
      pending = result.current.handleBulkExport();
    });
    await waitFor(() => expect(dialog()).not.toBeNull());
    act(() => useConfirmStore.getState()._resolve(true));
    await act(async () => {
      await pending!;
    });

    expect(toasts().find((n) => n.severity === 'error')).toBeTruthy();
  });

  it('confirms success for a multi-file export', async () => {
    const result = await selectAllOf(['a', 'b']);

    let pending: Promise<void>;
    act(() => {
      pending = result.current.handleBulkExport();
    });
    await waitFor(() => expect(dialog()).not.toBeNull());
    act(() => useConfirmStore.getState()._resolve(true));
    await act(async () => {
      await pending!;
    });

    expect(toasts().find((n) => n.severity === 'success')?.message).toContain('2 documents');
  });

  it('stays quiet after a successful single export', async () => {
    // One file, one download, no surprise — a toast here would be noise.
    const result = await selectAllOf(['a']);
    await act(async () => {
      await result.current.handleBulkExport();
    });
    expect(toasts()).toHaveLength(0);
  });
});
