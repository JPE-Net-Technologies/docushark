/**
 * Access panel (JP-456).
 *
 * The panel's whole claim is that provenance is legible — that you can see
 * *why* someone can open a document. These tests pin that claim, plus the two
 * rules the copy asserts:
 *
 *  - a workspace **owner** holds owner rights on every document (the relay's
 *    `get_user_permission` returns Owner for `wsp[].role == "owner"` before it
 *    looks at shares), so they appear on a document with "via workspace"; and
 *  - plain membership grants **nothing** — those people only appear once
 *    explicitly shared with.
 *
 * If either drifts from `relay/src/server/permissions.rs`, the panel starts
 * lying to users about who can read their documents, which is worth a test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { AccessPanel } from './AccessPanel';

const h = vi.hoisted(() => ({
  members: [] as unknown[],
  getWorkspaceMembers: vi.fn(),
  listInvites: vi.fn(async () => []),
  entries: {} as Record<string, unknown>,
  relayDocuments: {} as Record<string, unknown>,
  currentUser: { id: 'u-owner', username: 'Justin', role: 'owner' } as unknown,
}));

vi.mock('../../api/webClient', () => ({
  webClient: {
    getWorkspaceMembers: h.getWorkspaceMembers,
    listInvites: h.listInvites,
    createInvite: vi.fn(),
    revokeInvite: vi.fn(),
    removeMember: vi.fn(),
  },
}));
vi.mock('../../store/documentRegistry', () => ({
  useDocumentRegistry: Object.assign(
    (sel: (s: unknown) => unknown) => sel({ entries: h.entries, updateRecord: vi.fn() }),
    { getState: () => ({ entries: h.entries, updateRecord: vi.fn() }) },
  ),
}));
vi.mock('../../store/relayDocumentStore', () => ({
  useRelayDocumentStore: (sel: (s: unknown) => unknown) =>
    sel({
      relayDocuments: h.relayDocuments,
      updateDocumentShares: vi.fn(),
      transferDocumentOwnership: vi.fn(),
    }),
}));
vi.mock('../../store/userStore', () => ({
  useUserStore: (sel: (s: unknown) => unknown) => sel({ currentUser: h.currentUser }),
}));
vi.mock('../../store/notificationStore', () => ({
  useNotificationStore: { getState: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }) },
}));
vi.mock('../confirm/confirmStore', () => ({ confirmDialog: vi.fn() }));
vi.mock('../components/RichSelect', () => ({
  RichSelect: ({ ariaLabel }: { ariaLabel?: string }) => <button type="button">{ariaLabel}</button>,
}));

const OWNER = { userId: 'u-owner', displayName: 'Justin', email: 'j@x.co', role: 'owner' };
const MEMBER = { userId: 'u-mem', displayName: 'Priya', email: 'p@x.co', role: 'member' };
const SHAREE = { userId: 'u-share', displayName: 'Tom', email: 't@x.co', role: 'member' };

const DOC_ID = 'doc-1';

function seedDocument(shares: Array<{ userId: string; userName: string; permission: string }>) {
  h.entries = {
    [DOC_ID]: {
      record: {
        type: 'remote',
        id: DOC_ID,
        name: 'Quarterly Plan',
        ownerId: 'u-owner',
        ownerName: 'Justin',
        permission: 'owner',
      },
    },
  };
  h.relayDocuments = { [DOC_ID]: { sharedWith: shares } };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.currentUser = { id: 'u-owner', username: 'Justin', role: 'owner' };
  h.getWorkspaceMembers.mockResolvedValue([OWNER, MEMBER, SHAREE]);
  h.listInvites.mockResolvedValue([]);
  seedDocument([]);
});
afterEach(cleanup);

describe('AccessPanel — the ladder', () => {
  it('renders the inheritance chain top to bottom', async () => {
    render(<AccessPanel scope="document" documentId={DOC_ID} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('Workspace')).toBeTruthy());
    expect(screen.getByText('Collection')).toBeTruthy();
    expect(screen.getByText('This document')).toBeTruthy();
  });

  it('omits the document rung in workspace scope', async () => {
    render(<AccessPanel scope="workspace" documentId={null} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('Workspace')).toBeTruthy());
    expect(screen.queryByText('This document')).toBeNull();
  });

  it('states that membership alone grants no document access', async () => {
    render(<AccessPanel scope="workspace" documentId={null} onClose={vi.fn()} />);

    // The relay grants None for an unshared document; the panel must not imply
    // that adding someone to the workspace shares your work with them.
    await waitFor(() =>
      expect(
        screen.getByText(/Everyone else needs to be added to a document/),
      ).toBeTruthy(),
    );
  });
});

describe('AccessPanel — provenance', () => {
  it('marks a workspace owner as inheriting access, not directly shared', async () => {
    // A second workspace owner who has NO explicit share on the document.
    h.getWorkspaceMembers.mockResolvedValue([
      OWNER,
      { ...MEMBER, role: 'owner' },
      SHAREE,
    ]);
    seedDocument([]);

    render(<AccessPanel scope="document" documentId={DOC_ID} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('via workspace')).toBeTruthy());
    expect(screen.queryByText('shared directly')).toBeNull();
  });

  it('marks an explicit share as direct', async () => {
    seedDocument([{ userId: 'u-share', userName: 'Tom', permission: 'edit' }]);

    render(<AccessPanel scope="document" documentId={DOC_ID} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('shared directly')).toBeTruthy());
  });

  it('does NOT list a plain member who has no share', async () => {
    seedDocument([]);

    render(<AccessPanel scope="document" documentId={DOC_ID} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('This document')).toBeTruthy());

    // Priya is a workspace member with no share — the relay would refuse her,
    // so showing her on the document would be a lie.
    const docRung = document.querySelectorAll('.access-rung')[2];
    expect(docRung?.textContent).not.toContain('Priya');
  });

  it('flags a share held by someone no longer in the workspace', async () => {
    h.getWorkspaceMembers.mockResolvedValue([OWNER, MEMBER]);
    seedDocument([{ userId: 'u-gone', userName: 'Sam', permission: 'view' }]);

    render(<AccessPanel scope="document" documentId={DOC_ID} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('Former member')).toBeTruthy());
  });
});

describe('AccessPanel — permission gating', () => {
  it('hides share editing from a non-owner of the document', async () => {
    h.entries = {
      [DOC_ID]: {
        record: {
          type: 'remote',
          id: DOC_ID,
          name: 'Quarterly Plan',
          ownerId: 'u-other',
          ownerName: 'Someone',
          permission: 'editor',
        },
      },
    };
    h.relayDocuments = { [DOC_ID]: { sharedWith: [] } };

    render(<AccessPanel scope="document" documentId={DOC_ID} onClose={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByText(/Only the document’s owner can change who has access/)).toBeTruthy(),
    );
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
  });

  it('explains that a local document cannot be shared', async () => {
    h.entries = {
      [DOC_ID]: { record: { type: 'local', id: DOC_ID, name: 'Scratch' } },
    };

    render(<AccessPanel scope="document" documentId={DOC_ID} onClose={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByText(/This document is on this device only/)).toBeTruthy(),
    );
  });
});
