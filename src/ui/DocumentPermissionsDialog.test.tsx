// DocumentPermissionsDialog (JP-370 sharing, JP-420 re-skin) — baseline
// behavior coverage: roster-fed member picker, staged permission edits, the
// confirm-gated transfer/revoke-all flows, and save payload shape. RichSelect
// is stubbed with a native select so tests assert the onChange wiring rather
// than Radix internals.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  updateRecord: vi.fn(),
  updateDocumentShares: vi.fn().mockResolvedValue(undefined),
  transferDocumentOwnership: vi.fn().mockResolvedValue(undefined),
  getWorkspaceMembers: vi.fn(),
  confirmDialog: vi.fn(),
  registryState: {
    entries: {} as Record<string, { record: unknown }>,
    updateRecord: undefined as unknown,
  },
  relayState: {
    relayDocuments: {} as Record<string, { sharedWith?: unknown[] }>,
    updateDocumentShares: undefined as unknown,
    transferDocumentOwnership: undefined as unknown,
  },
  userState: { currentUser: { id: 'me', username: 'Me' } },
}));

vi.mock('../store/documentRegistry', () => ({
  useDocumentRegistry: (sel: (s: unknown) => unknown) => sel(mocks.registryState),
}));
vi.mock('../store/relayDocumentStore', () => ({
  useRelayDocumentStore: (sel: (s: unknown) => unknown) => sel(mocks.relayState),
}));
vi.mock('../store/userStore', () => ({
  useUserStore: (sel: (s: unknown) => unknown) => sel(mocks.userState),
}));
vi.mock('../api/webClient', () => ({
  webClient: { getWorkspaceMembers: mocks.getWorkspaceMembers },
}));
vi.mock('./confirm/confirmStore', () => ({
  confirmDialog: mocks.confirmDialog,
}));
// Native-select stub: same value/onChange/items contract, jsdom-friendly.
vi.mock('./components/RichSelect', () => ({
  RichSelect: (props: {
    value: string;
    onChange: (v: string) => void;
    items: { value: string; label: string }[];
    ariaLabel?: string;
  }) => (
    <select
      aria-label={props.ariaLabel}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
    >
      {props.items.map((i) => (
        <option key={i.value} value={i.value}>
          {i.label}
        </option>
      ))}
    </select>
  ),
}));

import { DocumentPermissionsDialog } from './DocumentPermissionsDialog';

const DOC_ID = 'doc-1';

function seed({ shares = [{ userId: 'u2', userName: 'Bea Ray', permission: 'view' }] } = {}) {
  mocks.registryState.entries = {
    [DOC_ID]: {
      record: { type: 'remote', name: 'Spec', ownerId: 'owner-1', ownerName: 'Owner' },
    },
  };
  mocks.registryState.updateRecord = mocks.updateRecord;
  mocks.relayState.relayDocuments = { [DOC_ID]: { sharedWith: shares } };
  mocks.relayState.updateDocumentShares = mocks.updateDocumentShares;
  mocks.relayState.transferDocumentOwnership = mocks.transferDocumentOwnership;
  mocks.getWorkspaceMembers.mockResolvedValue([
    { userId: 'u2', displayName: 'Bea Ray', email: 'bea@x.io', role: 'member' },
    { userId: 'u3', displayName: 'Cal Poe', email: 'cal@x.io', role: 'member' },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
});
afterEach(cleanup);

async function renderDialog() {
  const onClose = vi.fn();
  render(<DocumentPermissionsDialog documentId={DOC_ID} onClose={onClose} />);
  // Roster load settles (member picker populated).
  await waitFor(() => expect(mocks.getWorkspaceMembers).toHaveBeenCalled());
  return { onClose };
}

describe('DocumentPermissionsDialog', () => {
  it('lists existing shares with their permission', async () => {
    await renderDialog();
    expect(screen.getByText('Bea Ray')).toBeTruthy();
    const rowSelect = screen.getByLabelText('Permission for Bea Ray') as HTMLSelectElement;
    expect(rowSelect.value).toBe('view');
  });

  it('adds a roster member and saves the combined share list', async () => {
    await renderDialog();
    // Only u3 is addable (u2 already shared, owner + self excluded).
    const memberPicker = (await screen.findByLabelText('Member to add')) as HTMLSelectElement;
    fireEvent.change(memberPicker, { target: { value: 'u3' } });
    fireEvent.click(screen.getByText('Add'));

    expect(screen.getByText('Cal Poe')).toBeTruthy();

    fireEvent.click(screen.getByText('Save Changes'));
    await waitFor(() => expect(mocks.updateDocumentShares).toHaveBeenCalledTimes(1));
    expect(mocks.updateDocumentShares).toHaveBeenCalledWith(DOC_ID, [
      { userId: 'u2', userName: 'Bea Ray', permission: 'view' },
      { userId: 'u3', userName: 'Cal Poe', permission: 'view' },
    ]);
  });

  it('a share set to "none" is dropped from the save payload', async () => {
    await renderDialog();
    fireEvent.change(screen.getByLabelText('Permission for Bea Ray'), {
      target: { value: 'none' },
    });
    fireEvent.click(screen.getByText('Save Changes'));
    await waitFor(() => expect(mocks.updateDocumentShares).toHaveBeenCalledWith(DOC_ID, []));
  });

  it('transfer runs only after the danger confirm resolves true', async () => {
    mocks.confirmDialog.mockResolvedValue(true);
    await renderDialog();

    fireEvent.click(screen.getByLabelText('Transfer ownership to this user'));

    await waitFor(() =>
      expect(mocks.transferDocumentOwnership).toHaveBeenCalledWith(DOC_ID, 'u2', 'Bea Ray'),
    );
    expect(mocks.confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({ danger: true, confirmLabel: 'Transfer ownership' }),
    );
    expect(mocks.updateRecord).toHaveBeenCalledWith(
      DOC_ID,
      expect.objectContaining({ ownerId: 'u2', permission: 'editor' }),
    );
  });

  it('a declined transfer confirm changes nothing', async () => {
    mocks.confirmDialog.mockResolvedValue(false);
    await renderDialog();

    fireEvent.click(screen.getByLabelText('Transfer ownership to this user'));

    await waitFor(() => expect(mocks.confirmDialog).toHaveBeenCalled());
    expect(mocks.transferDocumentOwnership).not.toHaveBeenCalled();
    expect(mocks.updateRecord).not.toHaveBeenCalled();
  });

  it('Revoke all is confirm-gated and stages every share to none', async () => {
    mocks.confirmDialog.mockResolvedValue(true);
    await renderDialog();

    fireEvent.click(screen.getByText('Revoke all'));

    await waitFor(() => {
      const rowSelect = screen.getByLabelText('Permission for Bea Ray') as HTMLSelectElement;
      expect(rowSelect.value).toBe('none');
    });
    // Staged only — nothing hits the server until Save.
    expect(mocks.updateDocumentShares).not.toHaveBeenCalled();
  });

  it('flags a sharee who is no longer in the workspace roster', async () => {
    seed({ shares: [{ userId: 'gone-1', userName: 'Gone Girl', permission: 'edit' }] });
    await renderDialog();
    expect(await screen.findByText('former member')).toBeTruthy();
  });
});
