/**
 * Where New creates the document (DSK-195).
 *
 * New used to create a local document every time, even while browsing a
 * workspace. Making it collaborative took a second step (move it to the
 * workspace), which the founder called "a HUGE annoyance". New now creates
 * where you are working, and a local document stays an explicit choice.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';

const h = vi.hoisted(() => ({ signedIn: true, usable: true }));

vi.mock('../../store/relayDocumentStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../store/relayDocumentStore')>();
  return { ...mod, useIsCloudSignedIn: () => h.signedIn };
});
vi.mock('../../store/connectionStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../store/connectionStore')>();
  return { ...mod, useRelaySessionUsable: () => h.usable };
});

import { useDocumentBrowserModel } from './useDocumentBrowserModel';
import { usePersistenceStore } from '../../store/persistenceStore';
import { useNotificationStore } from '../../store/notificationStore';

type NewWorkspaceResult = Awaited<ReturnType<ReturnType<typeof usePersistenceStore.getState>['newWorkspaceDocument']>>;

const realNewDocument = usePersistenceStore.getState().newDocument;
const realNewWorkspaceDocument = usePersistenceStore.getState().newWorkspaceDocument;

function toastMessages(): string[] {
  return useNotificationStore.getState().notifications.map((n) => n.message);
}

describe('New in the document browser (DSK-195)', () => {
  let newDocument: Mock<[name?: string], void>;
  let newWorkspaceDocument: Mock<[], Promise<NewWorkspaceResult>>;

  beforeEach(() => {
    cleanup();
    h.signedIn = true;
    h.usable = true;
    useNotificationStore.getState().dismissAll();
    newDocument = vi.fn<[name?: string], void>();
    newWorkspaceDocument = vi.fn<[], Promise<NewWorkspaceResult>>().mockResolvedValue({ ok: true, docId: 'doc-new' });
    usePersistenceStore.setState({ newDocument, newWorkspaceDocument });
    return () => {
      usePersistenceStore.setState({ newDocument: realNewDocument, newWorkspaceDocument: realNewWorkspaceDocument });
    };
  });

  it('creates a workspace document when signed in with a usable session', () => {
    const { result } = renderHook(() => useDocumentBrowserModel());
    expect(result.current.newDocumentTarget).toBe('workspace');

    act(() => result.current.handleNewDocument());

    expect(newWorkspaceDocument).toHaveBeenCalledTimes(1);
    expect(newDocument).not.toHaveBeenCalled();
  });

  it('creates a local document, quietly, when signed out', () => {
    h.signedIn = false;
    const { result } = renderHook(() => useDocumentBrowserModel());
    expect(result.current.newDocumentTarget).toBe('local');

    act(() => result.current.handleNewDocument());

    expect(newDocument).toHaveBeenCalledTimes(1);
    expect(newWorkspaceDocument).not.toHaveBeenCalled();
    expect(toastMessages()).toEqual([]);
  });

  it('creates a local document when offline, and says so', async () => {
    h.usable = false;
    const { result } = renderHook(() => useDocumentBrowserModel());

    act(() => result.current.handleNewDocument());

    expect(newDocument).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(toastMessages().some((m) => /offline, so this is a local document/.test(m))).toBe(true));
  });

  it('respects the Local filter', () => {
    const { result } = renderHook(() => useDocumentBrowserModel());
    act(() => result.current.setFilterMode('local'));
    expect(result.current.newDocumentTarget).toBe('local');

    act(() => result.current.handleNewDocument());

    expect(newDocument).toHaveBeenCalledTimes(1);
    expect(newWorkspaceDocument).not.toHaveBeenCalled();
  });

  it('says what happened when the workspace refuses the new document', async () => {
    newWorkspaceDocument.mockResolvedValue({ ok: false, error: 'Relay unreachable' });
    const { result } = renderHook(() => useDocumentBrowserModel());

    act(() => result.current.handleNewDocument());

    await waitFor(() =>
      expect(toastMessages().some((m) => m.includes('Relay unreachable') && m.includes('open as a local document'))).toBe(
        true,
      ),
    );
  });

  it("creates in the workspace from the menu's explicit choice, even with the Local filter on", () => {
    const { result } = renderHook(() => useDocumentBrowserModel());
    act(() => result.current.setFilterMode('local'));
    expect(result.current.canCreateInWorkspace).toBe(true);

    act(() => result.current.handleNewWorkspaceDocument());

    expect(newWorkspaceDocument).toHaveBeenCalledTimes(1);
    expect(newDocument).not.toHaveBeenCalled();
  });

  it('offers no workspace choice when signed out', () => {
    h.signedIn = false;
    const { result } = renderHook(() => useDocumentBrowserModel());
    expect(result.current.canCreateInWorkspace).toBe(false);

    act(() => result.current.handleNewWorkspaceDocument());

    expect(newWorkspaceDocument).not.toHaveBeenCalled();
  });

  it('always creates a local document from the explicit local action', () => {
    const { result } = renderHook(() => useDocumentBrowserModel());

    act(() => result.current.handleNewLocalDocument());

    expect(newDocument).toHaveBeenCalledTimes(1);
    expect(newWorkspaceDocument).not.toHaveBeenCalled();
  });
});
