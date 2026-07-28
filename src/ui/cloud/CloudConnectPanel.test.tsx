/**
 * CloudConnectPanel — the sign-in state machine (JP-455).
 *
 * This component owns `phase`, drives the device-code flow, and decides when
 * the surrounding modal may be dismissed. Until this file it had **no test at
 * all**, which is how the two defects here shipped:
 *
 *  - the in-flight grant was destroyed by the panel's unmount cleanup, so an
 *    interrupted sign-in stranded an already-authorized device; and
 *  - the backdrop-dismiss guard covered only the polling window, leaving
 *    `success` and the WS connect dismissable — exactly when the signed-in view
 *    hasn't painted and a click-out looks reasonable to the user.
 *
 * The mocks follow the `vi.hoisted` + per-module `vi.mock` shape already used
 * by `src/api/restoreCloudSession.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { CloudConnectPanel } from './CloudConnectPanel';

const h = vi.hoisted(() => ({
  connState: {
    status: 'disconnected' as string,
    user: null as { id: string; username: string; role?: string } | null,
    host: null as { url: string } | null,
  },
  cloudSignedIn: false,
  beginCloudSignIn: vi.fn(),
  ensureSignInResumed: vi.fn(),
  savePendingSignIn: vi.fn(async () => {}),
  clearPendingSignIn: vi.fn(async () => {}),
  completeCloudSignIn: vi.fn(async () => {}),
  loadConnection: vi.fn(async () => null as unknown),
}));

vi.mock('../../store/connectionStore', () => ({
  useConnectionStore: Object.assign(
    (sel: (s: typeof h.connState) => unknown) => sel(h.connState),
    { getState: () => h.connState },
  ),
}));
vi.mock('../../store/relayDocumentStore', () => ({
  useIsCloudSignedIn: () => h.cloudSignedIn,
}));
vi.mock('../../collaboration', () => ({
  useCollaborationStore: (sel: (s: unknown) => unknown) =>
    sel({ error: null, stopSession: vi.fn() }),
  useIsRelaySessionLive: () => false,
}));
vi.mock('../../store/persistenceStore', () => ({
  usePersistenceStore: (sel: (s: unknown) => unknown) => sel({ currentDocumentId: null }),
}));
vi.mock('../../store/notificationStore', () => ({
  useNotificationStore: { getState: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) },
}));
vi.mock('../../services/removeWorkspace', () => ({ removeCurrentWorkspace: vi.fn() }));
vi.mock('../../api/webClient', () => ({
  // `getWorkspaceMembers` backs the signed-in identity lookup (JP-456): the
  // relay token carries only `sub`, so the display name comes from the roster.
  webClient: {
    leaveWorkspace: vi.fn(),
    getWorkspaceMembers: vi.fn(async () => []),
  },
  WebClientError: class extends Error {},
}));
vi.mock('../confirm/confirmStore', () => ({ confirmDialog: vi.fn() }));
vi.mock('../../api/relayConnection', () => ({
  loadConnection: h.loadConnection,
  clearJwt: vi.fn(),
  DEFAULT_CLOUD_BASE_URL: 'http://web',
  WORKSPACE_URL_BASE: 'space.docushark.app',
}));
vi.mock('../../api/completeCloudSignIn', () => ({ completeCloudSignIn: h.completeCloudSignIn }));
vi.mock('../../api/cloudAuth', async () => {
  const actual = await vi.importActual<typeof import('../../api/cloudAuth')>('../../api/cloudAuth');
  return { ...actual, beginCloudSignIn: h.beginCloudSignIn };
});
vi.mock('../../api/pendingSignIn', () => ({
  savePendingSignIn: h.savePendingSignIn,
  clearPendingSignIn: h.clearPendingSignIn,
}));
vi.mock('../../api/resumeInterruptedSignIn', () => ({
  ensureSignInResumed: h.ensureSignInResumed,
}));
// Child surfaces talk to the control plane; they aren't under test here.
vi.mock('./WorkspaceSwitcher', () => ({ WorkspaceSwitcher: () => null }));
vi.mock('../components/RichSelect', () => ({
  RichSelect: ({ ariaLabel }: { ariaLabel?: string }) => <button type="button">{ariaLabel}</button>,
}));

const GRANT = {
  deviceCode: 'DEV-CODE',
  userCode: 'WXYZ-1234',
  verificationUri: 'http://web/auth/device?user_code=WXYZ-1234',
  intervalMs: 5000,
  expiresAt: Date.now() + 600_000,
  cloudBaseUrl: 'http://web',
  relayUrl: 'http://relay',
};

/** A promise with externally-callable settle functions. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.connState.status = 'disconnected';
  h.connState.user = null;
  h.connState.host = null;
  h.cloudSignedIn = false;
  h.loadConnection.mockResolvedValue(null);
  h.ensureSignInResumed.mockResolvedValue(null);
});
afterEach(cleanup);

describe('CloudConnectPanel — resuming an interrupted sign-in', () => {
  it('shows the stored code and joins the in-flight resume instead of a fresh form', async () => {
    const done = deferred<{ workspaceName?: string }>();
    h.ensureSignInResumed.mockResolvedValue({
      grant: GRANT,
      done: done.promise,
      cancel: vi.fn(),
    });

    render(<CloudConnectPanel onClose={vi.fn()} />);

    // The user sees the code they were already given — not "Sign in" again.
    expect(await screen.findByText('WXYZ-1234')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in with DocuShark Cloud' })).toBeNull();

    // No new grant is requested; the existing one is what the user authorized.
    expect(h.beginCloudSignIn).not.toHaveBeenCalled();
  });

  it('does NOT redeem the token itself — the resume service owns that', async () => {
    const done = deferred<{ workspaceName?: string }>();
    h.ensureSignInResumed.mockResolvedValue({
      grant: GRANT,
      done: done.promise,
      cancel: vi.fn(),
    });

    render(<CloudConnectPanel onClose={vi.fn()} successBeatMs={10_000} />);
    await screen.findByText('WXYZ-1234');

    await act(async () => {
      done.resolve({ workspaceName: 'Workspace Alpha' });
    });

    await waitFor(() => expect(screen.getByText('Connected to Workspace Alpha')).toBeTruthy());
    // Boot may already have committed the session; a second call here would
    // redeem the same token twice.
    expect(h.completeCloudSignIn).not.toHaveBeenCalled();
  });

  it('surfaces a terminal resume failure as an error, not a silent reset', async () => {
    const done = deferred<never>();
    h.ensureSignInResumed.mockResolvedValue({
      grant: GRANT,
      done: done.promise,
      cancel: vi.fn(),
    });

    render(<CloudConnectPanel onClose={vi.fn()} />);
    await screen.findByText('WXYZ-1234');

    await act(async () => {
      done.reject(new Error('Device code expired. Please try again.'));
    });

    await waitFor(() =>
      expect(screen.getByText('Device code expired. Please try again.')).toBeTruthy(),
    );
  });
});

describe('CloudConnectPanel — dismissal guard', () => {
  it('stays busy during the success beat, when phase has LEFT the poll window', async () => {
    // The discriminating case. Under the old `onBusyChange(isAwaiting)` rule
    // this window reported NOT busy, so a backdrop click during the "Connected"
    // beat — before the signed-in view paints — dismissed the panel.
    const onBusyChange = vi.fn();
    const result = deferred<{ token: string; expiresAt: number; workspaceName?: string }>();
    h.beginCloudSignIn.mockResolvedValue({
      userCode: 'WXYZ-1234',
      verificationUri: 'http://web/auth/device',
      verificationUriComplete: 'http://web/auth/device?user_code=WXYZ-1234',
      grant: GRANT,
      browserOpenFailed: false,
      result: result.promise,
      cancel: vi.fn(),
    });

    render(
      <CloudConnectPanel onClose={vi.fn()} onBusyChange={onBusyChange} successBeatMs={10_000} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with DocuShark Cloud' }));
    await screen.findByText('WXYZ-1234');

    await act(async () => {
      result.resolve({ token: 'JWT', expiresAt: Date.now() + 60_000, workspaceName: 'Alpha' });
    });

    // phase === 'success' (not 'awaiting'), so this asserts the widened window.
    await waitFor(() => expect(screen.getByText('Connected to Alpha')).toBeTruthy());
    // Let the busy effect flush. Without this the assertion races the passive
    // effect and passes even against the old rule — which is exactly how this
    // test read as green while proving nothing.
    await act(async () => {
      await Promise.resolve();
    });
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
  });

  it('stays busy during the WS connect, with no device-code poll running', async () => {
    // Second discriminating case: `phase` is idle, so only `isConnecting` can
    // hold the guard open. Old rule reported not-busy here too.
    const onBusyChange = vi.fn();
    h.connState.status = 'connecting';

    render(<CloudConnectPanel onClose={vi.fn()} onBusyChange={onBusyChange} />);
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(true));

    h.connState.status = 'authenticating';
    cleanup();
    render(<CloudConnectPanel onClose={vi.fn()} onBusyChange={onBusyChange} />);
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(true));
  });

  it('reports not-busy once signed in, so the panel can be dismissed normally', async () => {
    const onBusyChange = vi.fn();
    h.cloudSignedIn = true;
    h.connState.user = { id: 'u1', username: 'justin', role: 'owner' };

    render(<CloudConnectPanel onClose={vi.fn()} onBusyChange={onBusyChange} />);
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false));
  });
});

describe('CloudConnectPanel — grant lifecycle', () => {
  it('persists the grant before awaiting the token', async () => {
    const result = deferred<never>();
    h.beginCloudSignIn.mockResolvedValue({
      userCode: 'WXYZ-1234',
      verificationUri: 'http://web/auth/device',
      verificationUriComplete: 'http://web/auth/device?user_code=WXYZ-1234',
      grant: GRANT,
      browserOpenFailed: false,
      result: result.promise,
      cancel: vi.fn(),
    });

    render(<CloudConnectPanel onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with DocuShark Cloud' }));

    // Saved while still awaiting — the whole point is surviving a teardown
    // that happens during the wait.
    await waitFor(() =>
      expect(h.savePendingSignIn).toHaveBeenCalledWith(
        expect.objectContaining({ deviceCode: 'DEV-CODE' }),
      ),
    );
  });

  it('clears the grant on explicit Cancel but NOT on unmount', async () => {
    const result = deferred<never>();
    const cancel = vi.fn();
    h.beginCloudSignIn.mockResolvedValue({
      userCode: 'WXYZ-1234',
      verificationUri: 'http://web/auth/device',
      verificationUriComplete: 'http://web/auth/device?user_code=WXYZ-1234',
      grant: GRANT,
      browserOpenFailed: false,
      result: result.promise,
      cancel,
    });

    const { unmount } = render(<CloudConnectPanel onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with DocuShark Cloud' }));
    await screen.findByText('WXYZ-1234');
    h.clearPendingSignIn.mockClear();

    // Unmount is a dismissal or a re-render, NOT abandonment. Clearing here is
    // precisely what used to strand an already-authorized device.
    unmount();
    expect(cancel).toHaveBeenCalled();
    expect(h.clearPendingSignIn).not.toHaveBeenCalled();
  });

  it('clears the grant when the user cancels explicitly', async () => {
    const result = deferred<never>();
    h.beginCloudSignIn.mockResolvedValue({
      userCode: 'WXYZ-1234',
      verificationUri: 'http://web/auth/device',
      verificationUriComplete: 'http://web/auth/device?user_code=WXYZ-1234',
      grant: GRANT,
      browserOpenFailed: false,
      result: result.promise,
      cancel: vi.fn(),
    });

    render(<CloudConnectPanel onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with DocuShark Cloud' }));
    await screen.findByText('WXYZ-1234');
    h.clearPendingSignIn.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(h.clearPendingSignIn).toHaveBeenCalled());
  });
});

describe('CloudConnectPanel — blocked-popup copy', () => {
  it('tells the user to open the link when the browser did not open', async () => {
    const result = deferred<never>();
    h.beginCloudSignIn.mockResolvedValue({
      userCode: 'WXYZ-1234',
      verificationUri: 'http://web/auth/device',
      verificationUriComplete: 'http://web/auth/device?user_code=WXYZ-1234',
      grant: GRANT,
      browserOpenFailed: true,
      result: result.promise,
      cancel: vi.fn(),
    });

    render(<CloudConnectPanel onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with DocuShark Cloud' }));

    // Claiming the browser opened when it didn't leaves the user staring at a
    // code with nowhere to type it.
    expect(await screen.findByText(/Open the verification page below/)).toBeTruthy();
    expect(screen.queryByText(/Your browser should have opened/)).toBeNull();
  });
});
