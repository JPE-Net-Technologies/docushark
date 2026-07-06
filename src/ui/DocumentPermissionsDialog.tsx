/**
 * DocumentPermissionsDialog component
 *
 * Modal dialog for managing document ownership and access permissions.
 * Only document owners can access this dialog.
 *
 * JP-370: shares are now chosen from a workspace **member picker** fed by the
 * Cloud roster (`webClient.getWorkspaceMembers`) — restoring the picker dropped
 * in Phase 20.3 E.5 (which forced users to hand-type a relay user ID). You can
 * only share with people already in the workspace; invite them first (the
 * workspace members panel) to make them appear here.
 */

import { useState, useCallback, useEffect, useMemo, FormEvent } from 'react';
import { ChevronDown, Crown } from 'lucide-react';
import { useUserStore } from '../store/userStore';
import { useRelayDocumentStore } from '../store/relayDocumentStore';
import { useDocumentRegistry } from '../store/documentRegistry';
import { webClient, type WorkspaceMember } from '../api/webClient';
import { confirmDialog } from './confirm/confirmStore';
import { RichSelect, type RichSelectItem } from './components/RichSelect';
import { InitialsAvatar } from './components/InitialsAvatar';
import type { Permission, RemoteDocument } from '../types/DocumentRegistry';
import type { DocumentShare } from '../types/Document';
import './DocumentPermissionsDialog.css';

/** Per-share permission choices (row selects). */
const PERMISSION_ITEMS: RichSelectItem<'none' | 'view' | 'edit'>[] = [
  { value: 'none', label: 'No access' },
  { value: 'view', label: 'Can view' },
  { value: 'edit', label: 'Can edit' },
];

/** Choices when adding a member (no "none" — adding with no access is a no-op). */
const ADD_PERMISSION_ITEMS: RichSelectItem<'view' | 'edit'>[] = [
  { value: 'view', label: 'Can view' },
  { value: 'edit', label: 'Can edit' },
];

interface DocumentPermissionsDialogProps {
  /** Document ID to manage */
  documentId: string;
  /** Close callback */
  onClose: () => void;
}

interface MemberAccess {
  userId: string;
  username: string;
  permission: 'view' | 'edit' | 'none';
}

export function DocumentPermissionsDialog({ documentId, onClose }: DocumentPermissionsDialogProps) {
  const entries = useDocumentRegistry((s) => s.entries);
  const updateRecord = useDocumentRegistry((s) => s.updateRecord);
  const currentUser = useUserStore((s) => s.currentUser);
  const updateDocumentShares = useRelayDocumentStore((s) => s.updateDocumentShares);
  const transferDocumentOwnership = useRelayDocumentStore((s) => s.transferDocumentOwnership);
  const relayDocuments = useRelayDocumentStore((s) => s.relayDocuments);

  const [accessList, setAccessList] = useState<MemberAccess[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);

  // Member-picker state (JP-370): the workspace roster + the currently-selected
  // member to add. Replaces the old hand-typed user-id form.
  const [roster, setRoster] = useState<WorkspaceMember[]>([]);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [newMemberId, setNewMemberId] = useState('');
  const [newPermission, setNewPermission] = useState<'view' | 'edit'>('view');

  const entry = entries[documentId];
  const record = entry?.record as RemoteDocument | undefined;

  const docMetadata = relayDocuments[documentId];

  // Build access list from existing shares only. With no local member
  // roster, the only knowable users are those already shared with.
  useEffect(() => {
    if (!record || record.type !== 'remote') return;

    const existingShares: DocumentShare[] = docMetadata?.sharedWith ?? [];
    const list: MemberAccess[] = existingShares
      .filter(
        (share) => share.userId !== currentUser?.id && share.userId !== record.ownerId,
      )
      .map((share) => ({
        userId: share.userId,
        username: share.userName,
        permission: share.permission,
      }));

    setAccessList(list);
    setHasChanges(false);
  }, [currentUser?.id, record, docMetadata]);

  // JP-370: load the workspace roster so shares are picked from real members
  // (not hand-typed ids). Best-effort: a failure (self-host, offline, web
  // unreachable) leaves the picker empty with an inline note rather than
  // breaking the dialog.
  useEffect(() => {
    if (!record || record.type !== 'remote') return;
    let cancelled = false;
    webClient
      .getWorkspaceMembers()
      .then((members) => {
        if (!cancelled) {
          setRoster(members);
          setRosterError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setRoster([]);
          setRosterError(err instanceof Error ? err.message : 'Could not load workspace members');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [record]);

  // Sharees no longer in the workspace (e.g. they left or were removed): their
  // share lingers on the doc but they're not in the roster. Flag them so the
  // owner understands the orphaned grant and can revoke it. Only meaningful when
  // the roster actually loaded (otherwise everyone would look "former").
  const rosterIds = useMemo(() => new Set(roster.map((m) => m.userId)), [roster]);
  const isFormerMember = useCallback(
    (userId: string) => roster.length > 0 && !rosterError && !rosterIds.has(userId),
    [rosterIds, roster.length, rosterError],
  );

  // Members who can still be added: everyone in the workspace except the owner,
  // the current user, and anyone already in the access list.
  const availableMembers = useMemo(() => {
    const taken = new Set(accessList.map((m) => m.userId));
    return roster.filter(
      (m) =>
        m.userId !== record?.ownerId &&
        m.userId !== currentUser?.id &&
        !taken.has(m.userId),
    );
  }, [roster, accessList, record?.ownerId, currentUser?.id]);

  const accessCounts = useMemo(() => {
    const editors = accessList.filter((m) => m.permission === 'edit').length;
    const viewers = accessList.filter((m) => m.permission === 'view').length;
    return { editors, viewers, total: editors + viewers };
  }, [accessList]);

  const handlePermissionChange = useCallback(
    (userId: string, permission: 'view' | 'edit' | 'none') => {
      setAccessList((prev) => prev.map((m) => (m.userId === userId ? { ...m, permission } : m)));
      setHasChanges(true);
      setError(null);
      setSuccessMessage(null);
    },
    [],
  );

  const handleRevokeAll = useCallback(async () => {
    const ok = await confirmDialog({
      title: 'Revoke all access?',
      message: 'Everyone in the list is set to "No access".',
      details: 'Nothing changes on the server until you click Save Changes.',
      confirmLabel: 'Revoke all',
      danger: true,
    });
    if (!ok) return;
    setAccessList((prev) => prev.map((m) => ({ ...m, permission: 'none' })));
    setHasChanges(true);
  }, []);

  const handleAddUser = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const member = roster.find((m) => m.userId === newMemberId);
      if (!member) return;
      if (accessList.some((m) => m.userId === member.userId)) return;
      setAccessList((prev) => [
        ...prev,
        { userId: member.userId, username: member.displayName, permission: newPermission },
      ]);
      setHasChanges(true);
      setError(null);
      setSuccessMessage(null);
      setNewMemberId('');
      setNewPermission('view');
    },
    [newMemberId, newPermission, accessList, roster],
  );

  // Transfer runs through the shared danger confirm (JP-420) instead of an
  // inline takeover block that hid the whole form.
  const handleTransferOwnership = useCallback(
    async (userId: string) => {
      const newOwner = accessList.find((m) => m.userId === userId);
      if (!newOwner || !record) return;

      const ok = await confirmDialog({
        title: `Transfer ownership to ${newOwner.username}?`,
        message: 'They become this document’s owner immediately.',
        details: 'You will lose owner privileges and become an editor. This cannot be undone.',
        confirmLabel: 'Transfer ownership',
        danger: true,
      });
      if (!ok) return;

      setIsSaving(true);
      setError(null);
      try {
        await transferDocumentOwnership(documentId, newOwner.userId, newOwner.username);
        updateRecord(documentId, {
          permission: 'editor' as Permission,
          ownerName: newOwner.username,
          ownerId: newOwner.userId,
        });
        setSuccessMessage(`Ownership transferred to ${newOwner.username}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to transfer ownership');
      } finally {
        setIsSaving(false);
      }
    },
    [record, accessList, documentId, transferDocumentOwnership, updateRecord],
  );

  const handleSave = useCallback(async () => {
    if (!record) return;

    setIsSaving(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const shares = accessList
        .filter((m) => m.permission !== 'none')
        .map((m) => ({
          userId: m.userId,
          userName: m.username,
          permission: m.permission,
        }));

      await updateDocumentShares(documentId, shares);
      setSuccessMessage(
        `Permissions saved (${shares.length} user${shares.length !== 1 ? 's' : ''} with access)`,
      );
      setHasChanges(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save permissions');
    } finally {
      setIsSaving(false);
    }
  }, [record, accessList, documentId, updateDocumentShares]);

  if (!record || record.type !== 'remote') {
    return (
      <div className="document-permissions-dialog__overlay" onClick={onClose}>
        <div className="document-permissions-dialog" onClick={(e) => e.stopPropagation()}>
          <div className="document-permissions-dialog__header">
            <h3>Manage Access</h3>
            <button className="document-permissions-dialog__close" onClick={onClose}>×</button>
          </div>
          <div className="document-permissions-dialog__content">
            <p className="document-permissions-dialog__empty">Document not found or not a relay document.</p>
            <div className="document-permissions-dialog__actions">
              <button className="document-permissions-dialog__btn" onClick={onClose}>Close</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="document-permissions-dialog__overlay" onClick={onClose}>
      <div className="document-permissions-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="document-permissions-dialog__header">
          <h3>Manage Access</h3>
          <button className="document-permissions-dialog__close" onClick={onClose}>×</button>
        </div>

        <div className="document-permissions-dialog__content">
          <div className="document-permissions-dialog__doc-info">
            <div className="document-permissions-dialog__doc-name">{record.name}</div>
            <div className="document-permissions-dialog__doc-meta">
              <span className="document-permissions-dialog__owner-badge">
                <Crown size={13} strokeWidth={1.75} /> {record.ownerName}
              </span>
              <span className="document-permissions-dialog__access-count">
                {accessCounts.total} user{accessCounts.total !== 1 ? 's' : ''} with access
                {accessCounts.editors > 0 && ` (${accessCounts.editors} editor${accessCounts.editors !== 1 ? 's' : ''})`}
              </span>
            </div>
          </div>

          {error && <div className="document-permissions-dialog__error">{error}</div>}
          {successMessage && <div className="document-permissions-dialog__success">{successMessage}</div>}

          <>
              <div className="document-permissions-dialog__section">
                <h4>Add a workspace member</h4>
                <form
                  className="document-permissions-dialog__add-form"
                  onSubmit={handleAddUser}
                >
                  {availableMembers.length === 0 ? (
                    <span className="document-permissions-dialog__picker-empty">
                      No members to add
                    </span>
                  ) : (
                    <RichSelect
                      value={newMemberId}
                      onChange={setNewMemberId}
                      ariaLabel="Member to add"
                      className="document-permissions-dialog__member-picker"
                      items={availableMembers.map((m) => ({
                        value: m.userId,
                        label: m.displayName,
                        keywords: `${m.displayName} ${m.email ?? ''}`,
                        render: () => (
                          <span className="document-permissions-dialog__member-option">
                            <InitialsAvatar name={m.displayName} size={22} />
                            <span className="document-permissions-dialog__member-option-id">
                              <strong>{m.displayName}</strong>
                              {m.email ? <small>{m.email}</small> : null}
                            </span>
                          </span>
                        ),
                      }))}
                      trigger={
                        newMemberId === '' ? (
                          <>
                            <span className="document-permissions-dialog__picker-placeholder">
                              Select a member…
                            </span>
                            <ChevronDown size={12} aria-hidden="true" />
                          </>
                        ) : undefined
                      }
                    />
                  )}
                  <RichSelect
                    value={newPermission}
                    onChange={setNewPermission}
                    items={ADD_PERMISSION_ITEMS}
                    ariaLabel="Permission for the new member"
                    minWidth={104}
                  />
                  <button
                    type="submit"
                    className="document-permissions-dialog__btn"
                    disabled={isSaving || !newMemberId}
                  >
                    Add
                  </button>
                </form>
                {rosterError ? (
                  <p className="document-permissions-dialog__hint">
                    Couldn&apos;t load workspace members ({rosterError}). You can still adjust
                    existing shares below.
                  </p>
                ) : (
                  <p className="document-permissions-dialog__hint">
                    Only people in this workspace appear here. To add someone new, invite them to
                    the workspace first.
                  </p>
                )}
              </div>

              <div className="document-permissions-dialog__section">
                <div className="document-permissions-dialog__section-head">
                  <h4>Current Shares</h4>
                  <button
                    className="document-permissions-dialog__quick-btn document-permissions-dialog__quick-btn--danger"
                    onClick={() => void handleRevokeAll()}
                    disabled={accessList.length === 0}
                    title="Set everyone to No access"
                  >
                    Revoke all
                  </button>
                </div>
                {accessList.length === 0 ? (
                  <p className="document-permissions-dialog__empty">No users have access yet.</p>
                ) : (
                  <ul className="document-permissions-dialog__members">
                    {accessList.map((member) => (
                      <li
                        key={member.userId}
                        className={`document-permissions-dialog__member ${member.permission !== 'none' ? 'document-permissions-dialog__member--has-access' : ''}`}
                      >
                        <InitialsAvatar name={member.username} />
                        <div className="document-permissions-dialog__member-info">
                          <span className="document-permissions-dialog__member-name" title={member.userId}>
                            {member.username}
                            {isFormerMember(member.userId) && (
                              <span className="document-permissions-dialog__former-badge" title="No longer in this workspace — you can revoke their access">
                                former member
                              </span>
                            )}
                          </span>
                        </div>
                        <div className="document-permissions-dialog__member-controls">
                          <RichSelect
                            value={member.permission}
                            onChange={(v) => handlePermissionChange(member.userId, v)}
                            items={PERMISSION_ITEMS}
                            ariaLabel={`Permission for ${member.username}`}
                            align="end"
                            minWidth={104}
                          />
                          {member.permission !== 'none' && (
                            <button
                              className="document-permissions-dialog__transfer-btn"
                              onClick={() => void handleTransferOwnership(member.userId)}
                              title="Transfer ownership to this user"
                              aria-label="Transfer ownership to this user"
                            >
                              <Crown size={15} strokeWidth={1.75} />
                            </button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="document-permissions-dialog__actions">
                <button
                  className="document-permissions-dialog__btn document-permissions-dialog__btn--primary"
                  onClick={handleSave}
                  disabled={isSaving || !hasChanges}
                >
                  {isSaving ? 'Saving...' : hasChanges ? 'Save Changes' : 'No Changes'}
                </button>
                <button
                  className="document-permissions-dialog__btn"
                  onClick={onClose}
                  disabled={isSaving}
                >
                  {hasChanges ? 'Cancel' : 'Close'}
                </button>
              </div>
            </>
        </div>
      </div>
    </div>
  );
}

export default DocumentPermissionsDialog;
